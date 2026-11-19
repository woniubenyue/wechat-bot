# 微信群机器人 · 安卓 AutoX.js 路线（不 root、不降版）

FlowBot 要把微信降到 8.0.66，用户拒绝，所以换这条路线：

```
微信群消息 ──通知──> 手机 AutoX.js 脚本 bot.js ──POST──> 服务器 bridge.py
                                                          │ 复用现有机器人逻辑
                                                          │ (handlers.py 点歌/天气/
                                                          │  抽签/统计/关键词/问答)
微信群    <──无障碍── 手机脚本打开群、输入、点发送 <──轮询取回复──┘
```

- 手机：vivo V2453A，微信 **8.0.80 保持不动**，不用 root，不改微信版本。
- 身份只认**昵称**（无障碍路线拿不到 wxid）：统计按昵称计；主人识别要在
  服务器 `config.yaml` 的 `owner_wxid` 里填 `ax_<你的群昵称>`（如 `ax_张三`）。
- 音乐卡片发不了（无障碍只能打字），点歌自动降级为「歌名 + 播放链接」纯文本。

文件清单（本目录）：

| 文件 | 作用 |
|---|---|
| `bot.js` | 手机端 AutoX.js 脚本：监听通知、解析消息、上报、取回复、无障碍发送 |
| `bridge.py` | 服务器桥接：手机消息 → 现有 BotCore 逻辑 → 回复队列（标准库 HTTP 服务；配置与统计复用上一级 `config.yaml` / `handlers.py`） |

---

## 一、服务器部署（InstaBox，一次性）

```bash
# 1) 把代码同步到 InstaBox 的 /data/home/wechat-bot/（含 android-autox/ 子目录）
# 2) 起桥接服务（GLM_API_KEY 只走环境变量，别写进任何文件）
cd /data/home/wechat-bot/android-autox
GLM_API_KEY=<智谱Key> BRIDGE_TOKEN=<自设一个口令> BRIDGE_PORT=9920 \
  nohup python3 bridge.py > bridge.log 2>&1 &
curl http://127.0.0.1:9920/health        # 返回 {"ok": true, ...} 即起来了

# 3) 用 cloudflared 免费隧道把 9920 暴露成 HTTPS（手机在外网也能连）
#    没装 cloudflared 先装（官方 deb/arm64 二进制均可）：
#    wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
#    sudo dpkg -i cloudflared-linux-amd64.deb
cloudflared tunnel --url http://127.0.0.1:9920
# 输出里有一行 https://xxxx.trycloudflare.com —— 这就是要填进手机脚本的桥接地址
```

注意：免费快速隧道的域名**每次重启都会变**，变了要同步改手机脚本里的
`BRIDGE_URL` 再重启脚本。要固定域名需 Cloudflare 账号绑自有域名建命名隧道（可选，以后再说）。
InstaBox 会休眠，隧道和桥接要随机器唤醒一起拉起（可并进现有看门狗流程）。

## 二、手机操作清单（照着点，共 14 步）

1. **装 AutoX.js**：手机浏览器打开官方仓库 Release 页
   https://github.com/aiselp/AutoX/releases ，下最新版（v7.2.4）的
   **arm64-v8a** 包安装（vivo V2453A 是 arm64；安装时允许「未知来源」）。
   仓库主页：https://github.com/aiselp/AutoX
2. 打开 AutoX.js，侧边栏把要用到的开关先认一下位置：无障碍服务、通知使用权、
   悬浮窗（后面几步逐个开）。
3. **微信设置**：微信 → 我 → 设置 → 新消息通知 → 打开「通知显示消息详情」；
   系统设置 → 通知 → 微信 → 允许通知、锁屏通知打开。（不开详情，脚本读不到内容）
4. **导入脚本**：把 `bot.js` 传到手机（微信文件传输助手/QQ/数据线都行），
   在 AutoX.js 首页点右上角「+」→ 导入，找到 bot.js 导入。
