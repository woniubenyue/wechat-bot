# -*- coding: utf-8 -*-
"""WeChatFerry（wcferry）传输层（可选）：Windows 电脑上挂微信小号时用。

从旧版 bot.py 拆出，逻辑不变：连微信、收入群欢迎事件、把 WxMsg 转成
handlers.Msg、执行发送（卡片失败退文本）。Linux 部署用 gewechat_transport，
不要在 Linux 上 import 本模块（wcferry 只有 Windows 版）。
"""
import logging
import re
import time

from handlers import Msg
from transport import Transport

log = logging.getLogger("wechat-bot.wcferry")


def parse_new_member(content: str):
    """从群系统消息（type=10000）里解析新成员昵称，解析不到返回空串。

    常见文案：
      "张三"通过扫描"李四"分享的二维码加入群聊   -> 张三
      "李四"邀请"张三"加入了群聊                 -> 张三
    不是进群消息返回 None。
    """
    if "加入" not in content or "群聊" not in content:
        return None
    names = re.findall(r'"([^"]+)"', content)
    if not names:
        return ""
    if "邀请" in content and len(names) >= 2:
        return names[1]
    return names[0]


def strip_at_mention(content: str, bot_name: str) -> str:
    """群消息里 @机器人 的部分形如 @昵称\u2005，把它剥掉再交给路由器。"""
    if bot_name:
        content = content.replace("@" + bot_name + "\u2005", " ").replace("@" + bot_name, " ")
    return re.sub(r"@\S+?\u2005", "", content).strip()


class WcferryTransport(Transport):
    name = "wcferry"

    def __init__(self, config, state_dir=None):
        self.cfg = config or {}
        self._wcf = None
        self._self_wxid = ""
        self._bot_name = ""

    def start(self):
        from wcferry import Wcf  # 延迟导入：非 Windows 环境下 import 本模块也不报错

        self._wcf = Wcf()
        self._self_wxid = self._wcf.get_self_wxid()
        info = self._wcf.get_info_by_wxid(self._self_wxid) or {}
        self._bot_name = info.get("name") or ""
        self._wcf.enable_receiving_msg(pyq=False)

    def self_wxid(self) -> str:
        return self._self_wxid

    def bot_name(self) -> str:
        return self._bot_name

    def send_text(self, receiver: str, text: str, aters: str = ""):
        self._wcf.send_text(text, receiver, aters or None)

    def send_rich(self, out) -> bool:
        r = out.rich
        ret = self._wcf.send_rich_text(r.get("name", ""), r.get("account", ""), r.get("title", ""),
                                       r.get("digest", ""), r.get("url", ""), r.get("thumburl", ""),
                                       out.receiver)
        if ret != 0:
            log.warning("卡片发送返回 %s，改发文本", ret)
            return False
        return True

    def events(self):
        wcf = self._wcf
        while wcf.is_receiving_msg():
            try:
                msg = wcf.get_msg()
            except Exception:
                time.sleep(1)
                continue
            try:
                ev = self._convert(msg)
            except Exception:
                log.exception("wcferry 消息转换失败，已跳过一条")
                continue
            if ev is not None:
                yield ev

    def _convert(self, msg):
        # ---- 入群欢迎：群系统消息 type=10000
        if msg.type == 10000:
            name = parse_new_member(msg.content or "")
            if name is not None and msg.roomid:
                return ("new_member", msg.roomid, name)
            return None

        # ---- 普通消息：所有类型都转（发言统计要计数），handlers 只回文本类指令
        is_group = bool(msg.roomid)
        at_bot = bool(is_group and msg.type == 1 and msg.is_at(self._self_wxid))
        content = msg.content or ""
        if at_bot:
            content = strip_at_mention(content, self._bot_name)
        # 注意：wcferry 取不到「被 @ 者 wxid 列表」，at_list 留空——
        # 主人「禁点歌」在 wcferry 下只能用带 wxid 参数的形式（私聊/群里发「禁点歌 wxid」）
        return ("msg", Msg(
            sender=msg.sender,
            roomid=msg.roomid or "",
            content=content if msg.type == 1 else "",
            is_group=is_group,
            at_bot=at_bot,
            is_self=bool(msg.from_self()),
            type=msg.type,
            nickname=self._group_nickname(msg),
        ))

    def _group_nickname(self, msg):
        """取发言人当时的群昵称（统计展示用）：优先群内显示名，其次资料昵称，都取不到返回空。"""
        if not msg.roomid:
            return ""
        try:
            alias = self._wcf.get_alias_in_chatroom(msg.roomid, msg.sender)
            if alias:
                return alias
        except Exception:
            pass
        try:
            return (self._wcf.get_info_by_wxid(msg.sender) or {}).get("name") or ""
        except Exception:
            return ""

    def close(self):
        if self._wcf is not None:
            try:
                self._wcf.cleanup()
            except Exception:
                pass
