# -*- coding: utf-8 -*-
"""微信群机器人核心逻辑：消息路由 + 各功能 handler。

与 wcferry 解耦：bot.py 把真实 WxMsg 转成内部 Msg、把 Outgoing 执行发送；
本模块只做纯逻辑（HTTP、模型调用都可注入假实现），方便离线自测。

路由顺序（命中即停）：
  认主绑定（仅私聊）→ 主人指令（状态/闭嘴/开口/加词）→ 静默群拦截 →
  点歌 → 天气 → 抽签 → 发言统计 → 关键词 → AI 问答（兜底，群里需 @ 机器人）
安全阀：不回自己、不回公众号、群白名单、同一人限流，所有异常只记日志不崩。
发言统计：每条群消息在路由前先计数（stats.py，SQLite），统计口径见 stats.py 说明。
主人识别只认 wxid（昵称可改、可重名，不作数）：config 的 owner_wxid 或
认主落盘的 owner.json（state_dir 下）里的 owner_wxid。
认主：未绑定时任何人私聊发「认主 + config 的 bind_code 暗号」即把其 wxid 写进
owner.json 并生效，绑定后认主通道关闭、再发一律拒绝。
主人指令：状态（运行情况＋今日回复数）、闭嘴/开口（按群静默开关，落盘
muted_groups.json；静默群里除主人指令外不回任何消息）、加词（落盘
custom_keywords.json，启动合并加载，与 config 词表一起匹配、后加的优先）、
禁点歌/解禁点歌（点歌黑名单：运行时名单落盘 blacklist.json 的 song 数组，
与 config 的 blacklist_song 静态名单合并生效；点歌处理器先查黑名单，
命中不搜歌，回复文案/静默开关在 config 的 blacklist_song_reply /
blacklist_song_silent）。
"""
import datetime
import json
import logging
import os
import random
import time
import urllib.parse
from dataclasses import dataclass, field

from stats import StatsStore

log = logging.getLogger("wechat-bot")


# ---------------------------------------------------------------- 消息模型
@dataclass
class Msg:
    sender: str                     # 发送者 wxid
    roomid: str = ""                # 群 id（xxx@chatroom），私聊为空
    content: str = ""               # 文本内容（群 @ 提及应已由 bot.py 剥掉）
    is_group: bool = False
    at_bot: bool = False            # 群里是否 @ 了机器人
    is_self: bool = False           # 是否机器人自己发的
    type: int = 1                   # 微信消息类型，1 = 文本
    nickname: str = ""              # 发言人当时的群昵称/备注（统计展示用，取不到为空）
    at_list: list = field(default_factory=list)  # 本条消息 @ 到的 wxid 列表（传输层从 MsgSource 等解析，取不到为空）


@dataclass
class Outgoing:
    receiver: str                               # roomid 或 wxid
    kind: str = "text"                          # text | rich（链接卡片）| silent（已处理但不发送，_route 内部哨兵）
    text: str = ""                              # 文本内容；rich 时作发送失败的兜底文本
    rich: dict = field(default_factory=dict)    # name/account/title/digest/url/thumburl
    aters: str = ""                             # 群里回复时要 @ 的 wxid，可空


# ---------------------------------------------------------------- HTTP
class RequestsHTTP:
    """默认 HTTP 实现（requests 库）。测试时替换为假实现即可。"""

    def get(self, url, headers=None, timeout=10):
        import requests
        return requests.get(url, headers=headers or {}, timeout=timeout)

    def post(self, url, json=None, headers=None, timeout=30):
        import requests
        return requests.post(url, json=json, headers=headers or {}, timeout=timeout)


