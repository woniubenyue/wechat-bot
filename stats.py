# -*- coding: utf-8 -*-
"""群发言统计存储层（SQLite）。

按（群 ID、发言人 wxid、日期）计数：文本、图片、语音等任何类型的消息都算 1 条，
消息类型分开记字段（msg_type 列），查榜单时按全部类型汇总。
昵称存「最近一次发言时事件里带的群昵称/备注」，查榜时取最新值；取不到昵称由展示层
用 wxid 后 4 位代替。

注意（已知限制）：只能统计机器人进群之后、且机器人在线时收到的消息；
云电脑暂停期间的发言机器人收不到，会漏记。
"""
import logging
import os
import sqlite3
import threading

log = logging.getLogger("wechat-bot.stats")


class StatsStore:
    def __init__(self, db_path):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock, self._conn:
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS msg_counts (
                    roomid   TEXT NOT NULL,
                    wxid     TEXT NOT NULL,
                    day      TEXT NOT NULL,          -- YYYY-MM-DD（本地日期）
                    msg_type INTEGER NOT NULL,       -- 微信消息类型：1 文本 3 图片 34 语音 ...
                    cnt      INTEGER NOT NULL DEFAULT 0,
                    nickname TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (roomid, wxid, day, msg_type)
                )""")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_counts_room_day ON msg_counts(roomid, day)")

    # ------------------------------------------------------------ 记一条
    def record(self, roomid, wxid, day, msg_type=1, nickname=""):
        """记一条发言。nickname 传空则不覆盖已存昵称。"""
        if not roomid or not wxid:
            return
        with self._lock, self._conn:
            self._conn.execute("""
                INSERT INTO msg_counts (roomid, wxid, day, msg_type, cnt, nickname)
                VALUES (?, ?, ?, ?, 1, ?)
                ON CONFLICT (roomid, wxid, day, msg_type)
                DO UPDATE SET cnt = cnt + 1,
                              nickname = CASE WHEN excluded.nickname != ''
                                              THEN excluded.nickname ELSE nickname END
                """, (roomid, wxid, day, int(msg_type), nickname or ""))

    # ------------------------------------------------------------ 查榜单
    def top(self, roomid, start_day, end_day, limit=10):
        """[start_day, end_day] 区间内发言前 N 名：[(wxid, nickname, total), ...]"""
        with self._lock:
            rows = self._conn.execute("""
                SELECT wxid,
                       (SELECT nickname FROM msg_counts c2
                         WHERE c2.roomid = c.roomid AND c2.wxid = c.wxid AND c2.nickname != ''
                         ORDER BY c2.day DESC LIMIT 1) AS nick,
                       SUM(cnt) AS total
                FROM msg_counts c
                WHERE roomid = ? AND day >= ? AND day <= ?
                GROUP BY wxid
                ORDER BY total DESC, wxid ASC
                LIMIT ?
                """, (roomid, start_day, end_day, int(limit))).fetchall()
        return [(r[0], r[1] or "", int(r[2])) for r in rows]

    # ------------------------------------------------------------ 查个人
    def user_counts(self, roomid, wxid, day):
        """返回 (今日条数, 本群累计条数)。"""
        with self._lock:
            today = self._conn.execute(
                "SELECT COALESCE(SUM(cnt), 0) FROM msg_counts WHERE roomid = ? AND wxid = ? AND day = ?",
                (roomid, wxid, day)).fetchone()[0]
            total = self._conn.execute(
                "SELECT COALESCE(SUM(cnt), 0) FROM msg_counts WHERE roomid = ? AND wxid = ?",
                (roomid, wxid)).fetchone()[0]
        return int(today), int(total)

    # ------------------------------------------------------------ 群摘要（主人导出用）
    def room_summary(self, roomid, today):
        """当前群累计数据摘要：dict(总条数, 发言人数, 统计天数, 起始日, 今日条数, 今日人数)。"""
        with self._lock:
            total, users, days, first_day = self._conn.execute(
                """SELECT COALESCE(SUM(cnt), 0), COUNT(DISTINCT wxid),
                          COUNT(DISTINCT day), MIN(day)
                   FROM msg_counts WHERE roomid = ?""", (roomid,)).fetchone()
            t_cnt, t_users = self._conn.execute(
                """SELECT COALESCE(SUM(cnt), 0), COUNT(DISTINCT wxid)
                   FROM msg_counts WHERE roomid = ? AND day = ?""", (roomid, today)).fetchone()
        return {"total": int(total), "users": int(users), "days": int(days),
                "first_day": first_day or "", "today": int(t_cnt), "today_users": int(t_users)}

    # ------------------------------------------------------------ 重置（主人用）
    def reset_room(self, roomid):
        """清空某个群的全部统计数据，返回删掉的行数。"""
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM msg_counts WHERE roomid = ?", (roomid,))
            return cur.rowcount

    def close(self):
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass
