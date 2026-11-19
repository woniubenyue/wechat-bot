# 蜗牛奔月微信群机器人

挂在微信小号上的群机器人：点歌、AI 问答、关键词回复、天气、每日一签、入群欢迎、
群发言统计，再加主人认主与主人专属指令。逻辑层（handlers.py / stats.py）只依赖
传输接口（transport.py），默认传输是 GeWeChat（iPad 协议，Docker 跑在 Linux
云电脑上）；也保留 WeChatFerry 传输（Windows 挂微信时用）。

## 指令一览

| 指令 | 谁能用 | 作用 |
|---|---|---|
| `点歌 歌名 [歌手]` | 所有人 | 搜歌回播放链接（配了卡片来源时回音乐卡片） |
| 群里 @机器人 + 问题 / 私聊任意文本 | 所有人 | AI 问答（≤500 字） |
| `天气 城市` | 所有人 | 今日天气一句话 |
| `抽签` / `一签` | 所有人 | 今日一签 + 每日一签链接 |
| 发「资源 / 公众号 / 工具 / 道观」等词 | 所有人 | 关键词自动回复（词表在 config.yaml，主人可用「加词」追加） |
| `发言榜` / `今日榜` | 群里所有人 | 本群今日发言前 10 名 |
| `周榜` | 群里所有人 | 本群近 7 天发言前 10 名 |
| `我的发言` | 群里所有人 | 自己今日 + 累计条数 |
| `认主 <暗号>` | 未绑定时任何人（仅私聊） | 绑定主人，绑定后通道关闭 |
| `状态` | **仅主人** | 运行状态、已运行多久、今日已回复条数、静默群数 |
| `闭嘴` / `开口` | **仅主人**（群里发） | 本群静默开关：静默时除主人指令外不回任何消息 |
| `加词 关键词=回复内容` | **仅主人** | 新增/覆盖关键词回复，落盘保存、重启不丢 |
| `禁点歌`（群里 @ 对方）/ `禁点歌 wxid` | **仅主人** | 把对方加入点歌黑名单，对方点歌只回小黑屋文案 |
| `解禁点歌`（同上两种形式） | **仅主人** | 把对方移出点歌黑名单（仅运行时名单） |
| `导出统计` | **仅主人** | 当前群累计数据摘要 |
| `重置统计` | **仅主人** | 清空当前群统计数据 |

## 主人认主

主人识别**只认 wxid，不认昵称**（昵称可改、可重名，wxid 是唯一标识）：

1. 部署时先把 config.yaml 的 `bind_code` 改成随机 6 位数字（占位符 `000000`
   必须改掉，否则等于没设防），暗号只告诉主人本人，不要截图外传。
2. 机器人上线后，主人用自己的微信**私聊**机器人发 `认主 <暗号>`。
3. 机器人把发送者 wxid 写进 `owner.json`（state_dir 下）并即刻生效，暗号作废；
   之后任何人再发「认主」一律拒绝。config.yaml 的 `owner_wxid` 也可预填，
   owner.json 优先。

## 点歌黑名单

- 名单里的人发「点歌 …」不搜歌、不调接口，只回 config.yaml 的
  `blacklist_song_reply` 文案；把 `blacklist_song_silent` 设为 true 则静默不回。
- 名单两个来源合并生效：config.yaml 的 `blacklist_song` 静态名单 + 主人指令
  维护的运行时名单（落盘 `blacklist.json`，结构 `{"song": [wxid, …]}`，
  以后其他功能可往里加自己的数组）。
- 「解禁点歌」只能移除运行时名单；静态名单里的人要改 config 并重启才彻底解禁
  （机器人解禁时会提醒这一点）。
- 群里 @ 禁人靠 GeWeChat 回调的 atuserlist 定位 wxid；wcferry 取不到被 @ 者
  列表，该传输下请用「禁点歌 wxid」参数形式。

## 群发言统计

- 计数口径：按（群、发言人 wxid、日期）计数，存本地 SQLite `stats.db`；
  文本、图片、语音等任何类型的消息都算 1 条（类型分开记字段，榜单按总数排）。
- 榜单展示名用发言时事件里带的群昵称/备注（存最新值），取不到就显示 wxid 后 4 位。
- **限制（重要）：只能统计机器人进群之后、且机器人在线时收到的消息。**
  机器人进群之前的历史消息统计不到；**云电脑闲置暂停期间群里的发言机器人
  收不到、会漏记**，看门狗把云电脑拉起、机器人恢复在线后才继续统计。

## 安全阀

- 同一人 10 秒内最多回 1 次（防刷屏，也防被微信限制）。
- 不回机器人自己的消息、不回公众号消息。
- 群白名单（config.yaml `group_whitelist`）：留空 = 全部群生效，填了只在名单内回复。
  （发言统计不受白名单影响，进群后收到的都记。）
- 群静默（主人「闭嘴」）落盘 `muted_groups.json`，重启后仍生效。
- 所有接口/发送失败只记日志，不崩。

## 文件说明

