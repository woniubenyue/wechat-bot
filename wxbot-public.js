// ============================================================
// 蜗牛奔月 公众号机器人服务端（Supabase Edge Function / Deno 版）
// 由 wxbot.php 移植，行为与 PHP 版严格一致（明文模式）。
// 微信服务器把粉丝消息 POST 到本函数 URL，本函数实时回复 XML。
// 路由顺序：口令规则(rules.json 内嵌) → 点歌 → 天气 → 抽签 → 关键词 → AI问答 → 默认引导
// 与群机器人 ~/workspace/wechat-bot 的文案/签文保持一致（私聊场景版）。
// ============================================================

// ---------------- 配置（原 config.php，部署时内嵌） ----------------

const CONFIG = {
  // 公众号后台「设置与开发 → 基本配置 → 服务器配置」里的 Token，必须与后台填写的完全一致
  token: 'TOKEN_PLACEHOLDER',
  // 智谱 GLM API Key（AI 问答用）。留空 = 问答不调模型，直接回固定引导语。
  glm_api_key: '',
  // 智谱 OpenAI 兼容接口，一般不用改
  glm_base_url: 'https://open.bigmodel.cn/api/paas/v4',
  glm_model: 'glm-4-flash',
};

// Supabase 部署时可用环境变量 WXBOT_TOKEN 覆盖 token（公开代码仓库里只放占位符）
try { const t = Deno.env.get('WXBOT_TOKEN'); if (t) CONFIG.token = t; } catch (e) {}
// 同理，GLM_API_KEY 走环境变量（密钥不进代码仓库）
try { const k = Deno.env.get('GLM_API_KEY'); if (k) CONFIG.glm_api_key = k; } catch (e) {}

// ---------------- 固定文案（与 wechat-bot/config.yaml 对齐） ----------------

const FORTUNE_LINK = 'https://zhongyixuexi.rf.gd/qian.html';

const FORTUNES = [
  '上上签 · 云开见月明：守得云开见月明，万事顺遂，好事将近。',
  '上签 · 贵人相助：心诚则灵，步步稳进，今日有贵人缘。',
  '上签 · 春风得意：春风得意马蹄疾，想做的事大胆往前走。',
  '中上签 · 静水流深：不争不抢，好运自来，稳住就是赢。',
  '上签 · 耕耘有获：一分耕耘一分收获，脚踏实地必有回响。',
  '中上签 · 笑口常开：笑口常开，好运自来，烦恼靠边站。',
  '上签 · 柳暗花明：山重水复疑无路，柳暗花明又一村，转机就在前面。',
  '上上签 · 家和万事兴：和气生财，家和万事兴，今日宜和和气气。',
  '上签 · 顺风顺水：顺风顺水顺人意，得福得安得自在。',
  '中上签 · 慢工细活：慢工出细活，稳扎稳打，终有所成。',
  '上签 · 好事在路上：今日宜开心，忌焦虑，好事正在路上。',
  '上上签 · 星光不负：星光不负赶路人，时光不负有心人，坚持就有回报。',
];

// 与 PHP 版 KEYWORDS 一致（数组保序，路由时按关键词字节长降序）
const KEYWORD_ENTRIES = [
  ['资源', '蜗牛奔月资源站：https://wnby.rf.gd/ 软件、教程、快捷指令都在这儿，自取～'],
  ['公众号', '关注公众号「蜗牛奔月」，AI 教程和资源更新都在那儿发，微信里搜「蜗牛奔月」就能找到～'],
  ['工具', '先推小程序「AI小工具箱Pro」：九宫格切图、拼图、证件照裁剪、二维码、计算器合集都有，点公众号底部菜单「资源站 → 小工具箱」就能打开。网页版免费工具站：https://woniubenyue.github.io/（全本地运行、不上传数据）'],
  ['小程序', '小程序「AI小工具箱Pro」🧰 九宫格切图、长图拼图、证件照规格裁剪、二维码工具箱、计算器合集、倒数日、本地记账，全部免费、本地运行。打开方式：点公众号底部菜单「资源站 → 小工具箱」，或在微信里搜小程序「AI小工具箱Pro」。'],
  ['道观', '九九道观，进来坐坐：https://wnby.rf.gd/daoguan/ 里面还有《敲千山》和药田小游戏。'],
];
const KEYWORDS = Object.fromEntries(KEYWORD_ENTRIES);

// 默认引导语（AI 问答不可用/超时时的固定回复也用它）
const GUIDANCE = "我没太听懂，你可以这样找我玩：\n"
  + "🎵 点歌：发「点歌 歌名」，比如 点歌 晴天\n"
  + "🌤 天气：发「天气 城市」，比如 天气 北京\n"
  + "🎋 抽签：发「抽签」求今日一签\n"
  + "🎁 领资源：把文章里看到的口令直接发给我，或发「资源」\n"
  + "🧰 小工具：发「小程序」，或点底部菜单「资源站 → 小工具箱」\n"
  + "💬 问问题：直接把问题发给我就行";

const WELCOME = "欢迎关注「蜗牛奔月」！🎉\n"
  + "AI 教程、实用工具、资源更新都在这儿。\n"
  + "🎁 领资源：把文章里看到的口令直接发给我就行\n"
  + "🧰 免费小工具：点底部菜单「资源站 → 小工具箱」，切图、拼图、证件照、二维码都有\n"
  + "🎵 点歌：发「点歌 歌名」\n"
  + "🎋 每日一签：发「抽签」\n"
  + "💬 有问题直接发给我，我来答～";

const QA_SYSTEM_PROMPT = '你是公众号「蜗牛奔月」的小助手，回答简短、口语、友好，不超过 300 字，不编造事实。';

// ---------------- 口令规则（原 rules.json 全量内嵌，共 141 条） ----------------