# ---------------------------------------------------------------- 机器人核心
class BotCore:
    def __init__(self, config, http=None, time_func=time.time, rng=None, state_dir=None):
        self.cfg = config or {}
        self.http = http or RequestsHTTP()
        self.now = time_func
        self.rng = rng or random.Random()
        self._last_reply = {}  # sender wxid -> 上次回复时间戳
        self._started_at = self.now()
        self._reply_days = {}  # 日期 -> 今日已回复条数（内存计数，重启清零；「状态」指令用）

        bot_cfg = self.cfg.get("bot") or {}
        self.rate_limit = float(bot_cfg.get("rate_limit_seconds", 10))
        self.max_chars = int(bot_cfg.get("max_reply_chars", 500))

        # 运行时状态目录（统计库、主人绑定、静默群、自定义词表都放这儿），默认与本文件同目录
        self.state_dir = state_dir or os.path.dirname(os.path.abspath(__file__))
        self.stats = StatsStore(os.path.join(self.state_dir, "stats.db"))
        self._owner_wxid = self._load_owner_wxid()
        self._muted_groups = self._load_muted_groups()
        self._custom_keywords = self._load_custom_keywords()
        self._blacklist = self._load_blacklist()

    # ------------------------------------------------------------ 主人识别（只认 wxid）
    def _load_owner_wxid(self):
        """主人 wxid 来源：认主落盘的 owner.json 优先，其次 config 的 owner_wxid。

        认 wxid 不认昵称：昵称可以改、可以重名，wxid 是账号唯一标识。
        """
        try:
            path = os.path.join(self.state_dir, "owner.json")
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    state = json.load(f)
                if state.get("bound") and state.get("owner_wxid"):
                    return state["owner_wxid"]
        except Exception:
            log.exception("读取 owner.json 失败，改用 config 的 owner_wxid")
        return (self.cfg.get("owner_wxid") or "").strip()

    def _is_owner(self, wxid):
        return bool(self._owner_wxid) and wxid == self._owner_wxid

    # ------------------------------------------------------------ 状态文件（静默群 / 自定义词表）
    def _load_muted_groups(self):
        try:
            path = os.path.join(self.state_dir, "muted_groups.json")
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                rooms = data.get("rooms") if isinstance(data, dict) else data
                return set(rooms or [])
        except Exception:
            log.exception("读取 muted_groups.json 失败，按无静默群处理")
        return set()

    def _save_muted_groups(self):
        try:
            path = os.path.join(self.state_dir, "muted_groups.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"rooms": sorted(self._muted_groups)}, f, ensure_ascii=False)
        except Exception:
            log.exception("保存 muted_groups.json 失败")

    def _load_custom_keywords(self):
        try:
            path = os.path.join(self.state_dir, "custom_keywords.json")
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    return {str(k): str(v) for k, v in data.items()}
        except Exception:
            log.exception("读取 custom_keywords.json 失败，按无自定义词处理")
        return {}

    def _save_custom_keywords(self):
        try:
            path = os.path.join(self.state_dir, "custom_keywords.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self._custom_keywords, f, ensure_ascii=False, indent=1)
        except Exception:
            log.exception("保存 custom_keywords.json 失败")

    # ------------------------------------------------------------ 黑名单（按功能分，落盘 blacklist.json）
    def _load_blacklist(self):
        data = {}
        try:
            path = os.path.join(self.state_dir, "blacklist.json")
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    data = json.load(f) or {}
        except Exception:
            log.exception("读取 blacklist.json 失败，按空名单处理")
        return {"song": set(data.get("song") or [])}

    def _save_blacklist(self):
        try:
            path = os.path.join(self.state_dir, "blacklist.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"song": sorted(self._blacklist.get("song") or [])},
                          f, ensure_ascii=False)
        except Exception:
            log.exception("保存 blacklist.json 失败")

    def _song_blacklisted(self, wxid):
        """点歌黑名单是否命中：config 静态名单（blacklist_song）∪ 运行时名单（主人指令维护）。"""
        if wxid in (self.cfg.get("blacklist_song") or []):
            return True
        return wxid in (self._blacklist.get("song") or set())

    # ------------------------------------------------------------ 认主绑定（仅私聊，一次性暗号）
    def _cmd_bind(self, msg: Msg, content: str):
        if msg.is_group or not content.startswith("认主"):
            return None
        receiver = msg.sender
        if self._owner_wxid:
            return Outgoing(receiver, text="已经有主人啦，认主通道已关闭。")
        expected = (self.cfg.get("bind_code") or "").strip()
        if not expected:
            return Outgoing(receiver, text="认主暗号还没设置，请先在 config.yaml 里填 bind_code 再重启机器人。")
        code = content[len("认主"):].strip()
        if not code or code != expected:
            return Outgoing(receiver, text="暗号不对，认主失败。")
        state = {"bound": True, "owner_wxid": msg.sender,
                 "bound_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.now()))}
        try:
            path = os.path.join(self.state_dir, "owner.json")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False)
            os.replace(tmp, path)
        except Exception:
            log.exception("写 owner.json 失败")
            return Outgoing(receiver, text="认主出了点问题（绑定没存上），稍后再试一次。")
        self._owner_wxid = msg.sender  # 即刻生效；绑定后暗号作废（_owner_wxid 非空即拒绝再认主）
        log.info("主人认领成功：%s", msg.sender)
        return Outgoing(receiver, text=(
            "认主成功！从现在起你就是我的主人啦。\n"
            "主人专属指令：发「状态」看运行情况；群里发「闭嘴」/「开口」让我在那个群闭嘴/说话；"
            "发「加词 关键词=回复内容」给我加关键词；群里发「导出统计」/「重置统计」管发言统计。"))

    # ------------------------------------------------------------ 主人专属指令（状态/闭嘴/开口/加词）
    def _cmd_owner(self, msg: Msg, content: str):
        is_add = content.startswith("加词")
        is_ban = content.startswith("禁点歌") or content.startswith("解禁点歌")
        if content not in ("状态", "闭嘴", "开口") and not is_add and not is_ban:
            return None
        receiver = self._receiver(msg)
        if not self._is_owner(msg.sender):
            return Outgoing(receiver, text="这个只能主人用哦～")
        if is_ban:
            return self._cmd_song_ban(msg, content, receiver)

        if content == "状态":
            up_min = max(0, int((self.now() - self._started_at) // 60))
            lines = ["🤖 运行状态",
                     "状态：运行中",
                     f"已运行：{up_min // 60} 小时 {up_min % 60} 分钟",
                     f"今日已回复：{self._reply_days.get(self._today(), 0)} 条",
                     f"已静默群：{len(self._muted_groups)} 个",
                     f"自定义关键词：{len(self._custom_keywords)} 个"]
            if msg.is_group and msg.roomid in self._muted_groups:
                lines.append("本群：静默中（发「开口」恢复）")
            return Outgoing(receiver, text="\n".join(lines))

        if content in ("闭嘴", "开口"):
            if not msg.is_group:
                return Outgoing(receiver, text="「闭嘴 / 开口」是按群的开关，到群里发哦～")
            if content == "闭嘴":
                if msg.roomid not in self._muted_groups:
                    self._muted_groups.add(msg.roomid)
                    self._save_muted_groups()
                return Outgoing(receiver, text="好，我在这个群闭嘴了。主人发「开口」我再说话。")
            if msg.roomid in self._muted_groups:
                self._muted_groups.discard(msg.roomid)
                self._save_muted_groups()
            return Outgoing(receiver, text="我回来啦～发「点歌 歌名」点歌，@我可以问问题。")

        # ---- 加词 关键词=回复内容
        body = content[len("加词"):].strip()
        sep = "=" if "=" in body else ("＝" if "＝" in body else "")
        kw, _, val = body.partition(sep) if sep else ("", "", "")
        kw, val = kw.strip(), val.strip()
        if not kw or not val:
            return Outgoing(receiver, text="格式：加词 关键词=回复内容，比如：加词 晚安=晚安，好梦～")
        self._custom_keywords[kw] = val
        self._save_custom_keywords()
        log.info("主人加词：%s -> %s", kw, val)
        return Outgoing(receiver, text=f"加好了：以后消息里有「{kw}」，我就回「{val}」")

    def _cmd_song_ban(self, msg: Msg, content: str, receiver: str):
        """禁点歌 / 解禁点歌（仅主人）：群里 @ 某人（wxid 从消息的 at_list 取），
        或在指令后带 wxid 参数（私聊、群里都行）。名单落盘 blacklist.json 的 song 数组，
        与 config 的 blacklist_song 静态名单合并生效；解禁只能移除运行时名单。"""
        unban = content.startswith("解禁点歌")
        cmd = "解禁点歌" if unban else "禁点歌"
        targets = [w for w in (msg.at_list or []) if w and w != msg.sender]
        for tok in content[len(cmd):].split():  # @昵称 片段以 @ 开头，跳过；其余 ASCII 词按 wxid 收
            if tok.startswith("@") or not tok.isascii():
                continue
            if tok not in targets:
                targets.append(tok)
        if not targets:
            return Outgoing(receiver, text=(f"把要{'解禁' if unban else '禁'}的人 @ 出来再发「{cmd}」，"
                                            f"或发「{cmd} 对方wxid」"))
        runtime = self._blacklist.setdefault("song", set())
        shown = "、".join("…" + t[-4:] for t in targets)
        if not unban:
            runtime.update(targets)
            self._save_blacklist()
            log.info("主人禁点歌：%s", targets)
            return Outgoing(receiver, text=f"已禁：{shown} 以后点不了歌啦")
        runtime.difference_update(targets)
        self._save_blacklist()
        log.info("主人解禁点歌：%s", targets)
        text = f"已解禁：{shown} 可以点歌了"
        if any(t in (self.cfg.get("blacklist_song") or []) for t in targets):
            text += "（注意：名单里有人还在 config.yaml 的 blacklist_song 静态名单中，得改配置重启才彻底解禁）"
        return Outgoing(receiver, text=text)

    # ------------------------------------------------------------ 对外入口
    def handle(self, msg: Msg):
        """处理一条消息，返回 Outgoing 列表（空 = 不回）。永不抛异常。"""
        self._note_message(msg)
        try:
            outs = self._route(msg)
        except Exception:
            log.exception("处理消息失败，已忽略: sender=%s room=%s",
                          getattr(msg, "sender", "?"), getattr(msg, "roomid", "?"))
            return []
        if outs:  # 今日回复数（「状态」指令展示，内存计数）
            day = self._today()
            self._reply_days[day] = self._reply_days.get(day, 0) + len(outs)
        return outs

    def _note_message(self, msg: Msg):
        """群发言计数：任何类型的群消息都记 1 条（机器人自己和公众号不记）。

        在路由之前计数，所以不回的消息也算发言；计数失败只记日志，不影响回消息。
        """
        try:
            if (msg.is_group and msg.roomid and not msg.is_self
                    and not self._is_official(msg.sender)):
                self.stats.record(msg.roomid, msg.sender, self._today(),
                                  msg.type, msg.nickname or "")
        except Exception:
            log.exception("发言计数失败，已忽略")

    # ------------------------------------------------------------ 日期工具
    def _today(self):
        return time.strftime("%Y-%m-%d", time.localtime(self.now()))

    def _day_offset(self, days):
        """今天往前推 days 天的日期字符串（days=0 即今天）。"""
        d = datetime.date.fromtimestamp(self.now()) - datetime.timedelta(days=days)
        return d.strftime("%Y-%m-%d")

    def make_welcome(self, roomid, name=""):
        """生成入群欢迎消息（事件驱动，由 bot.py 在成员进群时调用）。"""
        tpl = self.cfg.get("welcome_template") or "欢迎 {name} 加入本群！"
        return Outgoing(receiver=roomid, text=tpl.format(name=name or "新朋友"))

    # ------------------------------------------------------------ 路由
    def _route(self, msg: Msg):
        if msg.is_self or self._is_official(msg.sender):
            return []
        if msg.type != 1:
            return []
        content = (msg.content or "").strip()
        if not content:
            return []
        if msg.is_group and not self._group_allowed(msg.roomid):
            return []
        if self._rate_limited(msg.sender):
            log.info("限流：%s 10 秒内已回复过，跳过", msg.sender)
            return []

        reply = self._cmd_bind(msg, content)
        if reply is None and msg.is_group and msg.roomid in self._muted_groups:
            # 静默群：只放行主人的指令（开口/状态/加词等），其余任何消息都不回
            reply = self._cmd_owner(msg, content) if self._is_owner(msg.sender) else None
            if reply is None:
                return []
        if reply is None:
            reply = self._cmd_owner(msg, content)
        if reply is None:
            reply = (self._cmd_music(msg, content)
                 or self._cmd_weather(msg, content)
                 or self._cmd_fortune(msg, content)
                 or self._cmd_stats(msg, content)
                 or self._cmd_keyword(msg, content)
                 or self._cmd_qa(msg, content))
        if reply is None or reply.kind == "silent":
            return []
        self._last_reply[msg.sender] = self.now()
        return [reply]

    # ------------------------------------------------------------ 安全阀
    @staticmethod
    def _is_official(sender: str) -> bool:
        # 公众号的 wxid 以 gh_ 开头；另排除微信团队等系统号
        return sender.startswith("gh_") or sender in ("weixin", "fmessage", "medianote")

    def _group_allowed(self, roomid: str) -> bool:
        whitelist = self.cfg.get("group_whitelist") or []
        return not whitelist or roomid in whitelist

    def _rate_limited(self, sender: str) -> bool:
        last = self._last_reply.get(sender)
        return last is not None and (self.now() - last) < self.rate_limit

    @staticmethod
    def _receiver(msg: Msg) -> str:
        return msg.roomid if msg.is_group else msg.sender

    # ------------------------------------------------------------ 1. 点歌
    def _cmd_music(self, msg: Msg, content: str):
        if not content.startswith("点歌"):
            return None
        receiver = self._receiver(msg)
        if self._song_blacklisted(msg.sender):  # 黑名单先查：命中不搜歌、不调接口
            if self.cfg.get("blacklist_song_silent"):
                return Outgoing(receiver, kind="silent")  # 静默模式：_route 见 silent 直接不回
            return Outgoing(receiver, text=self.cfg.get("blacklist_song_reply")
                            or "你被主人关小黑屋啦，点不了歌～")
        query = content[len("点歌"):].strip()
        if not query:
            return Outgoing(receiver, text="想听哪首？发「点歌 歌名」或「点歌 歌名 歌手」，比如：点歌 晴天 周杰伦")

        music_cfg = self.cfg.get("music") or {}
        url = music_cfg.get("search_url", "").format(keyword=urllib.parse.quote(query))
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                   "Referer": "https://music.163.com/"}
        try:
            data = self.http.get(url, headers=headers, timeout=10).json()
            songs = ((data or {}).get("result") or {}).get("songs") or []
        except Exception:
            log.exception("点歌搜索接口失败: %s", query)
            return Outgoing(receiver, text="点歌服务暂时打了个盹，稍后再试试～")
        if not songs:
            return Outgoing(receiver, text=f"没找到和「{query}」有关的歌，换个歌名、或者加上歌手再试试～")

        song = songs[0]
        name = song.get("name") or query
        artists = " / ".join(a.get("name", "") for a in (song.get("artists") or []) if a.get("name"))
        play_url = music_cfg.get("play_url", "").format(song_id=song.get("id", ""))
        thumb = ((song.get("album") or {}).get("picUrl")) or ""
        fallback = f"🎵 {name} - {artists}\n播放链接：{play_url}"

        card_account = (music_cfg.get("card_account") or "").strip()
        if card_account:  # 配了公众号来源才发卡片，发失败由 bot.py 用 text 兜底
            return Outgoing(
                receiver, kind="rich", text=fallback,
                rich={"name": music_cfg.get("card_name") or "音乐",
                      "account": card_account,
                      "title": f"{name} - {artists}",
                      "digest": "点击播放",
                      "url": play_url,
                      "thumburl": thumb})
        return Outgoing(receiver, text=fallback)

    # ------------------------------------------------------------ 2. 天气
    def _cmd_weather(self, msg: Msg, content: str):
        if not content.startswith("天气"):
            return None
        receiver = self._receiver(msg)
        city = content[len("天气"):].strip()
        if not city:
            return Outgoing(receiver, text="查哪里的天气？发「天气 城市」，比如：天气 北京")
        url = (self.cfg.get("weather") or {}).get("url", "").format(city=urllib.parse.quote(city))
        try:
            data = self.http.get(url, timeout=10).json()
            cc = (data.get("current_condition") or [{}])[0]
            desc_list = cc.get("lang_zh") or cc.get("weatherDesc") or [{}]
            desc = desc_list[0].get("value", "")
            area = (((data.get("nearest_area") or [{}])[0].get("areaName") or [{}])[0].get("value")) or city
            text = (f"{area}今天：{desc}，气温 {cc.get('temp_C', '?')}℃"
                    f"（体感 {cc.get('FeelsLikeC', '?')}℃），"
                    f"湿度 {cc.get('humidity', '?')}%，风速 {cc.get('windspeedKmph', '?')} km/h")
            return Outgoing(receiver, text=text)
        except Exception:
            log.exception("天气接口失败: %s", city)
            return Outgoing(receiver, text=f"没查到「{city}」的天气，确认下城市名再试试～")

    # ------------------------------------------------------------ 3. 每日一签
    def _cmd_fortune(self, msg: Msg, content: str):
        if content not in ("抽签", "一签") and not content.startswith(("抽签", "一签")):
            return None
        fortunes = self.cfg.get("fortunes") or []
        if not fortunes:
            return None
        text = self.rng.choice(fortunes)
        link = self.cfg.get("fortune_link") or ""
        reply = f"🎋 今日一签\n{text}"
        if link:
            reply += f"\n每日一签：{link}"
        return Outgoing(self._receiver(msg), text=reply)

    # ------------------------------------------------------------ 4. 发言统计
    @staticmethod
    def _display_name(wxid, nickname):
        """榜单展示名：有昵称用昵称，取不到就用 wxid 后 4 位。"""
        return nickname if nickname else f"群友({wxid[-4:]})"

    def _rank_text(self, title, rows):
        if not rows:
            return f"📊 {title}\n还没有记录（我只统计进群之后、在线时收到的发言）"
        lines = [f"📊 {title}"]
        for i, (wxid, nick, total) in enumerate(rows, 1):
            lines.append(f"{i}. {self._display_name(wxid, nick)}：{total} 条")
        return "\n".join(lines)

    def _cmd_stats(self, msg: Msg, content: str):
        if content not in ("发言榜", "今日榜", "周榜", "我的发言", "导出统计", "重置统计"):
            return None
        receiver = self._receiver(msg)
        if not msg.is_group:
            return Outgoing(receiver, text="发言统计是群里的功能，到群里发这个指令哦～")

        today = self._today()
        if content in ("发言榜", "今日榜"):
            rows = self.stats.top(msg.roomid, today, today, limit=10)
            return Outgoing(receiver, text=self._rank_text("本群今日发言榜", rows))
        if content == "周榜":
            rows = self.stats.top(msg.roomid, self._day_offset(6), today, limit=10)
            return Outgoing(receiver, text=self._rank_text("本群近 7 天发言榜", rows))
        if content == "我的发言":
            mine, total = self.stats.user_counts(msg.roomid, msg.sender, today)
            return Outgoing(receiver, aters=msg.sender,
                            text=f"你今天发了 {mine} 条，本群累计 {total} 条（从我开始统计起）")
        # ---- 主人专属（只认 wxid）：导出 / 重置
        if not self._is_owner(msg.sender):
            return Outgoing(receiver, text="这个只能主人用哦～")
        if content == "导出统计":
            s = self.stats.room_summary(msg.roomid, today)
            if not s["total"]:
                return Outgoing(receiver, text="本群还没有统计数据。")
            top1 = self.stats.top(msg.roomid, "0000-00-00", today, limit=1)
            top_txt = (f"\n发言最多：{self._display_name(top1[0][0], top1[0][1])}，{top1[0][2]} 条"
                       if top1 else "")
            return Outgoing(receiver, text=(
                f"📊 本群统计摘要\n"
                f"累计发言：{s['total']} 条\n"
                f"参与人数：{s['users']} 人\n"
                f"统计天数：{s['days']} 天（自 {s['first_day']} 起）\n"
                f"今日：{s['today']} 条，{s['today_users']} 人发言"
                f"{top_txt}"))
        if content == "重置统计":
            self.stats.reset_room(msg.roomid)
            return Outgoing(receiver, text="本群统计数据已清空，重新开始统计。")
        return None

    # ------------------------------------------------------------ 5. 关键词
    def _cmd_keyword(self, msg: Msg, content: str):
        keywords = dict(self.cfg.get("keywords") or {})
        keywords.update(self._custom_keywords)  # 主人「加词」的词表后加载，同词覆盖 config
        for kw in sorted(keywords, key=len, reverse=True):  # 长词优先
            if kw and kw in content:
                return Outgoing(self._receiver(msg), text=keywords[kw])
        return None

    # ------------------------------------------------------------ 6. AI 问答（兜底）
    def _cmd_qa(self, msg: Msg, content: str):
        if msg.is_group and not msg.at_bot:
            return None  # 群里没 @ 机器人就不插话
        answer = self._ask_llm(content)
        if not answer:
            return None
        aters = msg.sender if msg.is_group else ""
        return Outgoing(self._receiver(msg), text=answer[: self.max_chars], aters=aters)

    def _ask_llm(self, question: str):
        llm = self.cfg.get("llm") or {}
        api_key = os.environ.get(llm.get("api_key_env") or "GLM_API_KEY", "")
        if not api_key:
            log.warning("未配置模型 API Key（环境变量 %s），问答不可用", llm.get("api_key_env"))
            return "问答功能还没配置好，先玩点歌、天气、抽签吧～"
        url = (llm.get("base_url") or "").rstrip("/") + "/chat/completions"
        payload = {
            "model": llm.get("model") or "glm-4-flash",
            "messages": [
                {"role": "system", "content": llm.get("system_prompt") or "你是一个友好的群聊小助手，回答简短。"},
                {"role": "user", "content": question},
            ],
            "max_tokens": int(llm.get("max_tokens") or 600),
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        try:
            data = self.http.post(url, json=payload, headers=headers, timeout=30).json()
            answer = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            return answer.strip() or "这个问题我一时答不上来，换个问法试试～"
        except Exception:
            log.exception("模型调用失败")
            return "我脑子短路了一下，稍后再问我～"