5. **改配置**：在 AutoX.js 里打开 bot.js，改最上面 CONFIG 区四项：
   `BRIDGE_URL` 填第一步拿到的 trycloudflare 域名；`BRIDGE_TOKEN` 填和服务器
   一样的口令；`BOT_NICKNAME` 填机器人小号在群里的昵称；其余先别动
   （`OBSERVE_ONLY` 保持 `true`，白名单先留空）。
6. **开无障碍**：AutoX.js 侧边栏点「无障碍服务」开关，按系统提示到
   设置 → 无障碍 → 已安装的服务 → AutoX.js → 开启。
7. **开通知使用权**：AutoX.js 侧边栏点「通知使用权」（或系统 设置 → 通知 →
   通知使用权）→ 勾选 AutoX.js → 允许。
8. **保活设置**（vivo 关键，不然脚本会被系统杀）：系统 设置 → 电池 →
   后台耗电管理 → AutoX.js → 允许后台高耗电；再到 设置 → 应用 → 自启动 →
   打开 AutoX.js 和微信的自启动。
9. **启动脚本**：AutoX.js 里点 bot.js 右边的运行（▶）按钮。控制台出现
   「通知监听已开启，等待微信消息…」即成功。这一步还是观察模式，不会回复。
10. **验证能收到**：用另一个号在目标群里发一句话（或让群友发），看 AutoX.js
    控制台有没有打印解析结果；服务器 `bridge.log` 里出现 `[观察] 群=… 发送者=…`
    就说明链路通了。
11. **填白名单**：停掉脚本，把 CONFIG 里 `WHITELIST_GROUPS` 填上要服务的群名
    （和微信里一字不差，如 `["家人群", "老同学"]`），保存。
12. **开回复**：把 `OBSERVE_ONLY` 改成 `false`，保存。
13. **重新运行脚本**，在群里发「点歌 晴天 周杰伦」实测：机器人应自动打开群、
    输入并发送歌名+链接。再试「天气 北京」「抽签」「发言榜」。
14. （可选）**设主人**：服务器 `config.yaml` 的 `owner_wxid` 填 `ax_<主人群昵称>`
    并重启 bridge.py，主人即可在群里用「闭嘴/开口/加词/发言榜」等指令；
    若还要用私聊指令，把脚本 CONFIG 的 `FORWARD_PRIVATE` 改 `true`。

日常使用：手机插电常开、微信小号保持登录、AutoX.js 脚本保持运行；
发消息时脚本会亮屏操作微信，那台手机就别同时手动用了。

## 三、本地测试结果（2026-11-19，本地沙箱实测）

- `node --check bot.js`：语法通过。`python3 -m py_compile bridge.py`：通过。
- bridge.py 本地起服务（端口 9920，未设 GLM_API_KEY），curl 模拟手机上报：
  - 「点歌 周杰伦 稻草人」→ 路由命中点歌；网易云公开搜索接口在沙箱直连返回
    加密串、解析失败，机器人按既有兜底回「点歌服务暂时打了个盹，稍后再试试～」
    （这是 handlers 既有行为，与桥接无关；InstaBox 上线后需再实测一次点歌）。
  - 普通问题「你好，你是谁」（at_bot=true，新发送者）→ 正确返回问答兜底文案
    「问答功能还没配置好，先玩点歌、天气、抽签吧～」（无 Key 时的预期行为），
    回复的 `at` 字段正确带回发送者昵称。同发送者 10 秒内连发会被既有限流
    拦下（实测确认生效）。
  - 关键词「资源在哪领」→ 正确返回资源站文案。
  - 「发言榜」→ 统计复用成功：按昵称出榜（小明 3 条 / 小刚 1 条 / 小红 1 条），
    观察模式的消息未被计入统计（符合设计）。
  - 观察模式上报（observe=true）→ 只记日志、返回空回复，确认不进路由。
  - `/pending?group=测试群` 能取到未确认回复；`/ack` 后队列正确减少；
    `/health` 正常。
- 未测（需真机）：通知解析对微信 8.0.80 通知格式的实际匹配、无障碍打开群/
  输入/发送的控件定位、vivo 保活实际效果。上真机先跑观察模式验证第 10 步。
