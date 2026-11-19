# -*- coding: utf-8 -*-
"""AutoX 安卓桥接服务：手机（bot.js）<-> 现有机器人逻辑（handlers.BotCore）。

定位：AutoX.js 脚本只能靠通知/无障碍感知微信消息，没有 wxid、没有群 id，
只有「群名 + 发送者昵称 + 文本」。本服务把手机 POST 来的消息翻译成
handlers.Msg（sender 用伪 id "ax_<昵称>"、roomid 用伪 id "axroom_<群名>"），
交给 BotCore 路由（点歌/天气/抽签/统计/关键词/问答/主人指令全部复用），
再把要发的回复排队，手机通过轮询取走、用无障碍发回群里。

接口（JSON，UTF-8）：
  POST /msg       手机上报一条消息 {group, sender, content, at_bot, is_self, msg_id}
                  → 先入队回复，再把本条产生的回复一并返回 {ok, replies:[...]}
  GET  /pending?group=<群名>   取某群还没确认送达的回复（补漏用，私聊传 group=）
  POST /ack       {ids:[回复id,...]}  手机发送成功后确认，队列里删除
  POST /heartbeat {device, ...}     心跳，只记日志，回 {ok, server_time}
  GET  /health                      健康检查 {ok, pending}

回复对象：{id, group, text, at}（at = 要 @ 的发送者昵称，可空；音乐卡片在
安卓路线降级为纯文本——handlers 的 Outgoing.text 本来就是卡片的兜底文本）。

鉴权：环境变量 BRIDGE_TOKEN 非空时，所有接口都要带请求头 X-Bot-Token；
为空则不校验（只建议本机/局域网测试时这样）。GLM_API_KEY 等模型 Key
同样只走环境变量（handlers 自己读），本文件不存任何密钥。

运行：python3 bridge.py   （端口 BRIDGE_PORT，默认 9920；状态目录
BRIDGE_STATE_DIR，默认 ./state，与 GeWeChat 部署的统计分开，互不干扰）
"""
import json
import logging
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 复用上一级目录的机器人逻辑：handlers.py（BotCore/Msg）、bot.py（load_config）
PARENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PARENT_DIR)

from handlers import BotCore, Msg  # noqa: E402
from bot import load_config  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("wechat-bot.bridge")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.environ.get("BRIDGE_STATE_DIR") or os.path.join(BASE_DIR, "state")
TOKEN = os.environ.get("BRIDGE_TOKEN") or ""
PORT = int(os.environ.get("BRIDGE_PORT") or 9920)


