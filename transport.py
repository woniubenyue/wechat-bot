# -*- coding: utf-8 -*-
"""传输层接口：bot.py 只依赖这一层，不关心底层是 GeWeChat 还是 WeChatFerry。

约定：
  - send_text(receiver, text, aters="")：发一条文本；receiver 是群 id 或 wxid；
    aters 是群里要 @ 的 wxid（可空）。
  - send(out)：发一条 handlers.Outgoing——kind="rich" 时先试 send_rich()，
    传输层不支持或发送失败就自动退回纯文本（out.text 是兜底文本）。
  - events()：阻塞式事件迭代器，逐个产出事件元组：
        ("msg", Msg)                    一条消息（已解析成 handlers.Msg）
        ("new_member", roomid, name)    有新成员进群（name 取不到时为 ""）
    统计要求所有类型的群消息都产出 Msg（handlers 只回文本、但都计数），
    系统消息（进群提示等）不产出 Msg、只在能识别进群时产出 new_member。
  - start() 在 events() 之前调用一次，完成连接/登录；close() 收尾。
"""
import logging

log = logging.getLogger("wechat-bot.transport")


class Transport:
    name = "base"

    def start(self):
        """连接/登录准备。失败抛异常，由 bot.py 记日志退出。"""

    def self_wxid(self) -> str:
        return ""

    def bot_name(self) -> str:
        return ""

    def send_text(self, receiver: str, text: str, aters: str = ""):
        raise NotImplementedError

    def send_rich(self, out) -> bool:
        """发送链接卡片，成功返回 True。不支持卡片的传输层默认 False（走文本兜底）。"""
        return False

    def send(self, out):
        if out.kind == "rich" and out.rich:
            try:
                if self.send_rich(out):
                    return
                log.warning("卡片发送未成功，改发文本兜底")
            except Exception:
                log.exception("卡片发送异常，改发文本兜底")
        self.send_text(out.receiver, out.text, out.aters or "")

    def events(self):
        raise NotImplementedError
        yield  # pragma: no cover - 使本方法成为生成器

    def close(self):
        pass
