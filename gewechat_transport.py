# -*- coding: utf-8 -*-
"""GeWeChat 传输层（默认）：iPad 协议，HTTP API 收发，Docker 跑在 Linux 上。

接口查证结论（2026-11-19 联网核对）：
  【已查证】
  - 服务地址形如 http://<host>:2531/v2/api（文件服务在 2532）——gewechaty 官方 readme。
  - 发文本 POST /message/postText，body 键 appId / toWxid / content
    ——GeWeChat 仓库自带 Java 示例原样调用（OkhttpUtil.postJSON）。
  - 收消息走 Webhook 回调：外层 {Appid, TypeName, Data, Wxid}，Data 内
    FromUserName / ToUserName / Content 是 {"string": "..."} 包装，另有 MsgType、
    MsgSource、NewMsgId；判定路径「先 TypeName → 再 MsgType → 最后解析 Content」；
    去重键 = Appid + NewMsgId；回调须 3 秒内回 HTTP 200（本模块先入队再回 200）。
  - 群消息 FromUserName 是群 id（xxx@chatroom），真实发送者藏在 Content 的
    「wxid:」+换行 前缀里；自己发的消息 FromUserName == 自己的 Wxid（私聊）或
    内容前缀是自己的 wxid（群聊），必须过滤（handlers 也会再过滤一层）。
  - @ 判定：MsgSource 是 XML，含 <atuserlist> 列出被 @ 的 wxid。
  【待核对——上线前按部署版本再核对】
  原 GeWeChat 仓库（Devo919/Gewechat）已停止维护、官方服务与文档下线，以下接口
  按同协议生态文档（gewechaty / gewechat-python 等）实现，路径与字段名要在部署时
  对照实际服务的文档逐个核对：
  - POST /login/getLoginQrCode（首次 appId 传空；返回 appId / uuid / qrImgBase64 / qrData）
  - POST /login/checkLogin（status：0 未扫码 / 1 已扫待确认 / 2 登录成功）
  - POST /login/setCallback（body：appId / callbackUrl）
  - 鉴权请求头 X-GEWE-TOKEN（token 从环境变量读，变量名见 config）
  - POST /personal/getProfile（取自己 wxid / 昵称）
  - POST /group/getChatroomMemberList（查群成员昵称，统计展示用）
  - POST /message/postLink（链接卡片）与 postText 的 ats 参数名
"""
import base64
import json
import logging
import os
import queue
import re
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from handlers import Msg
from transport import Transport

log = logging.getLogger("wechat-bot.gewechat")


def _unwrap(value):
    """GeWeChat 回调里字段常是 {"string": "..."} 包装，拆出来；普通值原样返回。"""
    if isinstance(value, dict):
        return value.get("string") or value.get("String") or ""
    return value if value is not None else ""


