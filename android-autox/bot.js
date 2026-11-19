// ============================================================
// 蜗牛奔月微信群机器人 —— AutoX.js 安卓端脚本
// 原理：通知监听 + 无障碍。不 root、不改微信、不碰协议。
//   收：监听微信通知，解析出「群名 / 发送者昵称 / 内容」，POST 到桥接服务；
//   发：桥接服务返回（或轮询取到）回复后，用无障碍打开对应群、输入、点发送。
// 已知局限（无障碍路线的通病，先说清）：
//   - 微信通知必须开「通知显示消息详情」，否则通知里只有「你收到了一条新消息」；
//   - 通知文本会被系统截断，超长消息只能拿到前半截；
//   - 发送要亮屏、切到微信界面操作，期间别手动玩这台手机；
//   - 拿不到 wxid/群 id，身份只认昵称（改名会影响统计与主人识别）。
// 用法：把下面 CONFIG 区改好（桥接地址、机器人昵称），在 AutoX.js 里导入运行。
// ============================================================

// ---------------- CONFIG 配置区（只改这里） ----------------
var CONFIG = {
    // 桥接服务地址：bridge.py 的 HTTPS 地址（cloudflared 隧道域名），不要带末尾 /
    // 本机同局域网调试可填 http://电脑IP:9920
    BRIDGE_URL: "https://deals-dee-est-opened.trycloudflare.com",
    // 桥接服务鉴权口令：和服务器环境变量 BRIDGE_TOKEN 一致；服务器没设就留空
    BRIDGE_TOKEN: "397f96846225ed213ec0bd12ef6b17ae",
    // 机器人在群里的昵称（小号的群昵称）：用来判断 @我、过滤自己发的消息
    BOT_NICKNAME: "请改成机器人小号昵称",
    // 群白名单：只处理这些群名的消息。留空 [] = 观察模式下先记录所有群，
    // 正式开回复前务必把要服务的群名填进来（名字要和微信里一字不差）
    WHITELIST_GROUPS: [],
    // 观察模式：true = 只上报记录、绝不回复（先开这个验证能收到消息）；false = 正式回复
    OBSERVE_ONLY: true,
    // 是否转发私聊消息（认主、主人私聊指令要用）：先 false，等群里跑通再开
    FORWARD_PRIVATE: false,
    // 轮询取待发回复的间隔（毫秒）
    POLL_INTERVAL_MS: 4000,
    // 同一个群两次发送的最小间隔（毫秒）：10 秒，防刷屏、防风控，别调小
    SEND_MIN_INTERVAL_MS: 10000,
    // 心跳间隔（毫秒）
    HEARTBEAT_INTERVAL_MS: 60000,
};
// ---------------- CONFIG 结束 ----------------

var WECHAT_PKG = "com.tencent.mm";

// ---------------- 全局状态 ----------------
var seenMsgKeys = {};      // 消息去重：key -> 时间戳（通知会重复推送同一条）
var seenReplyIds = {};     // 回复去重：replyId -> true（/msg 直返和 /pending 轮询会重叠）
var sendQueue = [];        // 待发送队列（单工作线程消费，避免界面操作打架）
var lastSendAt = {};       // 群名 -> 上次发送时间戳（限频用）
var lastNotification = {}; // 群名 -> 最近一条通知对象（点它可直达对应聊天）
var knownGroups = {};      // 见过的群名集合（轮询 /pending 时遍历用）
var httpFailStreak = 0;    // 连续 HTTP 失败次数（退避用）

function nowMs() { return new Date().getTime(); }

function logx(msg) {
    console.log("[wxbot] " + msg);
}

// 简单字符串哈希（生成消息去重 key 用）
function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return "h" + h;
}

// ============================================================
// HTTP 小工具（同步调用，必须在子线程里用，别堵主线程的事件分发）
// ============================================================
function httpHeaders() {
    var h = { "Content-Type": "application/json" };
    if (CONFIG.BRIDGE_TOKEN) h["X-Bot-Token"] = CONFIG.BRIDGE_TOKEN;
    return h;
}

function postJson(path, data) {
    try {
        var res = http.postJson(CONFIG.BRIDGE_URL + path, data, { headers: httpHeaders() });
        if (res.statusCode >= 200 && res.statusCode < 300) {
            httpFailStreak = 0;
            return res.body.json();
        }
        logx("POST " + path + " 返回 " + res.statusCode);
    } catch (e) {
        httpFailStreak++;
        logx("POST " + path + " 失败（第 " + httpFailStreak + " 次）：" + e);
    }
    return null;
}

function getJson(path) {
    try {
        var res = http.get(CONFIG.BRIDGE_URL + path, { headers: httpHeaders() });
        if (res.statusCode >= 200 && res.statusCode < 300) {
            httpFailStreak = 0;
            return res.body.json();
        }
        logx("GET " + path + " 返回 " + res.statusCode);
    } catch (e) {
        httpFailStreak++;
        logx("GET " + path + " 失败（第 " + httpFailStreak + " 次）：" + e);
    }
    return null;
}

