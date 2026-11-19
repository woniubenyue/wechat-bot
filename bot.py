# -*- coding: utf-8 -*-
"""微信群机器人主程序：只做装配和事件分发，逻辑在 handlers.py、收发在传输层。

传输层二选一（config.yaml 的 transport，或环境变量 WECHAT_BOT_TRANSPORT 覆盖）：
  - gewechat（默认）：GeWeChat / iPad 协议，Linux 云电脑 + Docker，见 gewechat_transport.py
  - wcferry：WeChatFerry，Windows 电脑挂微信时用，见 wcferry_transport.py

运行：python3 bot.py
"""
import logging
import os
import sys

import yaml

from handlers import BotCore

log = logging.getLogger("wechat-bot")


def setup_logging():
    base = os.path.dirname(os.path.abspath(__file__))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout),
                  logging.FileHandler(os.path.join(base, "bot.log"), encoding="utf-8")],
    )


def load_config():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def make_transport(cfg, state_dir):
    kind = (os.environ.get("WECHAT_BOT_TRANSPORT") or cfg.get("transport")
            or "gewechat").strip().lower()
    if kind == "wcferry":
        from wcferry_transport import WcferryTransport
        return WcferryTransport(cfg, state_dir=state_dir)
    if kind != "gewechat":
        log.warning("未知 transport=%s，按 gewechat 处理", kind)
    from gewechat_transport import GewechatTransport
    return GewechatTransport(cfg, state_dir=state_dir)


def dispatch(core: BotCore, transport, event):
    """处理传输层产出的一个事件：进群欢迎 / 普通消息路由 + 发送。"""
    kind = event[0]
    if kind == "new_member":
        _, roomid, name = event
        transport.send(core.make_welcome(roomid, name))
        log.info("已欢迎新成员：群 %s，成员 %s", roomid, name or "(未取到昵称)")
        return
    msg = event[1]
    log.info("收到消息 群=%s 发送者=%s 类型=%s @我=%s 内容=%s",
             msg.roomid or "(私聊)", msg.sender, msg.type, msg.at_bot,
             (msg.content or "")[:60])
    for out in core.handle(msg):
        transport.send(out)


def main():
    setup_logging()
    cfg = load_config()
    state_dir = ((cfg.get("bot") or {}).get("state_dir") or "").strip() or None
    core = BotCore(cfg, state_dir=state_dir)
    transport = make_transport(cfg, core.state_dir)
    transport.start()
    log.info("机器人已上线：%s（%s），传输层=%s；群白名单见 config.yaml",
             transport.bot_name(), transport.self_wxid(), transport.name)
    try:
        for event in transport.events():
            try:
                dispatch(core, transport, event)
            except Exception:
                log.exception("发送/处理环节异常，已跳过一个事件")
    except KeyboardInterrupt:
        log.info("收到 Ctrl+C，退出")
    finally:
        transport.close()
        core.stats.close()


if __name__ == "__main__":
    main()