const RULES_DATA = [{"keyword": "漫剧包", "match": "exact", "reply": "AI漫剧制作资料包在这里，点链接保存到夸克网盘下载：https://pan.quark.cn/s/ebde7829eae7 永久有效，无提取码。包里有分镜表模板、角色卡模板、提示词库、全流程手册，照着做。卡在哪一步，回来留言问我。"}, {"keyword": "漫剧", "match": "exact", "reply": "AI漫剧模板来了，复制就能用：每行一个镜头，6列：镜头号｜景别（远/中/近/特写）｜人物｜动作｜对白（15字内）｜时长（秒）。60秒一集约8个镜头，结尾镜头留钩子。每个角色一行：年龄｜发型｜服装｜常用道具｜性格。出图时把角色卡原样复制进提示词，再固定同一个种子值，人物不换脸。场景+角色卡+动作+光线+风格词；负面词：模糊、多手指、变形、文字错误。完整教程在公众号历史文章和资源站 wnby.rf.gd 里都有。"}, {"keyword": "蜗牛源", "match": "exact", "reply": "蜗牛奔月源改一人一码了：个人码私聊管理员或在QQ频道（pd09917598）找站长领取；拿到码打开https://wnby.rf.gd/source/claim.html输入个人码，就能生成你的专属源链接（30天有效）。"}, {"keyword": "Mika", "match": "exact", "reply": "🤖Mika安卓智能体（开源免费）不用Root、不用电脑，装上就能一句话指挥手机干活：在后台虚拟屏上替你操作App和网页。项目地址（GitHub，APK在Releases里下）：https://github.com/wangzan101/Mika 要求：安卓11以上能用，操控App要安卓12以上、14体验最佳；装好后在设置-模型里填一家模型API Key（DeepSeek/通义/Kimi/智谱都有预置）"}, {"keyword": "盘点", "match": "exact", "reply": "本周 AI 大事清单👇 1️⃣谷歌 Gemini 4 Carbon 发布，登顶智能指数榜首，先给安全研究员找漏洞用 2️⃣谷歌 Genie 4 预览：一句话生成能走进去互动的虚拟世界 3️⃣国产 Kimi K3.1 Pro 冲进全球第一梯队，编程评测紧咬 Claude，11月4日开放权重 4️⃣Claude 母公司 Anthropic 递交上市申请，AI 行业开始排队敲钟 5️⃣安全课：假 Claude Code 扩展混进 Cursor 市场约 5000 人中招，干净版本 2.1.314，自查 ~/.ssh/authorized_keys 有没有 svc-telemetry 详细版看公众号今天的文章《5件大事一次盘清》"}, {"keyword": "巨魔收尾", "match": "exact", "reply": "巨魔商店装好后·收尾清单👇1️⃣设持久性助手：打开巨魔商店设置→Install Persistence Helper→选系统应用「提示」；以后应用打不开了，打开「提示」点Refresh App Registrations就恢复2️⃣检查巨魔商店自身更新，更新前先确认持久性助手可用3️⃣装Filza文件管理器（只看，别乱删系统文件）4️⃣装Apps Manager，给重要应用先备份一份数据⚠️三个别犯：别手痒升级系统、应用打不开别卸载重装、别信来路不明的「一键安装」详细版看公众号今天的文章《4件事先做完：巨魔商店装好了，先别急着装应用》"}, {"keyword": "皮卡车", "match": "exact", "reply": "PKC皮卡车（微信增强插件）👇PKC皮卡车官方源已下线，作者改为Telegram频道发包：t.me/TopStyle2021，站内『皮卡车』行有deb直装包更新发布：Telegram频道「PKC皮卡车」有越狱deb版（分有根/无根）和注入版dylib两种装法，插件内可备份、导入配置文件。微信插件有封号风险，先拿小号试。更多资源在资源站 wnby.rf.gd"}, {"keyword": "越狱源", "match": "exact", "reply": "越狱插件源（Sileo/Cydia里添加）👇大老板：apt.thebigboss.org/repofiles/cydia Chariz：repo.chariz.com Havoc：havoc.app opa334 本人源：opa334.github.io 在软件源页点+号粘贴地址即可。源不在多，这几个够用；Packix、Dynastic 存档源在资源站列表里。更多资源在资源站 wnby.rf.gd"}, {"keyword": "软件源", "match": "exact", "reply": "侧载应用源（AltStore / SideStore / Feather 都能加）👇官方源：apps.altstore.io 社区源：community-apps.sidestore.io/sidecommunity.json 量子源：quarksources.github.io/quantumsource.json 把地址粘贴到侧载工具的「源」里添加。来路不明的源别乱加，认准官方和社区源。更多资源在资源站 wnby.rf.gd"}, {"keyword": "书库", "match": "exact", "reply": "📚中医经典书库打包来了（20部）👇https://pan.quark.cn/s/e35a062339f2里面有：《黄帝内经》《伤寒论》《金匮要略》《神农本草经》《难经》《灵枢》《脉经》《备急千金要方》《针灸大成》《医学三字经》《药性赋》《濒湖脉学》《汤头歌诀》《四言脉诀》等选读，原文+导读，txt版，手机电脑都能看。点链接存到自己网盘就能慢慢读。在线版在博客「医学学习笔记」书库页，回复「文库」还能拿手机App版。学习交流用，不构成医疗建议。"}, {"keyword": "管理器", "match": "exact", "reply": "MT管理器👇官网mt2.ikk.me；应用市场搜「MT管理器」也能下 安卓文件管理加APK分析、改签名的老牌工具。注意只用官网或应用市场正规渠道，别用来路不明的改版（带毒风险）；基础功能免费，VIP付费。更多资源在资源站 wnby.rf.gd"}, {"keyword": "权限管", "match": "exact", "reply": "AppOps👇https://appops.rikka.app也有应用市场版精细管理每个应用的权限，不用Root（配合Shizuku）。高级版付费解锁。更多资源在资源站wnby.rf.gd"}, {"keyword": "终端", "match": "exact", "reply": "Termux👇https://github.com/termux/termux-app/releases安卓上的Linux终端，玩命令行、跑脚本用。注意：不要装Google Play里的，那个是停更老版；GitHub版和F-Droid版签名不同，别混着装。更多资源在资源站 wnby.rf.gd"}, {"keyword": "开源店", "match": "exact", "reply": "F-Droid👇https://f-droid.org开源应用商店，里面的应用免费无广告。更新比应用商店慢几天属正常。只认官网f-droid.org。更多资源在资源站wnby.rf.gd"}, {"keyword": "跳广告", "match": "exact", "reply": "GKD👇https://github.com/gkd-kit/gkd/releases安卓自动跳过开屏广告、点掉青少年弹窗的神器。注意：装好后要导入规则订阅才起作用；只装GitHub官方版，别装改版。更多资源在资源站 wnby.rf.gd"}, {"keyword": "冰箱", "match": "exact", "reply": "冰箱IceBox👇官网 catchingnow.com 把不常用的应用冻起来省电省空间。需要Root，或者用Shizuku、电脑ADB激活；免费版能冻的数量有限。更多资源在资源站 wnby.rf.gd"}, {"keyword": "黑阈", "match": "exact", "reply": "黑阈 Brevent👇官网 brevent.jianyu.io，也可从 Google Play 搜 me.piebridge.brevent 不用 Root 就能压住应用后台唤醒，省电神器。只从官网或 Play 下；高级功能是付费解锁的。更多资源在资源站 wnby.rf.gd"}, {"keyword": "权限桥", "match": "exact", "reply": "Shizuku👇https://github.com/RikkaApps/Shizuku/releases不用Root也能给应用开高级权限的桥，很多玩机应用都靠它。每次重启手机要重新启动它一次，属正常现象。更多资源在资源站 wnby.rf.gd"}, {"keyword": "框架", "match": "exact", "reply": "LSPosed👇https://github.com/LSPosed/LSPosed最常用的Xposed框架实现。注意：原版已停更（最后一版1.9.2），新系统安卓15、16优先用接棒的Vector版（JingMatrix发布），老系统用原版没问题。更多资源在资源站 wnby.rf.gd"}, {"keyword": "补丁", "match": "exact", "reply": "APatch👇https://github.com/bmax121/APatch/releases直接给内核打补丁的Root方案，支持内核3.18到6.12的ARM64设备。超级密钥务必自己保管好。更多资源在资源站 wnby.rf.gd"}, {"keyword": "内核苏", "match": "exact", "reply": "KernelSU👇https://github.com/tiann/KernelSU/releases工作在内核层的Root方案，藏得比传统方式深，要GKI 2.0内核的设备；新版本用模块要配metamodule，先看说明再动手。更多资源在资源站 wnby.rf.gd"}, {"keyword": "面具", "match": "exact", "reply": "Magisk面具👇https://github.com/topjohnwu/Magisk/releases安卓Root管理器，修补boot镜像刷入。装前先备份原厂boot镜像；部分银行类App会查Root，先想好再装。更多资源在资源站 wnby.rf.gd"}, {"keyword": "视窗", "match": "exact", "reply": "WinRa1n👇https://ikeytools.com已停更，Windows上的图形界面工具，把checkra1n和palera1n打包成点点鼠标就能用，仅限A11及更老机型。注意电脑要装iTunes驱动。更多资源在资源站 wnby.rf.gd"}, {"keyword": "奥德赛", "match": "exact", "reply": "Odyssey👇https://theodyssey.dev已停更，iOS13到13.7的老方案。只认团队官网。更多资源在资源站wnby.rf.gd"}, {"keyword": "排盘", "match": "exact", "reply": "🧭紫微斗数在线排盘（免口令，直接用）👇https://zhongyixuexi.rf.gd/ziwei.html?v=5输入出生年月日时就能排：命宫、身宫、十二宫主星、四化、命主身主全开放。传统文化学习工具，图个了解已，不作寿命依据。更多小工具：每日一签、周公解梦都在博客首页。"}, {"keyword": "藏多巴", "match": "exact", "reply": "Dopamine RootHide版👇https://github.com/roothide/Dopamine2-roothide在原版基础上把路径随机化，藏痕迹更强。注意：别和Dopamine本体混装，插件只装roothide适配版。更多资源在资源站 wnby.rf.gd"}, {"keyword": "牛磺", "match": "exact", "reply": "Taurine👇https://theodyssey.dev已停更，iOS14到14.8.1的半折腾方案。只认团队官网theodyssey.dev。更多资源在资源站 wnby.rf.gd"}, {"keyword": "优扣", "match": "exact", "reply": "unc0ver👇https://unc0ver.dev已停更，支持iOS11到14.3，新一点的A12、A13机型到14.8。只认官网，别下到山寨包。更多资源在资源站wnby.rf.gd"}, {"keyword": "切克", "match": "exact", "reply": "checkra1n👇https://checkra.in老牌工具，2019年的经典之作，已停更，支持iOS12到14.8.1。注意：网上所谓Windows版、支持15以上的版本全是假站，只认官网。更多资源在资源站 wnby.rf.gd"}, {"keyword": "帕拉", "match": "exact", "reply": "palera1n👇https://palera.in给A8到A11老机型用的工具，支持iOS15到18点几。注意：A11机型用的时候要关锁屏密码。装前先看官方文档对照机型。更多资源在资源站 wnby.rf.gd"}, {"keyword": "电池报告", "match": "exact", "reply": "电池报告快捷指令在这👇（Battery Report）https://routinehub.co/shortcut/19090/打开页面点Download添加。先在「设置→隐私与安全性→分析与改进」里打开「共享iPhone分析」，等系统生成分析文件后再转存它运行，电池的设计容量、循环次数、温度、真实健康度，一份报告全看清。更多资源在资源站 wnby.rf.gd"}, {"keyword": "应用锁", "match": "exact", "reply": "应用锁快捷指令换新版了👇（FaceIDAppLocker）https://routinehub.co/shortcut/14701/打开页面点Download添加（需要iOS16.4以上），再按页面说明建一个「打开某 App 时运行它」的自动化，就能给任意 App 加一道 Face ID 锁，手机借给别人也不怕翻隐私。更多资源在资源站 wnby.rf.gd"}, {"keyword": "录音转字", "match": "exact", "reply": "录音转文字👇https://routinehub.co/shortcut/21807/会议、采访录音自动转成文字稿，省得手动听打。提醒：它用OpenAI的语音接口，要自备API Key按分钟付费，录音会上传，敏感内容别用。更多资源在资源站 wnby.rf.gd"}, {"keyword": "图片文档", "match": "exact", "reply": "图片转PDF文档👇https://routinehub.co/shortcut/2604/把照片、截图一键转成PDF发人，办公传资料方便。2019年的老指令，系统太新若报错就先放一放。更多资源在资源站 wnby.rf.gd"}, {"keyword": "充电音", "match": "exact", "reply": "充电提示音快捷指令在这👇（customchargingsound）https://routinehub.co/shortcut/13615/打开页面点Download添加，按指令里的教程放好想用的声音，再建一个「充电器连接时运行它」的自动化，插上充电器就会播你自己选的声音，告别单调的默认提示音。更多资源在资源站 wnby.rf.gd"}, {"keyword": "长截图", "match": "exact", "reply": "滚动长截图快捷指令在这👇（Save Full Page PDF as Long Image）https://routinehub.co/shortcut/14404/打开页面点Download添加。在Safari里截「整页」后，从分享菜单把PDF交给它运行，就能拼成长图存进相册，长文章、聊天记录一图到底。更多资源在资源站 wnby.rf.gd"}, {"keyword": "巨魔盒", "match": "exact", "reply": "Geranium👇https://github.com/c22dev/Geranium巨魔全能工具箱：虚拟定位、守护进程管理、清残留文件一站搞定。需要iOS15以上＋巨魔商店1.3以上。更多资源在资源站 wnby.rf.gd"}, {"keyword": "导出包", "match": "exact", "reply": "TrollDecrypt👇https://github.com/donato-fiore/TrollDecrypt/releases在手机上把已装App导出成IPA包，自己备份、研究用。导出的包仅供自己备份研究，勿外传。更多资源在资源站 wnby.rf.gd"}, {"keyword": "调光灯", "match": "exact", "reply": "TrollLEDs👇作者源poomsmart.github.io/repo，安装包在GitHub项目PoomSmart/TrollLEDs里拿能单独调每一颗闪光灯的亮度和色温，拍照补光更细。注意：iPhone 14系列及更新机型不支持。更多资源在资源站 wnby.rf.gd"}, {"keyword": "血清素", "match": "exact", "reply": "Serotonin👇https://github.com/mineek/Serotonin/releases iOS16时代的半折腾工具，配合「藏根」（Bootstrap）给系统装插件。已停更，新设备先看系统定制板块对照版本。更多资源在资源站 wnby.rf.gd"}, {"keyword": "藏根", "match": "exact", "reply": "RootHide Bootstrap👇https://github.com/RootHide/Bootstrap/releases不完整折腾的插件底座，装插件、改应用，藏痕迹做得比较好。个别银行、游戏类App仍可能检测，重要账号留意。更多资源在资源站 wnby.rf.gd"}, {"keyword": "米坂改", "match": "exact", "reply": "misaka26👇https://github.com/straight-tamago/misaka26 Mac上的系统定制工具，能开40多个隐藏开关，仅支持macOS。更多资源在资源站 wnby.rf.gd"}, {"keyword": "稀疏盒", "match": "exact", "reply": "SparseBox👇https://github.com/khanhduytran0/SparseBox Nugget的手机版同类工具，手机上直接改系统设置。先备份再玩。更多资源在资源站 wnby.rf.gd"}, {"keyword": "小金块", "match": "exact", "reply": "Nugget👇https://github.com/leminlimez/Nugget/releases不用完整折腾，开灵动岛、改状态栏、开隐藏功能。改系统文件有风险，动手前先整机备份。更多资源在资源站 wnby.rf.gd"}, {"keyword": "装巨魔", "match": "exact", "reply": "TrollRestore👇https://github.com/JJTech0130/TrollRestore/releases给iOS17.0装巨魔商店的主力方法，电脑端运行。装前先看教程、关掉「查找我的iPhone」。更多资源在资源站 wnby.rf.gd"}, {"keyword": "容器", "match": "exact", "reply": "LiveContainer来了👇https://github.com/LiveContainer/LiveContainer/releases一个壳里装多个App，免签跑IPA、还能多开。只认GitHub官方仓库下载。更多资源在资源站 wnby.rf.gd"}, {"keyword": "羽毛签", "match": "exact", "reply": "Feather羽毛签👇https://github.com/claration/Feather/releases开源手机端签名工具，不用电脑就能签名装App。配开发者证书效果最好。更多资源在资源站wnby.rf.gd"}, {"keyword": "阿尔商店", "match": "exact", "reply": "AltStore侧载商店👇https://altstore.io装好后能在手机里直接装IPA、自动续签。和SideStore二选一即可，同样有7天续签限制。更多资源在资源站wnby.rf.gd"}, {"keyword": "电脑装包", "match": "exact", "reply": "Sideloadly电脑装包👇https://sideloadly.io电脑上把IPA拖进去、用自己的苹果账号就能装到手机。注意：免费账号签的App只有7天有效期，到期连电脑重签。更多资源在资源站 wnby.rf.gd"}, {"keyword": "资源站", "match": "exact", "reply": "蜗牛奔月资源站👇https://wnby.rf.gd/软件、教程、快捷指令、巨魔工具都在里面，持续更新。点开按分类找，要下载时在公众号回复对应口令即可。"}, {"keyword": "文库", "match": "exact", "reply": "中医学文库App（安卓）👇https://pan.quark.cn/s/c3072ce30307 20部中医经典＋18篇医案笔记＋5门视频课程，免费无广告、无需联网。新版还带紫微斗数排盘（在App里输码解锁，码在公众号回复「排盘」拿）。下载后点开安装即可，学习交流用。"}, {"keyword": "穴位图", "match": "exact", "reply": "人体穴位经络大图来了👇（超高清版）https://pan.quark.cn/s/1b0e71383d5a先存到你自己的网盘再打开看，图很大，放大不糊；打印出来贴墙上，对照着找穴位很方便。小提示：这是学习参考图，认穴位、认经络走向用，别当看病依据。更多资源在资源站 wnby.rf.gd"}, {"keyword": "应用分身", "match": "exact", "reply": "应用分身（TrollAppDuplicator）没有直链，是这样装的👇先装好巨魔（TrollStore），再在巨魔里添加Havoc源，在源里搜TrollAppDuplicator（应用分身），直接安装就行，免费的。装好后给应用改个包名就能复制出分身，同一台手机多账号一起用（支持iOS 15-17）。小提示：分身和原版数据不互通，重要账号先想好哪个当主力。更多资源在资源站 wnby.rf.gd"}, {"keyword": "虚拟定位", "match": "exact", "reply": "Wloc虚拟定位是开源工具，官方只放源码，没有现成安装包👇https://github.com/bennix/WLOC小提示：需要自己签名编译后才能装（要有开发者签名工具或证书），动手能力强的再折腾；嫌麻烦的先收藏，等有成品版我们再上架。更多资源在资源站 wnby.rf.gd"}, {"keyword": "巨魔增强", "match": "exact", "reply": "TrollStore增强版在这👇（暂行页面，点进去按页面说明下载）https://lin.mrlin.vip/index.php?m=home&c=View&a=index&aid=3987它是应用降级、屏蔽更新、换图标的大集合，装的时候会覆盖原版TrollStore，先看清页面说明再下。小提示：这个文件走该站自己的网盘通道，暂不支持夸克转存，介意的等我们这边上架网盘版再来。更多资源在资源站 wnby.rf.gd"}, {"keyword": "安卓模拟", "match": "exact", "reply": "Husk安卓模拟在这👇（先给官方发布页，挑最新版的Husk.ipa下载，后续换成网盘直链）https://github.com/Leviidev/Husk/releases小提示：它是在iPhone上直接跑安卓应用和游戏的，iOS 16以上、自动或巨魔都能装；运行前记得先开JIT（可配合本站「即时编译」那个工具）。更多资源在资源站 wnby.rf.gd"}, {"keyword": "自查", "match": "exact", "reply": "iPhone省钱自查清单来了👇https://pan.quark.cn/s/c486e9048700就一页，照着挨个查：订阅、微信/支付宝自动扣款、话费增值业务，不用的当场关。小提示：先存到你自己的网盘再打开看，查的时候手机就在手边，一步步对着来。更多资源在资源站 wnby.rf.gd"}, {"keyword": "智能体", "match": "exact", "reply": "Muse智能体资料包来了👇https://pan.quark.cn/s/8e393c986a94里面是注册方法+3个开局任务模板+实测记录，照着走20分钟能上手。小提示：先存到你自己的网盘再解压，邀请码在教程正文的注册步骤里，别漏填。更多资源在资源站 wnby.rf.gd"}, {"keyword": "九宫格", "match": "exact", "reply": "九宫格切图快捷指令换新版了👇（InstagramImageSplitter）https://routinehub.co/shortcut/3341/打开页面点Download添加，选一张正方形图运行，自动切成九格，按顺序发朋友圈就行。嫌装指令麻烦的，资源站wnby.rf.gd的「在线工具」里也有九宫格切图，网页打开直接切。更多资源在资源站 wnby.rf.gd"}, {"keyword": "相机水印", "match": "exact", "reply": "照片加水印快捷指令换新版了👇（Watermark Pro）https://routinehub.co/shortcut/23254/打开页面点Download添加。先备一张水印图（徕卡、哈苏、iPhone字样图都行），选照片运行，就能把水印贴到照片任意位置，相机机款效果自己搭。更多资源在资源站 wnby.rf.gd"}, {"keyword": "带壳截图", "match": "exact", "reply": "带壳截图快捷指令换新版了👇（Screenshot Framer）https://routinehub.co/shortcut/8067/打开页面点Download添加，选一张截图运行，就能套上iPhone、iPad的机型外壳，边框颜色也能换，发朋友圈更好看。更多资源在资源站 wnby.rf.gd"}, {"keyword": "电池", "match": "exact", "reply": "电池寿命查询快捷指令换新版了👇（BatteryReport）https://routinehub.co/shortcut/19090/打开页面点Download添加。先去「设置→隐私与安全性→分析与改进」打开「共享iPhone分析」，等系统生成分析文件后，把最新的Analytics文件分享给它运行，就能看电池设计容量、循环次数、温度和真实健康度。更多资源在资源站 wnby.rf.gd"}, {"keyword": "去水印", "match": "exact", "reply": "短视频去水印快捷指令换新版了👇（UltimateMediaDownloader）https://routinehub.co/shortcut/7041/打开页面点Download添加，复制视频链接后运行，常见短视频平台的视频、图片都能存下来。它是跳转到下载站保存的，页面上弹出的广告关掉就行，别点任何安装提示。更多资源在资源站 wnby.rf.gd"}, {"keyword": "快捷指令", "match": "exact", "reply": "快捷指令合集来了，5个都在这，点哪个装哪个👇1️⃣短视频去水印：https://routinehub.co/shortcut/7041/2️⃣电池寿命查询：https://routinehub.co/shortcut/19090/3️⃣带壳截图：https://routinehub.co/shortcut/8067/\n\n4️⃣相机水印：https://routinehub.co/shortcut/23254/5️⃣九宫格切图：https://routinehub.co/shortcut/3341/小提示：打开页面点Download就能添加，第一次运行记得允许权限。更多资源在资源站 wnby.rf.gd"}, {"keyword": "插件注入", "match": "exact", "reply": "TrollFools插件注入工具在这👇https://pan.quark.cn/s/7aee57f213cb先存到你自己的网盘再下载，巨魔版（.tipa），用TrollStore安装，需要先装好巨魔。小提示：注入前先备份原App，插件和App版本对不上容易闪退，一个一个试。更多资源在资源站 wnby.rf.gd"}, {"keyword": "多巴胺", "match": "exact", "reply": "Dopamine在这👇https://pan.quark.cn/s/2b3a8e698628先存到你自己的网盘再下载。小提示：先核对你的机型和系统版本再装（iOS 15.0–26.0.1 按芯片分档，不是所有机型都到顶），版本对不上别硬装。更多资源在资源站 wnby.rf.gd"}, {"keyword": "即时编译", "match": "exact", "reply": "StikDebug在这👇https://pan.quark.cn/s/051a7884cb6d先存到你自己的网盘再下载，自签或巨魔都能装。小提示：它是在手机上给侧载应用开JIT的，玩模拟器、虚拟机卡顿先开它；第一次用要按提示配对一次，之后不用连电脑。更多资源在资源站 wnby.rf.gd"}, {"keyword": "网速", "match": "exact", "reply": "TrollSpeed网速悬浮窗在这👇https://pan.quark.cn/s/1ffbb683269f先存到你自己的网盘再下载，巨魔版（.tipa），用TrollStore安装。小提示：装好后在设置里打开悬浮窗，实时网速就挂在屏幕角上了。更多资源在资源站 wnby.rf.gd"}, {"keyword": "应用降级", "match": "exact", "reply": "AppStore++应用降级工具在这👇https://pan.quark.cn/s/3cfbb172d69b先存到你自己的网盘再下载，这是巨魔版（.tipa），用TrollStore安装。小提示：降级前先备份App数据，有些App旧版登录会要重新验证。更多资源在资源站 wnby.rf.gd"}, {"keyword": "文件管理", "match": "exact", "reply": "Filza文件管理器（3.9.7）在这👇https://pan.quark.cn/s/e11db4a69ca6先存到你自己的网盘再下载，用巨魔或自签装上就能用。小提示：系统文件夹别乱删，改文件前先备份一份，稳妥第一。更多资源在资源站 wnby.rf.gd"}, {"keyword": "侧载", "match": "exact", "reply": "SideStore提取密码：2846 回资源站wnby.rf.gd点开SideStore卡片，输入密码就能打开下载。"}, {"keyword": "巨魔", "match": "exact", "reply": "TrollStore提取密码：7391 回资源站wnby.rf.gd点开TrollStore卡片，输入密码就能打开下载。"}, {"keyword": "A", "match": "contains", "reply": "https://dlbzyw.lanzouq.com/iJfER3y8gqra"}, {"keyword": "地摊", "match": "contains", "reply": "：https://pan.quark.cn/s/50f002cde3b3"}, {"keyword": "仿电工", "match": "contains", "reply": "百度网盘：https://pan.baidu.com/s/1Drcw9cXyk-YOa6Y2jEq7sA?pwd=ne54"}, {"keyword": "摸鱼", "match": "contains", "reply": "https://pan.baidu.com/s/11r9pdk3HaSh76e97rpOyrA?pwd=5n9k"}, {"keyword": "换脸", "match": "contains", "reply": "获取地址：百度:https://pan.baidu.com/s/19isJCUjSqlnMrVQ_Ij4faw提取码: k399 夸克：https://pan.quark.cn/s/cedb40c01b24"}, {"keyword": "文字助手", "match": "contains", "reply": "获取地址： 百度:https://pan.baidu.com/s/17NOo_PER2m9chq5WVspiVg提取码: i9ev 夸克：https://pan.quark.cn/s/8f1819dee54d"}, {"keyword": "舌诊", "match": "contains", "reply": "QQ20250831-010410.png ：https://pan.quark.cn/s/6b55ad9147c1:https://pan.baidu.com/s/1sr28YKyHZHbBdHGPE28Rkw提取码:927c"}, {"keyword": "元气", "match": "contains", "reply": "百度网盘：https://pan.baidu.com/s/161DvMa3QpIf5oZS1nUdawA?pwd=zrue 迅雷网盘：https://pan.xunlei.com/s/VOW9rlEkgR3ewIIAm7jLp8vGA1?pwd=5pdk#"}, {"keyword": "42", "match": "contains", "reply": "获取地址：百度:https://pan.baidu.com/s/1_x74-yF7QxprD95n49FJ3Q提取码: efr8 夸克：https://pan.quark.cn/s/0c18fc9c4ab8"}, {"keyword": "labubu", "match": "contains", "reply": "获取地址：夸克：https://pan.quark.cn/s/1f63f2ee514f"}, {"keyword": "视屏号", "match": "contains", "reply": "获取地址：百度:https://pan.baidu.com/s/1sN_jV-_KhCAHi3_KpMymwA提取码:hqww 夸克：https://pan.quark.cn/s/5c898fd5b471"}, {"keyword": "马赛克", "match": "contains", "reply": "「马赛克处理」，来自夸克网盘分享。夸克网盘无需下载在线播放视频，畅享原画5倍速，支持电视投屏。/~5afe36sSkG~:/ 链接：https://pan.quark.cn/s/b21369324d6c 提取码：LJrU"}, {"keyword": "克隆", "match": "contains", "reply": "：夸克链接：https://pan.quark.cn/s/e346b9355345 百度链接：https://pan.baidu.com/s/1XV5VijyQ9LPZE0iIGPB0Ag?pwd=K24K 提取码：K24K 本站说明"}, {"keyword": "换脸", "match": "contains", "reply": "链接：https://pan.quark.cn/s/865c4b3440a2"}, {"keyword": "辐射", "match": "contains", "reply": "链接:https://pan.baidu.com/s/19n9hT7W00MQ7LiAeHdA1rA 提取码:3451 链接：https://pan.quark.cn/s/23bfafb672f9"}, {"keyword": "搞笑表情", "match": "contains", "reply": "获取地址：百度:https://pan.baidu.com/s/141K_rVyTU07CsTw6k5uENw提取码:nf1r 夸克：https://pan.quark.cn/s/90c0e5e78595"}, {"keyword": "打字萌宠", "match": "contains", "reply": "百度网盘：https://pan.baidu.com/s/1MDkUnQV7Nsj8zKI4uBmhcQ?pwd=tcu6提取码:tcu6 123云盘：https://www.123865.com/s/B1QDVv-mLWxh"}, {"keyword": "配料查", "match": "contains", "reply": "https://wwvs.lanzoue.com/ierNm2tqc3be"}, {"keyword": "表情库", "match": "contains", "reply": "https://wwvs.lanzoue.com/iEzQp2t9z17e"}, {"keyword": "趴图", "match": "contains", "reply": "https://pan.quark.cn/s/234e3422544e#/list/share"}, {"keyword": "解析", "match": "contains", "reply": "链接:https://pan.baidu.com/s/1Md3L9cYLJgcyGF0mHDz57g?pwd=92m7 提取码:92m7 复制这段内容打开「百度网盘APP即可获取」"}, {"keyword": "小X", "match": "contains", "reply": "夸克云盘：https://pan.quark.cn/s/69122b546a63 诚通云盘：https://url20.ctfile.com/d/63804220-66396985-3ca1df?p=2276（访问密码：2276）"}, {"keyword": "3380", "match": "contains", "reply": "夸克云盘：https://pan.quark.cn/s/174c23211dab 诚通云盘：https://url20.ctfile.com/d/63804220-66234709-c37336?p=2276 （访问密码：2276）"}, {"keyword": "PCVX", "match": "contains", "reply": "https://www.123912.com/s/DK7Ajv-RXHg?提取码:288K"}, {"keyword": "直播助手", "match": "contains", "reply": "：1. 链接：https://pan.quark.cn/s/45f596380979 2 链接:https://pan.baidu.com/s/1K7Y2ns8yW0vTqr607a2T0Q?pwd=e86b 提取码:e86b"}, {"keyword": "中医2024", "match": "contains", "reply": "中医大全汇编2024 移动链接:https://caiyun.139.com/m/i?2jQXnMmhGEeti 备用:https://pan.baidu.com/s/1SrjJg8LyDelf6sSgeP3cOA 提取码:jgil"}, {"keyword": "嗨小葩", "match": "contains", "reply": "—————————下载链接————————— ①号链接:https://pan.baidu.com/s/1h2OZpxEUnNwX3qn592WZaQ?pwd=SJTX 提取码:SJTX ②号链接：https://drive.uc.cn/s/981abd074e104?public=1"}, {"keyword": "PC百du", "match": "contains", "reply": "https://pan.quark.cn/s/20ebb4101b6e#/list/share"}, {"keyword": "PCV记录", "match": "contains", "reply": "百度 链接:https://pan.baidu.com/s/12dwS7XFbDsTTdpsbH8ddyA?pwd=7fth提取码:7fth 夸克 链接：https://pan.quark.cn/s/76ddbae754d0"}, {"keyword": "视屏号", "match": "contains", "reply": "https://pan.quark.cn/s/ba9132b2b6b6#/list/share"}, {"keyword": "清风DJ", "match": "contains", "reply": "：1. 链接：https://pan.quark.cn/s/2766d204591a 2. 链接:https://pan.baidu.com/s/1KESCsIPS35zeJLOXa2pqqg?pwd=2v48 提取码:2v48"}, {"keyword": "红包", "match": "contains", "reply": "https://pan.xunlei.com/s/VOHf35K9TTWE9kkpt0TzTx_9A1?pwd=vsu4提取码：vsu4 https://pan.quark.cn/s/ab41bdcfb5b2 https://www.123684.com/s/zHbRVv-hUuCh"}, {"keyword": "手机", "match": "contains", "reply": "一号链接：https://pan.quark.cn/s/cbcc3143ca2c 链接:https://pan.baidu.com/s/1lciy7kXXplFTLFgE3K1SLg?pwd=1111 提取码:1111"}, {"keyword": "哪吒4k", "match": "contains", "reply": "通过百度网盘分享的文件：合集壁纸.zip 链接：https://pan.baidu.com/s/1pkepDkeWnUTikpJCJxAELg?pwd=68dn 提取码：68dn 复制这段内容打开「百度网盘APP即可获取」"}, {"keyword": "哪吒", "match": "contains", "reply": "下载地址：https://pan.quark.cn/s/0d6d2d2413d2"}, {"keyword": "Shot FX", "match": "contains", "reply": "： 夸克网盘： https://pan.quark.cn/s/43f4b8a27b0b UC网盘： https://drive.uc.cn/s/43a21237be244?public=1 百度网盘： https://pan.baidu.com/s/1JI_nxVEg4n8TYwDZr6HgiA 提取码:e249"}, {"keyword": "定制V", "match": "contains", "reply": "链接：https://pan.quark.cn/s/4ad89b5c66e6"}, {"keyword": "红包", "match": "contains", "reply": "链接:https://pan.baidu.com/s/1bcuKa48I6XgALyQtMATOrw?pwd=yksy提取码:yksy"}, {"keyword": "壁纸", "match": "contains", "reply": "https://wwvs.lanzoue.com/i4Iez2k2x4re"}, {"keyword": "铭识", "match": "contains", "reply": "①号链接：https://drive.uc.cn/s/a6e9a65ec1634?public=1 ②号链接:https://pan.baidu.com/s/1d2__-Z3mtetOBgK5uCruow?pwd=SJTX 提取码:SJTX"}, {"keyword": "PPT", "match": "contains", "reply": "：手机号登录就是会员 移动链接:https://caiyun.139.com/m/i?2jexBPfiDV0kc 备用:https://pan.baidu.com/s/1cntD4SkOgdx8zRF5M4N-vw 提取码:jgi1"}, {"keyword": "太阳能", "match": "contains", "reply": "下载链接:https://pan.baidu.com/s/1l-4x4d0OdlvBEWRPM7w_kQ?pwd=aaaa 提取码:aaaa https://drive.uc.cn/s/bfaf9ddc31d74?public=1"}, {"keyword": "百度网盘", "match": "contains", "reply": "https://pan.baidu.com/comps/view/MV84NTZfMTAzMF8yODU2X29ubGluZQ=="}, {"keyword": "257", "match": "contains", "reply": "下载链接:https://pan.baidu.com/s/1A18lNG6YBtBUZ6sGg-fdfw?pwd=lehq"}, {"keyword": "259", "match": "contains", "reply": "https://esign.ipadump.com/#/home/esign"}, {"keyword": "编程高手", "match": "contains", "reply": "https://pan.quark.cn/s/a3e80761a6d4"}, {"keyword": "真实好友", "match": "contains", "reply": " 一号链接：https://pan.quark.cn/s/66fb82dd4551 二号链接:https://pan.baidu.com/s/17OmXMl8V0qqulyZeT8Wkfw?pwd=1111 提取码:1111"}, {"keyword": "民间怪闻", "match": "contains", "reply": "链接:https://pan.quark.cn/s/4f6d1e6bc26e"}, {"keyword": "DJ秀", "match": "contains", "reply": "①号链接：https://drive.uc.cn/s/a7d94d6ba3974?public=1 ②号链接:https://pan.baidu.com/s/1aFVswRDQKFUgA1tE23Jrxg?pwd=SJTX 提取码:SJTX"}, {"keyword": "变声器", "match": "contains", "reply": "https://pan.quark.cn/s/f6f446b97311"}, {"keyword": "万能钥匙", "match": "contains", "reply": "移动下载链接:https://caiyun.139.com/m/i?185C75rEm5W8Z 链接:https://pan.baidu.com/s/1UB1KCAF6y9zsMJMD8ybJaQ 提取码:yg5y"}, {"keyword": "App89", "match": "contains", "reply": "https://pan.quark.cn/s/0b01fa5e9862\n\n自行填入抓包的Authorization值 抓包教程可以在网上看一下，蛮简单，几分钟就配置好了 然后抓小程序，搜上面关键词"}, {"keyword": "暖手宝", "match": "contains", "reply": ":https://drive.uc.cn/s/4778d242d6f04?public=1 ：https://pan.baidu.com/s/13APrCyGFo73M_tWL8w1iYA?pwd=6666"}, {"keyword": "NFC", "match": "contains", "reply": "https://pan.quark.cn/s/1aca90cfb82f#/"}, {"keyword": "免费音乐", "match": "contains", "reply": "https://www.123684.com/s/Cob5Vv-OaxD3"}, {"keyword": "趣映", "match": "contains", "reply": "通过百度网盘分享的文件：趣映 链接：https://pan.baidu.com/s/1cYJIlPOmO1QujQkUigNKMw?pwd=y991 提取码：y991 复制这段内容打开「百度网盘APP即可获取」"}, {"keyword": "充电动画", "match": "contains", "reply": "①号链接:https://caiyun.139.com/m/i?0c5CfZY5LgUI7 ②号链接:https://pan.baidu.com/s/15Mm38oecx80d85c16bL0XQ?pwd=vk5x 提取码:vk5x"}, {"keyword": "磁力搜索", "match": "contains", "reply": "https://pan.quark.cn/s/8f4c33e38636"}, {"keyword": "霸王茶姬", "match": "contains", "reply": "https://pan.quark.cn/s/fe990184787a"}, {"keyword": "群发器", "match": "contains", "reply": "移动下载链接:https://caiyun.139.com/m/i?105Cqidx9jfNO 链接:https://pan.baidu.com/s/1Bivn9S-UVC1IvEGuey_mzA 提取码:1am1"}, {"keyword": "一键激活", "match": "contains", "reply": "https://kms.cx/"}, {"keyword": "星海解锁", "match": "contains", "reply": "https://pan.baidu.com/wap/init?surl=Bc_T6Ap_1W28oxBr338oGg&pwd=rbfr"}, {"keyword": "嗨小葩", "match": "contains", "reply": "①号链接:https://caiyun.139.com/m/i?0c5CrXnpI81Ya ②号链接:https://pan.baidu.com/s/1Bix9qqSYgj_NLexPR2R4ZA?pwd=vk5x 提取码:vk5x"}, {"keyword": "微信步数", "match": "contains", "reply": "下载地址：https://mtwl.lanzn.com/iSVPg2ef1l6f"}, {"keyword": "真实好友", "match": "contains", "reply": " 一号链接：https://pan.quark.cn/s/367c23564993 二号链接:https://pan.baidu.com/s/1twN9s-vieLCR6kBHp-4OqQ?pwd=1111 提取码:1111"}, {"keyword": "手机远控电脑", "match": "contains", "reply": "下载链接: https://pan.quark.cn/s/55d29a459b5e"}, {"keyword": "植物大战僵尸杂交版", "match": "contains", "reply": "https://pan.quark.cn/s/5c93c85cb2cc"}, {"keyword": "微商帮手", "match": "contains", "reply": "：https://pan.quark.cn/s/5a3246c97627:https://pan.baidu.com/s/17h2J7-8cPATFbmLmkaDjPw?pwd=92vi"}, {"keyword": "度加剪辑", "match": "contains", "reply": "移动云盘（不限速） 链接:https://caiyun.139.com/m/i?014McsaZ2FPP0"}];