class GewechatTransport(Transport):
    name = "gewechat"

    def __init__(self, config, state_dir=None):
        self.cfg = config or {}
        gw = self.cfg.get("gewechat") or {}
        self.base_url = (gw.get("base_url") or "http://127.0.0.1:2531/v2/api").rstrip("/")
        self.token = os.environ.get(gw.get("token_env") or "GEWECHAT_TOKEN", "")
        self.cb_host = gw.get("callback_host") or "0.0.0.0"
        self.cb_port = int(gw.get("callback_port") or 9911)
        self.cb_path = gw.get("callback_path") or "/callback"
        self.cb_url = (gw.get("callback_url") or "").strip() \
            or f"http://127.0.0.1:{self.cb_port}{self.cb_path}"
        self.state_dir = state_dir or os.path.dirname(os.path.abspath(__file__))

        self._app_id = self._load_app_id()
        self._self_wxid = ""
        self._bot_name = ""
        self._queue = queue.Queue()
        self._seen = {}            # NewMsgId -> 时间，去重（只留最近一批）
        self._server = None
        self._member_cache = {}    # roomid -> (取数时间, {wxid: 展示名})

    # ------------------------------------------------------------ API 基础
    def _post(self, path, body, timeout=15):
        import requests
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-GEWE-TOKEN"] = self.token  # 待核对：部署版本可能用别的头名
        resp = requests.post(self.base_url + path, json=body, headers=headers, timeout=timeout)
        data = resp.json()
        if isinstance(data, dict) and data.get("ret") not in (None, 200, 0):
            log.warning("GeWeChat 接口 %s 返回 ret=%s msg=%s", path, data.get("ret"), data.get("msg"))
        return data

    def _app_file(self):
        return os.path.join(self.state_dir, "gewechat_app.json")

    def _load_app_id(self):
        try:
            with open(self._app_file(), encoding="utf-8") as f:
                return (json.load(f) or {}).get("appId") or ""
        except Exception:
            return ""

    def _save_app_id(self):
        try:
            with open(self._app_file(), "w", encoding="utf-8") as f:
                json.dump({"appId": self._app_id}, f)
        except Exception:
            log.exception("保存 GeWeChat appId 失败")

    # ------------------------------------------------------------ 启动：回调服务 + 登录
    def start(self):
        self._start_callback_server()
        self._ensure_login()
        self._set_callback()

    def _start_callback_server(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    raw = self.rfile.read(length) if length else b""
                    payload = json.loads(raw.decode("utf-8") or "{}")
                    outer._queue.put(payload)   # 先入队，业务在 events() 里慢慢处理
                except Exception:
                    log.exception("GeWeChat 回调解析失败")
                finally:
                    # 文档要求 3 秒内回 200，否则会重推
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer((self.cb_host, self.cb_port), Handler)
        t = threading.Thread(target=self._server.serve_forever, daemon=True)
        t.start()
        log.info("GeWeChat 回调服务已启动：%s:%s%s（对外地址 %s）",
                 self.cb_host, self.cb_port, self.cb_path, self.cb_url)

    def _ensure_login(self):
        # 已有 appId 且在线就直接用，不重新扫码
        if self._app_id and self._fetch_profile():
            log.info("GeWeChat 已登录：%s（%s）", self._bot_name, self._self_wxid)
            return
        log.info("GeWeChat 未登录，获取登录二维码……")
        data = (self._post("/login/getLoginQrCode", {"appId": self._app_id or ""}) or {}).get("data") or {}
        self._app_id = data.get("appId") or self._app_id
        if self._app_id:
            self._save_app_id()
        uuid = data.get("uuid") or ""
        qr_b64 = data.get("qrImgBase64") or ""
        if qr_b64:
            qr_path = os.path.join(self.state_dir, "login_qrcode.png")
            try:
                with open(qr_path, "wb") as f:
                    f.write(base64.b64decode(qr_b64))
                log.info("登录二维码已保存到 %s，用机器人小号扫码登录", qr_path)
            except Exception:
                log.exception("保存登录二维码失败")
        if data.get("qrData"):
            log.info("二维码内容（链接）：%s", data["qrData"])
        log.info("等待扫码确认（最长约 5 分钟）……")
        deadline = time.time() + 300
        while time.time() < deadline:
            time.sleep(3)
            try:
                chk = (self._post("/login/checkLogin",
                                  {"appId": self._app_id, "uuid": uuid}) or {}).get("data") or {}
            except Exception:
                log.exception("checkLogin 轮询失败，继续等")
                continue
            status = chk.get("status")
            if status == 2:
                info = chk.get("loginInfo") or chk
                self._self_wxid = info.get("wxid") or info.get("userName") or self._self_wxid
                self._bot_name = info.get("nickName") or info.get("nickname") or self._bot_name
                self._fetch_profile()  # 再补全一次（失败不影响）
                log.info("GeWeChat 登录成功：%s（%s）", self._bot_name, self._self_wxid)
                return
            if status == 1:
                log.info("已扫码，等待手机上确认……")
        raise RuntimeError("GeWeChat 登录超时：5 分钟内没完成扫码，重启 bot.py 再试")

    def _fetch_profile(self):
        """取自己 wxid/昵称（接口路径待核对，失败返回 False 不崩）。"""
        try:
            data = (self._post("/personal/getProfile", {"appId": self._app_id}) or {}).get("data") or {}
            wxid = data.get("wxid") or data.get("userName") or ""
            if wxid:
                self._self_wxid = wxid
                self._bot_name = data.get("nickName") or data.get("nickname") or self._bot_name
                return True
        except Exception:
            log.exception("getProfile 失败")
        return False

    def _set_callback(self):
        try:
            self._post("/login/setCallback",
                       {"appId": self._app_id, "callbackUrl": self.cb_url})
            log.info("GeWeChat 消息回调已设置：%s", self.cb_url)
        except Exception:
            log.exception("setCallback 失败（接口待核对）：消息可能收不到，"
                          "请按部署版本文档手动核对回调设置")

    # ------------------------------------------------------------ 身份
    def self_wxid(self) -> str:
        return self._self_wxid

    def bot_name(self) -> str:
        return self._bot_name

    # ------------------------------------------------------------ 发送
    def send_text(self, receiver: str, text: str, aters: str = ""):
        body = {"appId": self._app_id, "toWxid": receiver, "content": text}
        if aters:
            body["ats"] = aters  # 待核对：部署版本的 @ 参数名
        self._post("/message/postText", body)

    def send_rich(self, out) -> bool:
        # 待核对：postLink 的路径与字段名按部署版本文档再核对；失败自动退文本
        r = out.rich
        try:
            data = self._post("/message/postLink", {
                "appId": self._app_id, "toWxid": out.receiver,
                "title": r.get("title", ""), "desc": r.get("digest", ""),
                "linkUrl": r.get("url", ""), "imgUrl": r.get("thumburl", ""),
            })
            return isinstance(data, dict) and data.get("ret") in (200, 0)
        except Exception:
            log.exception("postLink 发送失败，改发文本")
            return False

    # ------------------------------------------------------------ 收消息
    def events(self):
        while True:
            payload = self._queue.get()
            try:
                ev = self._convert(payload)
            except Exception:
                log.exception("GeWeChat 回调转换失败，已跳过一条")
                continue
            if ev is not None:
                yield ev

    def _convert(self, payload):
        if not isinstance(payload, dict):
            return None
        if not self._self_wxid and payload.get("Wxid"):
            self._self_wxid = payload["Wxid"]  # 回调外层带机器人 wxid，兜底补上
        if payload.get("TypeName") != "AddMsg":
            # 掉线/状态类通知只记日志（TypeName 取值待核对）
            log.info("GeWeChat 非消息回调：TypeName=%s", payload.get("TypeName"))
            return None
        data = payload.get("Data") or {}
        new_id = str(data.get("NewMsgId") or "")
        if new_id:
            if new_id in self._seen:
                return None  # 重推去重（键 Appid + NewMsgId，这里同进程同 Appid 只比 NewMsgId）
            self._seen[new_id] = time.time()
            if len(self._seen) > 2000:  # 只留最近一批，防无限涨
                cutoff = time.time() - 3600
                self._seen = {k: v for k, v in self._seen.items() if v > cutoff}

        msg_type = int(data.get("MsgType") or 0)
        from_user = str(_unwrap(data.get("FromUserName")) or "")
        to_user = str(_unwrap(data.get("ToUserName")) or "")
        content = str(_unwrap(data.get("Content")) or "")

        # ---- 系统消息：只识别进群欢迎，其余不产出（也不计发言）
        if msg_type in (10000, 10002):
            roomid = from_user if from_user.endswith("@chatroom") else ""
            name = parse_new_member_sysmsg(content)
            if roomid and name is not None:
                return ("new_member", roomid, name)
            return None

        is_group = from_user.endswith("@chatroom") or to_user.endswith("@chatroom")
        roomid = from_user if from_user.endswith("@chatroom") else (
            to_user if to_user.endswith("@chatroom") else "")
        sender = from_user
        if is_group:
            # 群消息真实发送者在内容前缀「wxid:」+换行 里
            prefix, sep, rest = content.partition(":\n")
            if sep and prefix and " " not in prefix and "<" not in prefix and len(prefix) <= 64:
                sender = prefix
                content = rest
        is_self = bool(self._self_wxid) and sender == self._self_wxid

        at_list = extract_at_list(str(data.get("MsgSource") or ""))
        at_bot = False
        if is_group and msg_type == 1 and self._self_wxid:
            at_bot = self._self_wxid in at_list
            if at_bot:
                content = strip_at_mention(content, self._bot_name)

        return ("msg", Msg(
            sender=sender,
            roomid=roomid,
            content=content if msg_type == 1 else "",
            is_group=is_group,
            at_bot=at_bot,
            is_self=is_self,
            type=msg_type,
            nickname=self._group_nickname(roomid, sender) if is_group else "",
            at_list=at_list,  # 被 @ 的 wxid 列表（主人「禁点歌」靠它定位目标）
        ))

    def _group_nickname(self, roomid, wxid):
        """群成员展示名（统计用）：成员列表接口待核对，取不到就返回空（展示层用 wxid 兜底）。"""
        if not roomid or not wxid:
            return ""
        now = time.time()
        cached = self._member_cache.get(roomid)
        if cached and now - cached[0] < 3600:
            return cached[1].get(wxid, "")
        names = {}
        try:
            data = (self._post("/group/getChatroomMemberList",
                               {"appId": self._app_id, "chatroomId": roomid}) or {}).get("data") or {}
            members = data.get("memberList") or data.get("members") or []
            for m in members:
                uid = m.get("userName") or m.get("wxid") or ""
                if uid:
                    names[uid] = m.get("displayName") or m.get("nickName") or m.get("nickname") or ""
        except Exception:
            log.exception("查群成员列表失败，昵称留空")
        self._member_cache[roomid] = (now, names)
        return names.get(wxid, "")

    def close(self):
        if self._server is not None:
            try:
                self._server.shutdown()
            except Exception:
                pass


def extract_at_list(msg_source: str):
    """从 MsgSource XML 里取被 @ 的 wxid 列表。"""
    if not msg_source or "atuserlist" not in msg_source:
        return []
    m = re.search(r"<atuserlist>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</atuserlist>",
                  msg_source, re.S)
    if not m:
        return []
    return [x.strip() for x in m.group(1).split(",") if x.strip()]


def strip_at_mention(content: str, bot_name: str):
    """群消息里 @机器人 的部分形如 @昵称+特殊空格，剥掉再交给路由器（与 wcferry 版同规则）。"""
    if bot_name:
        content = content.replace("@" + bot_name + "\u2005", " ").replace("@" + bot_name, " ")
    return re.sub(r"@\S+?\u2005", "", content).strip()


def parse_new_member_sysmsg(content: str):
    """从 GeWeChat 系统消息（sysmsgtemplate XML）里解析新成员昵称。

    识别不到「进群」语义返回 None；识别到了但名字没解析出来返回 ""。
    XML 结构随版本变化（待核对），这里做宽容解析：先抽模板里的纯文本再套用
    与 wcferry 版相同的引号名字规则。
    """
    text = content or ""
    if "<sysmsg" in text or "sysmsgtemplate" in text:
        try:
            root = ET.fromstring(text)
            chunks = [t.strip() for t in root.itertext() if t and t.strip()]
            text = " ".join(chunks)
        except Exception:
            text = re.sub(r"<[^>]+>", " ", text)
    if "加入" not in text or "群聊" not in text:
        return None
    names = re.findall(r'"([^"]+)"', text) or re.findall(r"“([^”]+)”", text)
    if not names:
        return ""
    if "邀请" in text and len(names) >= 2:
        return names[1]
    return names[0]