# ---------------------------------------------------------------- 回复队列
class ReplyStore:
    """待发回复（内存队列 + 已见消息去重）。重启丢失未确认回复，可接受：
    手机侧发送失败本来就靠 /pending 补漏，桥重启后未发出的回复直接作废，
    避免隔天把旧回复发进群里。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._pending = {}          # reply_id -> reply dict
        self._seen_msg = {}         # 手机 msg_id -> 时间（去重）
        self._seq = 0

    def seen_before(self, msg_id):
        if not msg_id:
            return False
        with self._lock:
            if msg_id in self._seen_msg:
                return True
            self._seen_msg[msg_id] = time.time()
            if len(self._seen_msg) > 3000:  # 只留最近一批
                cutoff = time.time() - 3600
                self._seen_msg = {k: v for k, v in self._seen_msg.items() if v > cutoff}
            return False

    def add(self, group, text, at=""):
        with self._lock:
            self._seq += 1
            rid = f"r{int(time.time() * 1000)}-{self._seq}"
            reply = {"id": rid, "group": group, "text": text, "at": at or "",
                     "ts": time.time()}
            self._pending[rid] = reply
            return reply

    def pending_for(self, group):
        with self._lock:
            rows = [r for r in self._pending.values() if r["group"] == group]
        return sorted(rows, key=lambda r: r["ts"])

    def ack(self, ids):
        with self._lock:
            for rid in ids or []:
                self._pending.pop(rid, None)

    def count(self):
        with self._lock:
            return len(self._pending)


# ---------------------------------------------------------------- 桥接核心
class Bridge:
    def __init__(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        cfg = load_config()  # 读 ../config.yaml（与 bot.py 同一份配置）
        self.core = BotCore(cfg, state_dir=STATE_DIR)
        self.store = ReplyStore()
        # 伪 id -> 昵称/群名 的反查（Outgoing 只带伪 id receiver，发回手机时要还原成群名）
        self._room_names = {}   # "axroom_<群名>" -> 群名
        self._nick_names = {}   # "ax_<昵称>" -> 昵称

    @staticmethod
    def _room_id(group):
        return "axroom_" + group if group else ""

    @staticmethod
    def _sender_id(nickname):
        return "ax_" + nickname if nickname else ""

    def on_message(self, data):
        """处理手机上报的一条消息，返回本次产生的回复列表。"""
        group = (data.get("group") or "").strip()
        nickname = (data.get("sender") or "").strip()
        content = (data.get("content") or "").strip()
        if not nickname or not content:
            return []
        if data.get("observe"):
            # 手机端观察模式：只记日志验证「能收到」，不进路由、不计统计、不回复
            log.info("[观察] 群=%s 发送者=%s @我=%s 内容=%s",
                     group or "(私聊)", nickname, bool(data.get("at_bot")), content[:60])
            return []
        if self.store.seen_before(str(data.get("msg_id") or "")):
            log.info("重复消息已忽略：%s", data.get("msg_id"))
            return []

        roomid = self._room_id(group)
        sender = self._sender_id(nickname)
        if roomid:
            self._room_names[roomid] = group
        self._nick_names[sender] = nickname

        msg = Msg(sender=sender,
                  roomid=roomid,
                  content=content,
                  is_group=bool(group),
                  at_bot=bool(data.get("at_bot")),
                  is_self=bool(data.get("is_self")),
                  type=1,
                  nickname=nickname)
        log.info("收到消息 群=%s 发送者=%s @我=%s 内容=%s",
                 group or "(私聊)", nickname, msg.at_bot, content[:60])

        replies = []
        for out in self.core.handle(msg):
            # 安卓无障碍只能发纯文本：rich 卡片用 Outgoing.text 兜底文本（handlers 已备好）
            text = (out.text or "").strip()
            if not text:
                continue
            target_group = self._room_names.get(out.receiver, group if out.receiver == roomid else "")
            at_nick = self._nick_names.get(out.aters, "") if out.aters else ""
            replies.append(self.store.add(target_group, text, at=at_nick))
        return replies


# ---------------------------------------------------------------- HTTP 服务
def make_handler(bridge):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _auth_ok(self):
            return not TOKEN or self.headers.get("X-Bot-Token") == TOKEN

        def _send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            return json.loads(raw.decode("utf-8") or "{}")

        def do_GET(self):
            if not self._auth_ok():
                return self._send_json(403, {"ok": False, "error": "bad token"})
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/health":
                return self._send_json(200, {"ok": True, "pending": bridge.store.count()})
            if parsed.path == "/pending":
                qs = urllib.parse.parse_qs(parsed.query)
                group = (qs.get("group") or [""])[0]
                rows = bridge.store.pending_for(group)
                return self._send_json(200, {"ok": True, "replies": rows})
            return self._send_json(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            if not self._auth_ok():
                return self._send_json(403, {"ok": False, "error": "bad token"})
            try:
                data = self._read_json()
            except Exception:
                return self._send_json(400, {"ok": False, "error": "bad json"})
            if self.path == "/msg":
                replies = bridge.on_message(data)
                return self._send_json(200, {"ok": True, "replies": replies})
            if self.path == "/ack":
                bridge.store.ack(data.get("ids"))
                return self._send_json(200, {"ok": True})
            if self.path == "/heartbeat":
                log.info("手机心跳：%s", data.get("device") or "?")
                return self._send_json(200, {"ok": True, "server_time": int(time.time())})
            return self._send_json(404, {"ok": False, "error": "not found"})

        def log_message(self, *args):
            pass

    return Handler


def main():
    bridge = Bridge()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), make_handler(bridge))
    log.info("桥接服务已启动：0.0.0.0:%s（状态目录 %s，鉴权 %s）",
             PORT, STATE_DIR, "开" if TOKEN else "关（BRIDGE_TOKEN 未设置）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("收到 Ctrl+C，退出")
    finally:
        bridge.core.stats.close()


if __name__ == "__main__":
    main()