// 与 PHP load_rules() 一致：过滤缺 keyword/reply 的条目，match 只认 exact，其余归 contains
const RULES = (Array.isArray(RULES_DATA) ? RULES_DATA : [])
  .filter((r) => r && r.keyword != null && r.reply != null && String(r.keyword) !== '')
  .map((r) => ({
    keyword: String(r.keyword),
    reply: String(r.reply),
    match: r.match === 'exact' ? 'exact' : 'contains',
  }));

// ---------------- 小工具 ----------------

const textEncoder = new TextEncoder();

function startsWith(s, prefix) {
  return s.startsWith(prefix);
}

function containsStr(s, needle) {
  return needle !== '' && s.includes(needle);
}

// PHP 的 strlen 是字节数（关键词排序用）
function byteLen(s) {
  return textEncoder.encode(s).length;
}

function charLen(s) {
  return Array.from(s).length;
}

function charSub(s, start, len) {
  const chars = Array.from(s);
  return (len === undefined ? chars.slice(start) : chars.slice(start, start + len)).join('');
}

// PHP urlencode：空格变 +，~ 等也要编码（encodeURIComponent 不编码 !'()*~）
function phpUrlencode(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/~/g, '%7E')
    .replace(/%20/g, '+');
}

// 日志：只记时间、openid 后 6 位、消息前 30 字、命中路由，不记全文。写失败绝不影响回复。
// （Edge Function 无文件系统，改为 console 输出，格式与 PHP 版 log.txt 一致。）
function wxLog(openid, content, route) {
  try {
    const tail = String(openid ?? '').slice(-6);
    const snippet = charSub(String(content ?? '').replace(/[\r\n]/g, ' '), 0, 30);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    // Asia/Shanghai 时间，与 PHP date_default_timezone_set('Asia/Shanghai') 对齐
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    console.log(`${stamp} | ${tail} | ${route} | ${snippet}`);
  } catch (_) {
    // 日志失败绝不影响回复
  }
}