// ============================================================
// 收消息：通知监听 -> 解析 -> 上报桥接服务
// 微信群通知格式（开「显示消息详情」时）：
//   标题 = 群名（可能带「(3条新消息)」后缀）
//   内容 = 发送者昵称: 消息正文（@机器人时正文里含 @机器人昵称）
// 私聊通知：标题 = 对方昵称，内容 = 消息正文。
// ============================================================
function cleanGroupTitle(title) {
    // 去掉「(N条新消息)」「[N条]」之类后缀
    return title.replace(/[\(\[]\d+条[^\]\)]*[\)\]]\s*$/, "").trim();
}

function parseNotification(n) {
    var title = (n.getTitle() || "").trim();
    var text = (n.getText() || "").trim();
    if (!title || !text) return null;
    if (text === "你收到了一条新消息" || text.indexOf("条新消息") >= 0 && text.length <= 8) {
        logx("⚠️ 通知没带正文：微信里要开「通知显示消息详情」，否则读不到内容");
        return null;
    }
    var group = cleanGroupTitle(title);
    // 群消息：正文以「昵称: 」开头；私聊：整段都是正文
    var m = text.match(/^([^:：]{1,24})[:：]\s*([\s\S]*)$/);
    var inWhitelist = CONFIG.WHITELIST_GROUPS.indexOf(group) >= 0;
    if (m && (inWhitelist || CONFIG.WHITELIST_GROUPS.length === 0)) {
        // 有「昵称: 」前缀且标题像群名 -> 按群消息处理
        // （白名单为空的观察期无法区分群/私聊，默认按群记录，标题即群名）
        return { group: group, sender: m[1].trim(), content: m[2].trim(), isGroup: true };
    }
    if (m && !inWhitelist) {
        // 白名单非空且标题不在名单：可能是私聊（标题=对方昵称，正文带前缀的概率低），按私聊处理
        return { group: "", sender: title, content: text, isGroup: false };
    }
    // 无前缀：私聊（标题=发送者昵称）
    return { group: "", sender: title, content: text, isGroup: false };
}

function handleNotification(n) {
    if (n.getPackageName() !== WECHAT_PKG) return;
    var parsed = parseNotification(n);
    if (!parsed || !parsed.content) return;

    // 白名单过滤：名单非空时，只处理名单内的群（私聊按 FORWARD_PRIVATE 决定）
    if (parsed.isGroup) {
        knownGroups[parsed.group] = true;
        lastNotification[parsed.group] = n;
        if (CONFIG.WHITELIST_GROUPS.length > 0 && !knownGroups[parsed.group]) return;
        if (CONFIG.WHITELIST_GROUPS.length > 0 && CONFIG.WHITELIST_GROUPS.indexOf(parsed.group) < 0) return;
    } else if (!CONFIG.FORWARD_PRIVATE && !CONFIG.OBSERVE_ONLY) {
        return;
    }

    // @ 判定 + 剥掉 @机器人 部分（桥那边的路由按「@后正文」处理，和其他传输层一致）
    var atBot = false;
    var content = parsed.content;
    var atMark = "@" + CONFIG.BOT_NICKNAME;
    if (content.indexOf(atMark) >= 0) {
        atBot = true;
        content = content.split(atMark).join(" ").replace(/[\u2005\s]+/g, " ").trim();
    }

    var isSelf = parsed.sender === CONFIG.BOT_NICKNAME;

    // 去重：同一条消息微信会更新/重推通知，按 群+发送者+内容+分钟 做键
    var key = hashStr(parsed.group + "|" + parsed.sender + "|" + content + "|" + Math.floor(nowMs() / 60000));
    if (seenMsgKeys[key]) return;
    seenMsgKeys[key] = nowMs();

    var payload = {
        group: parsed.isGroup ? parsed.group : "",
        sender: parsed.sender,
        content: content,
        at_bot: atBot,
        is_self: isSelf,
        observe: CONFIG.OBSERVE_ONLY,
        msg_id: key,
    };

    // 网络请求放子线程，别堵事件分发
    threads.start(function () {
        var res = postJson("/msg", payload);
        if (res && res.replies) {
            for (var i = 0; i < res.replies.length; i++) enqueueReply(res.replies[i]);
        }
    });
}

// ============================================================
// 发消息：队列 + 单工作线程 + 每群限频
// ============================================================
function enqueueReply(reply) {
    if (!reply || !reply.id || seenReplyIds[reply.id]) return;
    seenReplyIds[reply.id] = true;
    sendQueue.push(reply);
    logx("回复入队：群=" + reply.group + " 内容=" + String(reply.text).substring(0, 30));
}

function ackReplies(ids) {
    threads.start(function () { postJson("/ack", { ids: ids }); });
}