| 文件 | 作用 |
|---|---|
| `bot.py` | 入口：装配 config / BotCore / 传输层，事件分发（欢迎、消息路由） |
| `transport.py` | 传输层接口：`send_text()` + 事件迭代（统一产出 handlers.Msg） |
| `gewechat_transport.py` | 默认传输：GeWeChat HTTP API + Webhook 回调服务 |
| `wcferry_transport.py` | 可选传输：WeChatFerry（仅 Windows） |
| `handlers.py` | 消息路由 + 全部功能逻辑（含认主、主人指令、静默、加词） |
| `stats.py` | 发言统计存储层（SQLite） |
| `config.yaml` | 配置：传输层、限流、白名单、主人、认主暗号、GeWeChat、模型/点歌/天气接口、关键词表、欢迎语、签文池 |
| `requirements.txt` | Python 依赖（requests / PyYAML；wcferry 单独装） |
| `test_router.py` | 路由自测（假传输 + 假 HTTP/模型）：`python3 test_router.py` |
| `test_stats.py` | 发言统计自测：`python3 test_stats.py` |
| `stats.db` / `owner.json` / `muted_groups.json` / `custom_keywords.json` / `blacklist.json` / `gewechat_app.json` / `login_qrcode.png` | 运行时生成在 state_dir：统计库、主人绑定、静默群、自定义词表、黑名单、GeWeChat 设备 id、登录二维码 |

状态目录由 config.yaml 的 `bot.state_dir` 决定（留空 = 程序目录；InstaBox
部署建议指到持久目录，别放在会被清理的临时盘上）。

## 部署：GeWeChat on InstaBox 云电脑（默认路线）

1. **起 GeWeChat 服务**：在 InstaBox 云电脑（Linux）装 Docker，拉起 GeWeChat
   兼容服务，API 监听 2531 端口，并生成/记下它的 API token。
   ⚠️ 原 GeWeChat 官方仓库已停止维护、官方镜像与文档下线——上线前务必确认所用
   服务的来源与版本，并按它的文档逐项核对下面「接口核对」清单。
2. **装机器人**：把本目录放到云电脑上，`pip install -r requirements.txt`。
3. **配环境变量**：`GLM_API_KEY`（问答模型 Key）、`GEWECHAT_TOKEN`（上一步的
   token）。Key 只放环境变量，绝不写进任何文件。
4. **改 config.yaml**：
   - `transport: "gewechat"`（默认即是）；
   - `bind_code` 改成随机 6 位数字；
   - `bot.state_dir` 指到持久目录；
   - `gewechat.base_url` 按服务地址填（同机默认 `http://127.0.0.1:2531/v2/api`）；
   - `gewechat.callback_url`：GeWeChat 要把消息 POST 到 bot 的回调服务
     （默认本机 9911 端口 `/callback`）。GeWeChat 在 Docker 里时 `127.0.0.1`
     指容器内部，必须填容器能访问到的宿主机地址
     （如 `http://host.docker.internal:9911/callback`）。
5. **启动并扫码**：`python3 bot.py`。首次运行会把登录二维码存到
   state_dir 下的 `login_qrcode.png`（日志里有路径，也会打印二维码链接），
   用**机器人小号**扫码并在手机上确认登录。登录态（appId）会落盘，
   重启一般不用重扫。
6. **主人认主**：主人用自己的微信加小号为好友，私聊发 `认主 <暗号>`，
   收到「认主成功」即完成。
7. **拉进群**：把小号拉进目标群即可用；要限制范围就把群 id 填进
   config.yaml 的 `group_whitelist`（群 id 可在 bot.log 里看）。

接口核对（gewechat_transport.py 头注有完整版）：
- 已查证：base 地址 `…:2531/v2/api`；发文本 `POST /message/postText`
  （body：appId/toWxid/content）；Webhook 回调结构与解析规则（TypeName/Data、
  `{"string": …}` 包装、群消息 `wxid:` 前缀藏发送者、MsgSource 的 atuserlist、
  NewMsgId 去重、3 秒内回 200）。
- **上线前按部署版本再核对**：`login/getLoginQrCode`、`login/checkLogin` 的
  状态枚举与返回字段、`login/setCallback`、`X-GEWE-TOKEN` 鉴权头、
  `personal/getProfile`、`group/getChatroomMemberList`（昵称）、
  `message/postLink`（卡片）与 postText 的 `ats` 参数名。对不上的只改
  gewechat_transport.py 一个文件，handlers/stats 不用动。

## 部署：WeChatFerry（可选，Windows）

Windows 电脑上登录微信小号后：`pip install wcferry`，把 config.yaml 的
`transport` 改成 `wcferry`（或设环境变量 `WECHAT_BOT_TRANSPORT=wcferry`），
运行 `python bot.py`。其余配置、认主流程与 GeWeChat 路线相同。

## 配置要点

- API Key 一律从环境变量读（默认 `GLM_API_KEY`、`GEWECHAT_TOKEN`），
  config.yaml 里只有占位说明，绝不写真实密钥。
- 模型可换：改 config.yaml 里 llm 的 `base_url` / `model` / `api_key_env`
  （智谱 GLM / 豆包 / Groq 都是 OpenAI 兼容接口）。

## 风险提示

- **只用闲置小号当机器人，主号绝对不要用**：非官方协议有被微信限制/封号的
  风险，风险只关在小号里；小号也别拿去发广告、刷屏。
- 发消息太频繁会被限制：已内置 10 秒/人限流，不要调得更激进。
- **云电脑暂停期间机器人不在线**：InstaBox 免费机闲置会自动暂停，暂停期间
  群消息不回复、发言统计漏记；靠看门狗定时拉起恢复，重要场合别完全依赖它。
- 认主暗号、GeWeChat token、模型 Key 都是秘密：不进群、不截图、不写进代码仓库。