// ---------------- HTTP（fetch，短超时：被动回复总预算约 5 秒） ----------------

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 成功返回响应体文本，失败（网络错误/超时）返回 null（对应 PHP 的 false）
async function httpGet(url, timeoutSec = 3, headers = {}) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...headers },
    }, timeoutSec * 1000);
    return await res.text();
  } catch (_) {
    return null;
  }
}

async function httpPostJson(url, payload, headers = {}, timeoutSec = 4) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, timeoutSec * 1000);
    return await res.text();
  } catch (_) {
    return null;
  }
}

async function httpPostForm(url, formObj, headers = {}, timeoutSec = 3) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(formObj).toString(),
    }, timeoutSec * 1000);
    return await res.text();
  } catch (_) {
    return null;
  }
}

// ---------------- 签名验证 ----------------

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', textEncoder.encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkSignature(token, signature, timestamp, nonce) {
  if (!signature || !timestamp || !nonce) return false;
  const arr = [token, timestamp, nonce].sort();
  const digest = await sha1Hex(arr.join(''));
  return digest === signature;
}

// ---------------- 入站 XML 解析（微信报文结构简单，正则提取 + CDATA 处理） ----------------

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`);
  const m = xml.match(re);
  if (!m) return '';
  const value = m[1] !== undefined ? m[1] : decodeXmlEntities(m[2] ?? '');
  return value.trim();
}

function parseMessage(raw) {
  if (!raw || !raw.includes('<xml')) return null;
  return {
    to: extractTag(raw, 'ToUserName'),       // 公众号原始 ID
    from: extractTag(raw, 'FromUserName'),   // 粉丝 openid
    type: extractTag(raw, 'MsgType'),
    content: extractTag(raw, 'Content'),
    event: extractTag(raw, 'Event'),
    eventkey: extractTag(raw, 'EventKey'),
  };
}

// ---------------- 回复 XML 构造（CDATA 安全转义，与 PHP 口径一致） ----------------

function cdata(s) {
  return '<![CDATA[' + String(s).split(']]>').join(']]]]><![CDATA[>') + ']]>';
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function buildTextReplyXml(to, from, content) {
  return '<xml>'
    + '<ToUserName>' + cdata(to) + '</ToUserName>'
    + '<FromUserName>' + cdata(from) + '</FromUserName>'
    + '<CreateTime>' + nowSeconds() + '</CreateTime>'
    + '<MsgType>' + cdata('text') + '</MsgType>'
    + '<Content>' + cdata(content) + '</Content>'
    + '</xml>';
}

function buildMusicReplyXml(to, from, title, desc, musicUrl, hqUrl) {
  return '<xml>'
    + '<ToUserName>' + cdata(to) + '</ToUserName>'
    + '<FromUserName>' + cdata(from) + '</FromUserName>'
    + '<CreateTime>' + nowSeconds() + '</CreateTime>'
    + '<MsgType>' + cdata('music') + '</MsgType>'
    + '<Music>'
    + '<Title>' + cdata(title) + '</Title>'
    + '<Description>' + cdata(desc) + '</Description>'
    + '<MusicUrl>' + cdata(musicUrl) + '</MusicUrl>'
    + '<HQMusicUrl>' + cdata(hqUrl) + '</HQMusicUrl>'
    + '<ThumbMediaId>' + cdata('') + '</ThumbMediaId>'
    + '</Music>'
    + '</xml>';
}

// 路由结果统一结构：{kind:'text'|'music', route, content} 或 music 字段
function textResult(route, content) {
  return { kind: 'text', route, content };
}

// ---------------- 1. 口令规则（先 exact 一轮、再 contains 一轮，同轮按文件顺序，与公众号后台语义一致） ----------------

function routeRules(content, rules = RULES) {
  for (const r of rules) {           // 第一轮：match=exact 的规则，消息与关键词完全相等才命中
    if (r.match === 'exact' && content === r.keyword) {
      return textResult('rules-exact', r.reply);
    }
  }
  for (const r of rules) {           // 第二轮：match=contains 的规则，消息包含关键词即命中
    if (r.match !== 'exact' && containsStr(content, r.keyword)) {
      return textResult('rules-contains', r.reply);
    }
  }
  return null;
}

// ---------------- 2. 点歌（网易云 weapi 加密搜索 → 音乐消息） ----------------
// 旧版 api/search/get/web 接口已改为加密响应、解析不到歌单（2026-11-20 实测坐实），
// 改走网页端同款 weapi：两次 AES-CBC + RSA 生成 params/encSecKey，响应仍是明文 JSON。

const WEAPI_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud';
const WEAPI_IV = '0102030405060708';
const WEAPI_BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function weapiAesEncrypt(text, key) {
  const k = await crypto.subtle.importKey('raw', textEncoder.encode(key), { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: textEncoder.encode(WEAPI_IV) }, k, textEncoder.encode(text));
  return bytesToBase64(new Uint8Array(ct));
}

function weapiRsaEncrypt(text) {
  const reversed = text.split('').reverse().join('');
  let hex = '';
  for (const ch of reversed) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
  const m = BigInt('0x' + hex);
  const e = BigInt('0x010001');
  const n = BigInt('0x' + WEAPI_MODULUS);
  let result = 1n;
  let base = m % n;
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % n;
    base = (base * base) % n;
    exp >>= 1n;
  }
  return result.toString(16).padStart(256, '0');
}

// 搜索成功返回响应体文本（与旧接口同构的 JSON），失败返回 null
async function weapiSearchBody(query) {
  try {
    let secretKey = '';
    for (let i = 0; i < 16; i++) secretKey += WEAPI_BASE62[Math.floor(Math.random() * 62)];
    const text = JSON.stringify({ s: query, type: 1, offset: 0, total: true, limit: 5, csrf_token: '' });
    const params = await weapiAesEncrypt(await weapiAesEncrypt(text, WEAPI_PRESET_KEY), secretKey);
    const encSecKey = weapiRsaEncrypt(secretKey);
    return await httpPostForm('https://music.163.com/weapi/search/get?csrf_token=', { params, encSecKey }, { Referer: 'https://music.163.com/' }, 3);
  } catch (_) {
    return null;
  }
}

// 把网易云搜索返回的 JSON 转成音乐消息数据；无结果/坏数据返回 null
// 多个结果时按「歌名/歌手与查询词的吻合度」挑最像原唱的一首，避免选到翻唱
function musicFromSearchJson(json, query) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (_) {
    return null;
  }
  const songs = data?.result?.songs ?? [];
  if (!songs || songs.length === 0) return null;
  const parts = String(query ?? '').split(/\s+/).filter(Boolean);
  let song = songs[0];
  let bestScore = -1;
  for (const s of songs) {
    const name = s?.name ?? '';
    const artistNames = (Array.isArray(s?.artists) ? s.artists : []).map((a) => a?.name ?? '');
    let score = 0;
    for (const p of parts) {
      if (name === p) score += 3;
      else if (name.includes(p)) score += 2;
      if (artistNames.some((a) => a !== '' && (a.includes(p) || p.includes(a)))) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      song = s;
    }
  }
  const name = song.name ?? query;
  const artists = [];
  for (const a of (Array.isArray(song.artists) ? song.artists : [])) {
    if (a && a.name) artists.push(a.name);
  }
  const artistStr = artists.join(' / ');
  const url = 'https://music.163.com/song/media/outer/url?id=' + (song.id ?? '') + '.mp3';
  return {
    title: artistStr !== '' ? `${name} - ${artistStr}` : name,
    desc: '点击播放',
    music_url: url,
    hq_url: url,
  };
}

// 点歌没搜到时，让 GLM 俏皮接话（方言/玩笑/非歌名输入也能接住）；无 Key 或失败返回 null
async function musicMissWitty(query, cfg = CONFIG) {
  const key = String(cfg.glm_api_key ?? '').trim();
  if (key === '') return null;
  const base = String(cfg.glm_base_url ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const payload = {
    model: cfg.glm_model ?? 'glm-4-flash',
    messages: [
      { role: 'system', content: '你是公众号「蜗牛奔月」的小助手。粉丝发来「点歌 ' + query + '」，但歌库里没有这首歌，对方多半是拿方言、玩笑话或随口一说逗你玩。用一句俏皮话接住（不超过60字，像朋友聊天，别生硬，别自称AI），再顺势引导他发真正的歌名，最好带上歌手。只输出这一句回复。' },
      { role: 'user', content: '点歌 ' + query },
    ],
    max_tokens: 120,
  };
  const body = await httpPostJson(base + '/chat/completions', payload, {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  }, 2.5);
  if (body === null) return null;
  try {
    const data = JSON.parse(body);
    let answer = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (answer === '') return null;
    if (charLen(answer) > 120) answer = charSub(answer, 0, 120);
    return answer;
  } catch (_) {
    return null;
  }
}

async function routeMusic(content) {
  if (!startsWith(content, '点歌')) return null;
  const query = charSub(content, 2).trim();
  if (query === '') {
    return textResult('music', '想听哪首？发「点歌 歌名」或「点歌 歌名 歌手」，比如：点歌 晴天 周杰伦');
  }
  const body = await weapiSearchBody(query);
  if (body === null) {
    return textResult('music', '点歌服务暂时打了个盹，稍后再试试～');
  }
  const music = musicFromSearchJson(body, query);
  if (music === null) {
    const witty = await musicMissWitty(query);
    if (witty !== null) {
      return textResult('music-miss', witty);
    }
    return textResult('music', `没找到和「${query}」有关的歌～你要是逗我玩，那算你成功啦；真想听歌，发个歌名带上歌手，比如「点歌 晴天 周杰伦」，我马上放给你。`);
  }
  return { kind: 'music', route: 'music', music };
}

// ---------------- 3. 天气（wttr.in） ----------------

function weatherFromJson(json, city) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (_) {
    return null;
  }
  const cc = data?.current_condition?.[0] ?? null;
  if (!cc) return null;
  const desc = cc.lang_zh?.[0]?.value ?? (cc.weatherDesc?.[0]?.value ?? '');
  const area = data?.nearest_area?.[0]?.areaName?.[0]?.value ?? city;
  return `${area}今天：${desc}，气温 ` + (cc.temp_C ?? '?') + '℃'
    + '（体感 ' + (cc.FeelsLikeC ?? '?') + '℃），'
    + '湿度 ' + (cc.humidity ?? '?') + '%，'
    + '风速 ' + (cc.windspeedKmph ?? '?') + ' km/h';
}

async function routeWeather(content) {
  if (!startsWith(content, '天气')) return null;
  const city = charSub(content, 2).trim();
  if (city === '') {
    return textResult('weather', '查哪里的天气？发「天气 城市」，比如：天气 北京');
  }
  const body = await httpGet('https://wttr.in/' + phpUrlencode(city) + '?format=j1&lang=zh', 3);
  const text = body === null ? null : weatherFromJson(body, city);
  if (text === null) {
    return textResult('weather', `没查到「${city}」的天气，确认下城市名再试试～`);
  }
  return textResult('weather', text);
}

// ---------------- 4. 每日一签 ----------------

function routeFortune(content) {
  if (!startsWith(content, '抽签') && !startsWith(content, '一签')) {
    return null;
  }
  const text = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
  return textResult('fortune', "🎋 今日一签\n" + text + "\n每日一签：" + FORTUNE_LINK);
}

// ---------------- 5. 关键词（包含匹配，长词优先；与 PHP 一致按字节长降序、稳定排序） ----------------

const KEYWORDS_SORTED = [...KEYWORD_ENTRIES]
  .sort((a, b) => byteLen(b[0]) - byteLen(a[0]));

function routeKeyword(content) {
  for (const [kw, reply] of KEYWORDS_SORTED) {
    if (containsStr(content, kw)) return textResult('keyword', reply);
  }
  return null;
}

// ---------------- 6. AI 问答兜底（智谱 GLM，4 秒超时，失败回固定引导语） ----------------

async function routeQa(content, cfg = CONFIG) {
  const key = String(cfg.glm_api_key ?? '').trim();
  if (key === '') {
    return textResult('qa-fallback', GUIDANCE); // 没配 Key：直接引导，不让微信端报错
  }
  const base = String(cfg.glm_base_url ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const payload = {
    model: cfg.glm_model ?? 'glm-4-flash',
    messages: [
      { role: 'system', content: QA_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    max_tokens: 600,
  };
  const body = await httpPostJson(base + '/chat/completions', payload, {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  }, 4);
  let answer = '';
  if (body !== null) {
    try {
      const data = JSON.parse(body);
      answer = String(data?.choices?.[0]?.message?.content ?? '').trim();
    } catch (_) {
      answer = '';
    }
  }
  if (answer === '') {
    return textResult('qa-fallback', GUIDANCE); // 超时/失败：固定引导语
  }
  if (charLen(answer) > 500) answer = charSub(answer, 0, 500);
  return textResult('qa', answer);
}

// ---------------- 路由总入口 ----------------

async function routeText(content, rules = RULES) {
  return routeRules(content, rules)
    ?? await routeMusic(content)
    ?? await routeWeather(content)
    ?? routeFortune(content)
    ?? routeKeyword(content)
    ?? await routeQa(content)
    ?? textResult('default', GUIDANCE);
}

// 把路由结果渲染成回复 XML
function renderReply(result, to, from) {
  if ((result?.kind ?? 'text') === 'music') {
    const m = result.music;
    return buildMusicReplyXml(to, from, m.title, m.desc, m.music_url, m.hq_url);
  }
  return buildTextReplyXml(to, from, result.content);
}

// ---------------- 主流程 ----------------

function xmlResponse(xml) {
  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

function emptyResponse() {
  return new Response('', { status: 200 });
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const signature = params.get('signature') ?? '';
  const timestamp = params.get('timestamp') ?? '';
  const nonce = params.get('nonce') ?? '';

  if (request.method === 'GET') {
    // GET 验证：签名对就原样返回 echostr，否则返回空串
    const ok = await checkSignature(CONFIG.token, signature, timestamp, nonce);
    return new Response(ok ? (params.get('echostr') ?? '') : '', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // POST：先验签名，验不过直接空回
  if (!await checkSignature(CONFIG.token, signature, timestamp, nonce)) {
    return emptyResponse();
  }
  const raw = await request.text();
  const msg = parseMessage(raw);
  if (msg === null || msg.from === '') {
    return emptyResponse();
  }
  const to = msg.from;   // 回复的 To/From 要对调
  const from = msg.to;

  if (msg.type === 'event') {
    if (msg.event === 'subscribe') {
      wxLog(msg.from, 'subscribe', 'event-subscribe');
      return xmlResponse(buildTextReplyXml(to, from, WELCOME));
    }
    if (msg.event === 'CLICK' && msg.eventkey !== '') {
      // 菜单点击事件：把 EventKey 当文本走同一套路由
      const result = await routeText(msg.eventkey);
      wxLog(msg.from, msg.eventkey, result.route);
      return xmlResponse(renderReply(result, to, from));
    }
    return emptyResponse(); // 其他事件不回
  }

  if (msg.type === 'text') {
    const result = await routeText(msg.content);
    wxLog(msg.from, msg.content, result.route);
    return xmlResponse(renderReply(result, to, from));
  }

  // 非文本消息（图片/语音等）：回引导语
  wxLog(msg.from, '[' + msg.type + ']', 'nontext');
  return xmlResponse(buildTextReplyXml(to, from, GUIDANCE));
}

// 挂到 Deno.serve（Supabase Edge Function 入口）；node 测试环境无 Deno，跳过
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(handleRequest);
}

export {
  handleRequest,
  CONFIG,
  RULES,
  KEYWORDS,
  FORTUNES,
  FORTUNE_LINK,
  GUIDANCE,
  WELCOME,
  checkSignature,
  parseMessage,
  buildTextReplyXml,
  buildMusicReplyXml,
  musicFromSearchJson,
  weatherFromJson,
  routeText,
};