// 打开某个群的聊天界面：优先点最近一条该群通知（最可靠），否则走微信搜索
function openGroupChat(group) {
    if (currentPackage() === WECHAT_PKG) {
        // 已在该群聊天页就直接用（聊天页顶部标题即群名，可能带人数后缀）
        var titleNode = text(group).findOne(300);
        if (titleNode) return true;
    }
    var n = lastNotification[group];
    if (n) {
        try { n.click(); sleep(1500); return currentPackage() === WECHAT_PKG; } catch (e) { logx("点通知进群失败：" + e); }
    }
    // 搜索兜底：回微信主页 -> 点搜索 -> 输群名 -> 点第一个同名结果
    app.launchPackage(WECHAT_PKG);
    sleep(1500);
    for (var i = 0; i < 4; i++) { back(); sleep(400); }  // 尽量退回主页
    var searchBtn = desc("搜索").findOne(2000) || text("搜索").findOne(1000);
    if (searchBtn) { searchBtn.click(); sleep(1000); }
    var searchBox = className("android.widget.EditText").findOne(2000);
    if (!searchBox) { logx("搜索框没找到，进群失败"); return false; }
    searchBox.setText(group);
    sleep(1200);
    var item = text(group).findOne(2500);
    if (!item) { logx("搜索结果里没找到群：" + group); return false; }
    item.click();
    sleep(1500);
    return true;
}

// 在当前聊天页把一条回复发出去（无障碍：找输入框 -> 输入 -> 点发送）
function sendInCurrentChat(reply) {
    var input = className("android.widget.EditText").findOne(3000);
    if (!input) { logx("输入框没找到，发送失败"); return false; }
    input.click();
    sleep(300);
    var textToSend = reply.text;
    if (reply.at) {
        // 真 @ 要从弹出列表里选人：先输 @昵称，点列表里的同名项，再补正文
        input.setText("@" + reply.at);
        sleep(900);
        var person = text(reply.at).findOne(1500);
        if (person) {
            person.click();
            sleep(400);
            input = className("android.widget.EditText").findOne(1500) || input;
            var cur = "";
            try { cur = input.text() || ""; } catch (e) { }
            input.setText(cur + " " + textToSend);
        } else {
            // 列表没出来就退化成纯文本 @（对方看得到名字，只是不会震动提醒）
            input.setText("@" + reply.at + " " + textToSend);
        }
    } else {
        input.setText(textToSend);
    }
    sleep(300);
    var sendBtn = text("发送").findOne(2500);
    if (!sendBtn) { logx("发送按钮没找到"); return false; }
    sendBtn.click();
    sleep(600);
    return true;
}

function sendWorkerLoop() {
    while (true) {
        var reply = sendQueue.shift();
        if (!reply) { sleep(500); continue; }
        if (CONFIG.OBSERVE_ONLY) { logx("观察模式：不发送，仅记录 -> " + reply.text); ackReplies([reply.id]); continue; }
        // 每群限频：距上次发送不足 10 秒就等满
        var last = lastSendAt[reply.group] || 0;
        var wait = CONFIG.SEND_MIN_INTERVAL_MS - (nowMs() - last);
        if (wait > 0) sleep(wait);
        var ok = false;
        try {
            if (openGroupChat(reply.group)) ok = sendInCurrentChat(reply);
        } catch (e) {
            logx("发送异常：" + e);
        }
        lastSendAt[reply.group] = nowMs();
        if (ok) {
            logx("已发送到群「" + reply.group + "」：" + String(reply.text).substring(0, 30));
            ackReplies([reply.id]);
        } else {
            // 发送失败不 ack：下个轮询周期 /pending 会再下发重试（seenReplyIds 先清掉本条）
            delete seenReplyIds[reply.id];
            logx("发送失败，待轮询重试：" + reply.id);
        }
    }
}

// ============================================================
// 轮询补漏 + 心跳（断线自动重连：失败只记日志、退避后继续）
// ============================================================
function pollLoop() {
    while (true) {
        var groups = Object.keys(knownGroups);
        for (var i = 0; i < groups.length; i++) {
            var res = getJson("/pending?group=" + encodeURIComponent(groups[i]));
            if (res && res.replies) {
                for (var j = 0; j < res.replies.length; j++) enqueueReply(res.replies[j]);
            }
        }
        var backoff = Math.min(httpFailStreak * 2000, 30000);
        sleep(CONFIG.POLL_INTERVAL_MS + backoff);
    }
}

function heartbeatLoop() {
    var dev = device.brand + " " + device.model + " / Android " + device.release;
    while (true) {
        postJson("/heartbeat", { device: dev });
        sleep(CONFIG.HEARTBEAT_INTERVAL_MS);
    }
}

// ============================================================
// 主入口
// ============================================================
function main() {
    logx("脚本启动：桥=" + CONFIG.BRIDGE_URL + " 观察模式=" + CONFIG.OBSERVE_ONLY);
    auto.waitFor();  // 等无障碍服务开启（没开会停在这里，手机上按提示去开）
    logx("无障碍已就绪");
    events.observeNotification();
    events.on("notification", handleNotification);
    logx("通知监听已开启，等待微信消息…");
    threads.start(sendWorkerLoop);
    threads.start(pollLoop);
    threads.start(heartbeatLoop);
    // 保持脚本常驻（定时器占住主线程，事件回调照常分发）
    setInterval(function () { }, 60000);
}

main();
