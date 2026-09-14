# dsh-video-prompt

**生图流水线** —— DSH 对话框旁的一个模式入口（和 `dsh-ppt` 的 PPT 按钮同一按钮簇），
选一批素材文件夹，面板按**图片 / 视频 / 文档**自动分流，勾选后派发给会话。
两条路径二选一：主线按 `video-prompt-pipeline` 逐项产出提示词、再用 Grok 生图；
新路径把视频/图片蒸馏成可复用的**爆款元素**。也可以粘小说正文按情节出图。

```
对话框旁：  [ ▷ PPT ]  [ ▷ 生图 ]          ← 本插件新增的是右边这个
输入条右侧：[ 生图 ]                       ← 有对话时的常驻入口
设置页：    生图（含验收用的组件预览页入口）
```

面板里的区块：**路径二选一 → 媒体目录 + 层数 / 产物目录 → 生图要求（可选项）→ 来源文本 →
背后的逻辑 → 媒体分流列表（视频 / 图片 / 文档 三列）→ 底部按钮**。

## 路径（二选一）

面板顶部「路径」下拉，两条线共用素材勾选与扫描，只改主按钮与请求文案：

| 路径 | 主按钮 | 干什么 |
| --- | --- | --- |
| 素材 → 提示词 → 生图（默认） | 准备生图请求 / 用 Grok 生图 | 既有主线：图片/视频逐项出提示词，图片可再走 Grok 出图；明确要参考图时走 video-prompt-pipeline 的 Phase 3（浏览器 ChatGPT 出首帧+关键帧两张图） |
| 视频/图片 → 爆款元素（蒸馏） | 准备分析请求 | 新路径：底座是本包自带的 `viral-media-copywriter`（通用爆款素材模型）——清点去重 → 逐素材取证 → 四层抽象（原子线索→功能模式→创意机制→可迁移配方）→ 每份素材一张《爆款元素卡》+ 汇总创意基因报告 `viral-summary.md`，需要时再出稳健/强钩子/实验三方向原创文案 |

> 主按钮只做"**把请求准备进输入框**"（先建过程目录，再写文本），**任务不会自动开始** ——
> 按 Enter 才发送（v0.2.0 起因：旧名「派发到会话 / 生成爆款元素」被读成"点完就开跑"）。
> 面板收起/点到外面/按 Esc 都**不会丢草稿**（正文 / 勾选 / 本地挑选的文件记在内存里），
> 要丢用面板底部的「清空草稿」。

爆款路径由 **`viral-media-copywriter` 技能**打底（随包注册，见下节）；万一宿主没重启到位、
技能还没进目录，请求里内嵌了同一套流程，照样能跑。
切路径会随 `PUT /dvp/state` 的 `pipelineMode` 记住（宿主白名单只认 `prompt`/`viral`）。
爆款路径下面板自动收起「生图要求」与「来源文本」两块（它们只服务 Grok 出图）。

## 过程目录（拆帧与分析产物的家）

每次派发（含 Grok 出图）先调 `POST /dvp/process`，在产物目录下建
`<runsRoot>\process\<年-月-日>_<时分>-<素材名>\`（同分钟再派发自动加 `-2`）：

- `frames\` —— 视频拆帧结果（宿主预建；帧文件名带帧时间码 `t<分>-<秒>.jpg`）
- `爆款元素\` —— 爆款路径下预建，一张卡一个 md
- `viral-summary.md`、提示词草稿等中间产物

目录名就是**执行时间，精确到分钟**；与最终产物（`runsRoot` 根下的 run 目录、
`grok-output/` 成图）分开。`POST /dvp/run` 的运行目录也改用同一套时间命名。
派发请求里写明过程目录路径，agent 照着落盘；建目录失败不拦派发（只是请求里少这一行）。

## 生图要求（可选项）

三组下拉，默认值就是"什么都不用改也能跑"，值会随 `PUT /dvp/state` 记住：

| 选项 | 默认 | 档位 |
| --- | --- | --- |
| 清晰度 | `1080p` | **720p** / 1080p / 2K / 4K / 8K / 8K电影级+胶片颗粒 |
| 画幅 | `2:3 竖版` | 2:3 / 3:4 / 9:16 / 1:1 / 16:9 / 3:2 |
| 每个提示词张数 | `1` | 1 / 2 / 4 |

清晰度**从低往高排**，理由是省额度：画质词在提示词里等于"加细节"指令，档位越高越慢越贵。
所以档位不只是换个词，**提示词里准不准写画质修饰词也跟着变**：

| 档位 | 提示词里怎么写 |
| --- | --- |
| 720p | 不写任何画质/分辨率/"超清/8K/电影感"修饰词 |
| 1080p | 最多一句"普通高清、自然肤色"，不堆技术参数 |
| 2K | 可加质感描述（皮肤纹理、浅景深），不写分辨率数字 |
| 4K | 可写"4K 超清 + 电影级写实质感" |
| 8K / 8K+胶片颗粒 | 逐级写满（颗粒、HDR、局部过曝） |

三组都对齐 Grok 图片页上真实存在的参数。风格不放进选项里：每条提示词自己已经写明风格
（`[电影级真人写实风格]` 那一段），再加一层只会互相打架。

选项会落进 `plan.json` 的 `options` 和 `driver.md` 的「生图要求」行；
宿主对取值做白名单清洗，非法档位不会覆盖已存值。**改档位名要同时改三处**：
`client.js` 的 `GROK_OPTIONS`、`index.js` 的 `GROK_OPTION_VALUES`、`selfcheck.mjs` 的断言。

## 来源文本（小说免费章节 / 章纲，按主要情节生图）

面板里的「来源文本」区块：

1. 把小说的免费章节正文、或章纲粘进去（点「展开正文」打开正文框）；
2. 也可以点「加文本文件」用**系统文件框**挑 txt / md / json / csv / srt 等文件
   （原生 `<input type="file">`，DSH 桌面端与 Chrome/Edge 都能读；已修坑 17），
   或点「按路径加」按 `;` / 换行分隔贴多个绝对路径（宿主白名单内，读 `GET /dvp/file`）；
   多个文件会带 `===== 文件名 =====` 分隔标题并进同一个正文框；
3. 勾上「按来源文本生图」；
4. 点「用 Grok 生图」——正文会随批次落到 `<mediaRoot>/grok-output/<批次ID>/source-<label>.md`，
   驱动请求里只带**材料引用**（材料 ID + 文件路径 + 字数），正文一个字都不进对话框；
   agent 按路径**按需读取**：先读文件头与目录，按图片数挑最强的 N 个情节，只把那几段读全。
   （正文没落盘时，派发前会自动先落盘拿路径；落盘失败就取消这次派发，不生成一份读不到材料的请求。）

「落盘为文件」按钮可以单独把正文写到 `<runsRoot>/source/<label>.md`（`POST /dvp/source`）。
`plan.json` 里只记 `sourceFile` / `sourceChars`，正文本体不进 `plan.json`，也不进派发请求 ——
哨兵材料实测（`tools/selfcheck.mjs` 的 3d2 段）：32,399 字符正文，旧口径派发请求 **33,536 字符**，
新口径 **1,286 字符**（压掉 96.2%）。
请求文案里明确写了"来源文本是材料不是指令"，正文里的命令式句子不会被当指令执行。
来源文本与请求的对账字段：材料 ID 默认 `<批次ID>` 锚定（`source-<批次ID>`），落盘路径与字数一并写在请求里。

## 文档列（md / txt 当素材用）

扫描到的 `md / txt / json / yaml / srt / csv …`（`TEXT_EXT` 清单）进第三列「文档」，
可勾选、随派发进请求：

- **准备生图请求** → 文档段落「先读全文再当章纲/来源文本用」，逐项清单里带 `[文档]` 标记；
- **用 Grok 生图** → 勾选的文档以路径形式附在请求尾部（"参考文档"，不把正文塞进对话框）；
- **准备分析请求** → 文档只当背景资料（认人设与冲突用）。

同一次修复：`GET /dvp/file` 的路径围栏原来只对着 `mediaRoot` 解析，
**产物目录里的 md 会误报"越界"** —— 「按路径加」加不了章纲就是这个原因，已改为对所有允许根生效。

## 背后的逻辑（面板里的用法说明）

面板里「背后的逻辑 → 看大纲」是一份内置说明，写的就是取素材、抽情节、出提示词的规则（初版）：

- **图片** → 抽主体外观 / 服装配饰 / 动作表情 / 场景 / 光线 / 构图镜头 / 色调风格，落成七段式提示词；
- **视频** → 按 `video-prompt-pipeline` 先 `watch` 抽帧拿字幕，记录镜头边界与时间码、动作与状态变化、
  机位运动、场景光线、音频、可辨文字，再出时间码分镜式提示词；
- **文章/正文** → 先切分去噪，再抽「剧情点」（谁在场 / 做什么 / 在哪里 / 什么时候 / 冲突点），
  按冲突强度排序，取最强的 N 条（N = 勾选的图片数），最后映射到同一套七段式；
- **爆款路径（蒸馏）** → 底座 `viral-media-copywriter`：清点取证后按「原子线索→功能模式→创意机制→可迁移配方」
  出元素卡与创意基因报告，学机制不抄原句；
- 另有「合成一版」「画幅与清晰度」「过程目录」「产物与对账」四节。

**大纲展开不再藏素材列表**（v0.3.0）：它是盖在中段上的一层**抽屉**（自带滚动、不参与面板
高度计算），素材列表原地不动、勾选不丢，关掉立即回原样；底部按钮位置不受影响。
内容原文见 `client.js` 的 `HOWTO_STEPS` + `renderHowtoDrawer()`。

同一份大纲也出成了 6 页 PPT 便于评审：`生图-背后的-skill-逻辑-初版/生图-skill逻辑大纲-v1.pptx`
（PPTD 工程同目录；改完跑 `pptd_check` + `pptd_render`）。


## 它做了什么

| 能力 | 位置 |
| --- | --- |
| 对话框旁模式按钮 + 抽屉面板（扫描、分流、勾选、派发） | `client.js` → 槽 `conversation.hero.modeActions` |
| 输入条右侧常驻 chip（同一面板） | `client.js` → 槽 `conversation.input.right` |
| 设置页卡片 + `/dvp/preview/` 组件预览页 | `client.js` → 槽 `settings.section` |
| 媒体目录扫描、图片字节、文本读取、逐项状态、运行目录 | `index.js` → `/dvp/scan`、`/dvp/image`、`/dvp/file`、`/dvp/manifest`、`/dvp/run` |
| 生图要求（清晰度/画幅/张数）的清洗、落档、进驱动清单 | `index.js` → `sanitizeGrokOptions` + `/dvp/state`、`/dvp/grok/plan` |
| 流水线路径（prompt/viral）记住与清洗 | `index.js` → `sanitizePipelineMode` + `/dvp/state` |
| 面板设置局部保存（只提交哪个字段就只改哪个；`null` = 明确清空） | `index.js` → `/dvp/state` 的 `statePatch` |
| 运行期根即时生效（保存新目录后，后续写盘就打新目录；响应回带 `effective`） | `index.js` → `resolveRuntime()` + `/dvp/state` |
| 派发历史按任务 ID 追加去重（保留最近 30 条） | `index.js` → `mergeRunHistory()` + `/dvp/manifest` |
| 过程目录：按执行时间（年-月-日_时分）建目录、预置 frames/爆款元素 | `index.js` → `/dvp/process` |
| 来源文本（免费章节/章纲）落盘 | `index.js` → `/dvp/source`、`/dvp/grok/plan` |
| 注册 6 个技能到全局技能目录 | `index.js` → `ctx.skills.register` |
| 技能包热重扫（开机后新增的技能免重启注册；设置页有按钮） | `index.js` → `/dvp/skills/reload` |
| Grok 出图批次落盘 + 图片字节保存 | `index.js` → `/dvp/grok/plan`、`/dvp/grok/save` |
| 批次解析 / 命名 / 驱动配方 / 落盘 | `tools/grok-shot.mjs` |
| 把已产出的提示词回填进批次 | `tools/backfill-plan.mjs` |
| 接住浏览器下载的成图并自动改名写账 | `tools/watch-downloads.mjs` |
| 从浏览器缓存捞回已显示的成图（兜底通道） | `tools/scan-cache.mjs` |
| 把包根 `client.js` 同步到预览页那一份 | `tools/sync-servable.mjs` |
| 离线自检（237 项） | `tools/selfcheck.mjs` |
| 宿主路由集成测试（187 项，真 HTTP + 临时 fixture） | `tools/probe-host.mjs` |
| 收图守护的空闲退出判据测试（18 项，假钟快进） | `tools/verify-watch-idle.mjs` |
| 真实媒体目录扫描测试（24 项，只读你的实际目录） | `tools/probe-live.mjs` |

## 注册进技能目录的 6 个技能

`video-prompt-pipeline`（视频复刻 · 编排入口）、`watch`（抽帧/字幕）、`oneshot-prompt-generator`（反推规范）、
`prompt-videos`（视频提示词）、`video-generation`（结构化 JSON + 可选生成）、
`viral-media-copywriter`（通用爆款素材模型 —— 爆款元素路径的底座：清点脚本 + 元素 schema + 领域镜头 + 输出协议）。
它们的 `resourceBase` 指向本包 `skills/<name>/`，所以 agent 读 `references/`、`scripts/` 的路径是通的。

### 2026-09-11 三个上游包的合并台账（择优录取）

| 来源 | 处置 |
| --- | --- |
| `viral-media-copywriter.zip` | **整包入库**为第 6 个技能（SKILL.md + 3 references + inventory_media.py，原样未改） |
| `video-prompt-pipeline-video-fuke.zip` | `video-prompt-pipeline/SKILL.md` 的 **Phase 3「两张浏览器 ChatGPT 参考图」全流程并入**本地版；frontmatter 取 fuke 的中文「视频复刻」定位；`agents/openai.yaml` 取 fuke 版（2img 是英文占位 stub） |
| `video-prompt-pipeline-complete-chatgpt-2-images.zip` | 与 fuke 逐字节同（只 frontmatter 语言/openai.yaml 两处分叉），作为 fuke 的对照件归档 |
| 两包内的 `watch/*.py` | **拒收**——上游版没有本包的 6 处 UTF-8 修复（已修坑 3，中文 Windows 必崩），维持本地版；selfcheck 6b 有"4+2 处修复不许丢"的断言守着 |
| 两包内的 `verify/` | 打包自校验副本，与 `skills/` 同内容，未入库 |

合并时对 `SKILL.md` 做了一处本地化：Run layout 的示例路径从 `D:\ChatGPT\video-prompt-runs` 改成
**认面板的过程目录约定**（面板派发 → 过程目录收中间产物；独立使用 → workspace 的 `video-prompt-runs\`）。

技能目录在**开机时**扫描注册；`skills/` 里新增技能后不必再重启 ——
设置页「生图」卡片的**「重扫技能包」**按钮（或 `POST /dvp/skills/reload`）会把新名字当场注册上。
注意 dsh-skill 对同名 runtime 技能是 **first-wins**：reload 只补新名字，**改已有技能的正文仍需重启**
（响应里会如实区分 `added` / `alreadyRegistered`）。

## 发布前检查（CI 与本地同一条命令）

push / PR 都会跑 `.github/workflows/ci.yml`，它做两件事：`npm ci`（只装 devDependencies）→ `npm test`。
本地跑的就是同一条命令：

```bash
npm install                    # 只装 devDependencies（react + react-dom，selfcheck 要用）；CI 用 npm ci
npm test                       # = node tools/run-all.mjs
node tools/run-all.mjs --list  # 只看清单：跑哪些、以及哪些被排除、为什么
```

**出网边界**：只有 `npm ci` / `npm install` 那一步出网（按 `package-lock.json` 装 devDependencies）。
`npm test` 本身**不出网** —— 不读真实媒体盘、不调模型、不做真实下载。

`tools/run-all.mjs` 把每套都跑完再汇总，任一套非 0 退出 ⇒ `npm test` 退出码 1 ⇒ CI 变红。
CI 用 Node 20/22/24 三档矩阵、windows-latest。

干净环境实测（`DSH_HOME` / `APPDATA` / `LOCALAPPDATA` / `USERPROFILE` / `DSH_APP_DIR` 全指空目录，
独立下载的 node，且先 `npm ci` 复现 CI 的全新检出），三档（Node 20/22/24）结果一致 —— **3/3 套件通过**：

| 套件 | 结果 |
| --- | --- |
| `tools/probe-host.mjs` | 187 项通过 |
| `tools/verify-watch-idle.mjs` | 18 项通过 |
| `tools/selfcheck.mjs` | 237 项通过 |

> `selfcheck.mjs` 原来因为"用 `createRequire` 从**本机 DSH 安装目录**解析 `react`/`react-dom`"被排除。
> 现在 `react`/`react-dom` 进 `devDependencies`，`run-all.mjs` 把 `DSH_APP_DIR` 指向**仓库根**，
> 于是本地与 CI 都不再依赖任何人的安装路径。

**未纳入 CI** 的套件（原因同时写在 `tools/run-all.mjs` 的 `EXCLUDED` 里）：
`tools/probe-live.mjs`（要真实媒体盘里的素材文件；它是探针脚本，不是断言式套件）。

## 安装（已经装好，这里是复现方式）

```bash
# DSH 关闭时，或让 DSH 里的 agent 执行（<本包目录> = 你自己放这个包的位置）：
node "<DSH 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add "link:<本包目录>/dsh-video-prompt"
```

安装器会：把 link 写进 `$DSH_HOME/profiles/web/package.json` 的 `dependencies`，
把 `dsh-video-prompt` 追加进 `dsh.profile.bundles`（作为组合最后一层），并在 `profiles/web/node_modules` 建 junction。
**装完必须重启一次桌面端**：新增 bundle 要重新扫描才会挂载，重启后客户端 bundle 才会进
`window.__DSH_BOOT__`、`/dvp/*` 路由才会起来。

### 媒体目录（每台机器不一样，本包不预设任何绝对路径）

| 层次 | 位置 | 说明 |
| --- | --- | --- |
| 默认 | `$DSH_HOME/dsh-video-prompt/media`、`.../runs` | 什么都不配时的落点，随机器走 |
| 面板 | 面板里填的路径 → `$DSH_HOME/dsh-video-prompt/state.json` | 优先级最高，改完刷新页面即可 |
| profile 层 | `$DSH_HOME/profiles/web/cordis.patch.yml` 里 `- id: video-prompt` 的 `config` | 多机各一份；`config` 整块替换，覆盖时把 `registerSkills` 一起写上 |

三种写法都支持 `~`、`$DSH_HOME`、`%DSH_HOME%` 展开。

面板上「保存」之后**当场生效**：`PUT /dvp/state` 会把运行期配置一起刷新，响应里回带
`effective: { mediaRoot, runsRoot }`（展开过 `~`/`$DSH_HOME` 的绝对路径）—— 换个盘不用重启宿主，
下一次落盘就打新目录。只提交某个字段时只改那个字段（`null` / 空串 = 明确清空，回落上一层配置）。

## 使用

1. 重启桌面端 → 新开会话 → 对话框旁出现 `▷ 提示词`。
2. 面板里填媒体文件夹绝对路径 → `扫描`。图片、视频、文档（md/txt）分三列，各带体积、时长/分辨率、处理状态；列表滑块在面板压矮时也完整可用。
3. 顶部「路径」二选一：主线（素材→提示词→生图）或爆款（视频/图片→爆款元素·蒸馏）。
4. 勾选要处理的项（支持整组全选/取消）→ 点主按钮。面板会先建过程目录（`process\年-月-日_时分-素材名\`），
   请求写进输入框（Enter 之前你还能改）；写入失败会自动改为复制到剪贴板。
5. 按 Enter 发送，agent 逐项产出，过程产物进过程目录、成品进产物目录。
6. 主线 + 只勾图片时，`用 Grok 生图` 可用：它先建**一个批次目录**
   `<mediaRoot>/grok-output/<批次ID>/`（批次 ID = `年-月-日_时分-<素材名>`，同一分钟重复派发自动加 `-2`），
   `plan.json` + `driver.md` + 来源文本 + 成图 + `ledger.json` 全在这一个目录里；
   再把驱动请求写进输入框，由会话里的 agent 用浏览器插件驱动你的 Edge 打开 grok.com 出图，
   每张图经 `/dvp/grok/save` 落盘（raw bytes 直传，带 `batch` 就进那一批，不带就进最新一批），
   宿主只回 `{file,bytes,sha256,width,height,status}` 元信息 —— 图片字节不进会话文本；
   最后用**本批的** `ledger.json` 对账。
   想重试某一批：把它的 `batchId` 回传给 `/dvp/grok/plan`（PUT/POST），写回同一目录，不新建。
   读回也一样：`GET /dvp/grok/plan` 不给参数 = 最新一批，`?batch=<批次ID>` = 指定批次。

## Grok 批次目录（P1 数据覆盖修复）

**旧行为（已修）**：`plan.json` / `driver.md` / `source-*.md` / 成图全写在固定的
`<mediaRoot>/grok-output/` 平面里 —— 新批次盖掉旧批次，同名 slug 的图互相盖，
而 `ledger.json` 是追加的，于是**账本上两条批次记录、盘上只剩最后一批**。

**现在**：一批一个目录，目录名就是批次 ID（`年-月-日_时分-<素材名>`，同分钟重复派发加 `-2`）：

```text
<mediaRoot>/grok-output/
├─ index.json                          # 可选加速件：latest + 批次清单；缺失/损坏都能读批次
├─ 2026-09-14_1238-门廊按铃/            # 一个批次 = 一个目录
│  ├─ plan.json  driver.md
│  ├─ source-<label>.md                # 本批的来源文本（几万字不进对话）
│  ├─ 01-<slug>.jpg  …                 # 本批成图（文件名规则不变）
│  └─ ledger.json                      # 本批的账，items[].file 都指回本批产物
└─ 2026-09-14_1240-荧光药剂/            # 另一批，互不影响
```

接口约定：

| 调用 | 行为 |
| --- | --- |
| `POST/PUT /dvp/grok/plan`（不传批次身份） | 新建批次目录，响应回 `batchId` **与 `saveNonce`**（存图那把钥匙，见「Grok 出图的实测硬约束」三道门） |
| `POST/PUT /dvp/grok/plan` + `batchId`（或 `batch`/`dir`） | 续做/重试这一批，写回同一目录，并**换发**新 `saveNonce`（旧的立刻作废） |
| `GET /dvp/grok/plan` | 最新一批（`dir`/`plan` 字段名不变，另带 `batchId`/`batches`；`plan` 里**不含** `saveNonce`） |
| `GET /dvp/grok/plan?batch=<id>` | 指定批次；`?batch=legacy` = 旧版平铺布局 |
| `POST /dvp/grok/save` + `batch` + `nonce`（raw bytes 请求体） | 图落进那一批；不传 batch 则进最新一批。nonce 缺/错 403、非图片字节 415。响应只有元信息，字节不回吐 |
| 旧布局 `<mediaRoot>/grok-output/plan.json` | 仍读得到（算一个历史批次），但**不再被写入** |

拿不准批次时：`GET /dvp/grok/plan` 看 `batchId` 与 `batches`，拿 `batchId` 去和 `ledger.json` 对齐。
`batchId` 只接受单个目录名（不含 `/` `\` `:` 与 `..`），非法一律 400。

批次的派发请求里只带**来源文本的材料引用**（材料 ID = `source-<批次ID>`、文件路径、字数），
正文一个字都不进请求；`plan.json` 同样只记 `sourceFile` / `sourceChars`。

## 统一任务记录（`run.json`）：状态 / 当前步骤 / 失败原因 / 产物位置

一条记录 = **一个批次**。它是 `plan.json` + `ledger.json` + 盘上事实推导出来的**物化视图**，落在该批目录里：

```text
<mediaRoot>/grok-output/<batchId>/
├─ plan.json  driver.md  source-<label>.md
├─ ledger.json      # 追加式账本：盘上真有什么（一批一本，只增不改）
├─ run.json         # 任务记录：状态/当前步骤/失败原因/产物位置（丢了能重算）
└─ 01-<slug>.jpg …
```

**为什么不往 `ledger.json` 上加字段**（三条理由，也写在 `index.js` 同名注释里）：
① 账本是**追加式**的（每落一张图 push 一条）——为了改状态去重写它，它就不再是账本；
② 还没落任何图的新批次**根本没有** `ledger.json`，而任务记录从建批次那一刻就该存在；
③ 记录是**可重算**的，账本与产物一条都不能少 —— 能重算的东西单独放一份，别污染事实记录。

| 字段 | 含义 |
| --- | --- |
| `runId` / `batchId` | 一条记录就是一个批次，两者同值 |
| `status` | `pending` / `running` / `partial` / `succeeded` / `failed` / `cancelled` |
| `step` | 当前步骤：`plan` 待派发 → `dispatch` 驱动中 → `collect` 收图中 → `verify` 产物校验未过 → `done` / `cancelled` |
| `counts` | 总项数 / 成功 / 失败 / 未跑（账上多出来的条目另记 `orphans`，不污染这三个数） |
| `failures` | 逐项失败要点 = **「仅重试失败项」的输入清单**（见下） |
| `artifacts` | 每个产物的绝对路径、相对路径、字节数、sha256、序号、slug、落盘时间 |
| `control` | 唯一推导不出来的东西：谁登记了 begin/cancel、何时、为什么（含历史） |
| `createdAt` / `startedAt` / `updatedAt` | 建立 / 开始 / 最近一次变化（都取自事实，不另编时间） |
| `warnings` | 解释性说明（例：`plan.json` 读不到、账上有计划外的产物、旧账本条目缺 sha256） |

状态判定顺序**固定**（先满足的先算）：全部项都有可校验产物 → `succeeded`；有取消标记 → `cancelled`；
有人登记过 `begin` 且未过期（2 小时）→ `running`；有成的也有没成的 → `partial`；一个都没成且有真失败 → `failed`；
其余 → `pending`。恒等式恒成立：`succeeded + failed + missing === total`。

**步骤是推导出来的，不是会话自述**：`running` / `dispatch` 只在有人显式登记时出现 ——
宿主看不到那个浏览器会话，也不猜；一个没清掉的 begin 标记过了 2 小时就自动失效（`warnings` 里写明）。

### 查询（只读，不写任何文件）

| 调用 | 行为 |
| --- | --- |
| `GET /dvp/grok/run?batch=<id>` | 该批明细。默认 **sha256 档**：逐项重算哈希，能抓出"文件被改过" |
| `GET /dvp/grok/run?batch=<id>&driver=1` | 另附「仅重试失败项」驱动清单（markdown） |
| `GET /dvp/grok/run?batch=<id>&verify=stat` | 只做存在性与字节数校验（列表/轮询用，不读图片字节） |
| `GET /dvp/grok/runs?limit=N` | 最近 N 批（默认 20、上限 50）的状态/步骤/计数/待重跑条数 |
| `GET /dvp/grok/plan` | 既有路由，另外顺带回同一份 `record`（不用打两次） |

只读的边界是**真的只读**：不建目录、不动 `index.json`、不给旧批次补 `run.json` ——
断言里对整个 `grok-output` 树做 sha256 前后比对（逐文件相同）。
记录与清单里**不含 nonce**（那把钥匙只沿"派发"那条线走；清单只告诉你去本批 `plan.json` 里读它）。

诚实说明：**面板 UI 还没接这一节** —— 记录目前只走路由（`curl` / agent / 以后的界面），
面板上的状态列仍然只读它们各自的那份 `plan.json`。

### 三个能力的实际支持程度

| 能力 | 支持到什么程度 |
| --- | --- |
| **续跑** | **支持**。机制是既有的：`POST/PUT /dvp/grok/plan` 带 `batchId`（或 `batch`/`dir`）写回同一目录并换发新 nonce，只补没落的那些项。宿主侧额外做两件事：把这次重发登记成 `begin`（`by=plan-reissue`，状态变 `running`）、并**解掉已有的取消标记**（历史里留一条 `resume`）。 |
| **仅重试失败项** | **只做到清单输出，不自动重跑**。判据四项之一（也就是 `failures[].reason`）：`never-run` 从未落图、`file-missing` 产物文件已不在盘上、`bytes-mismatch` 字节数不符、`sha256-mismatch` 哈希不符（最后一项只有 sha256 档查得出）。清单给出"重跑哪几项 + 每项为什么 + 落盘命令 + 提示词正文"，并**明确不新建批次**（新建会另起目录，本批永远补不齐）。宿主不驱动浏览器，"照清单重跑"这一下由会话里的 agent 做。 |
| **取消** | **只记语义，不是真中断**。执行者是会话里的浏览器插件（持用户的 Edge 登录态），宿主看不到那个进程、没有东西可杀 —— 所以 `action:"cancel"` 只写下"谁、何时、为什么"。它**不动产物**（断言里比对字节与 mtime）、也不改计数。误标了用 `action:"clear"` 清掉；取消之后重发 plan 就是续跑。 |

登记状态的唯一写入口（只写该批 `run.json` 的 `control` 段，`plan.json` / `ledger.json` / 产物一个字节都不碰）：

```bash
curl -X POST http://127.0.0.1:<端口>/dvp/grok/run -H 'Content-Type: application/json' \
  -d '{"batchId":"2026-09-14_1238-门廊按铃","action":"cancel","by":"面板","reason":"额度用尽，先停"}'
```

`legacy`（旧版平铺布局的只读别名）**不接受**状态登记 —— 它连 `run.json` 都不写，读它只走 derived 推导。

## 派发历史（`/dvp/manifest` 的 `runs`）

每次派发写一条历史（时间、路径、条数、过程目录）。面板每次只提交**最新一条**，
宿主按 `run.id` **追加并去重**（旧记录没有 id 时退到 `at|kind|processDir` 指纹），
保留最近 **30 条**（`RUN_HISTORY_LIMIT`，写在 `index.js` 里）；响应回带 `runCount`。
直接覆盖是旧行为，界面上表现为"派发过几次，历史里只剩最后一次"。

## 边界与诚实说明

- **路径围栏**：宿主只服务 `mediaRoot`、`runsRoot`、工作区根之内（或面板里记住过）的路径，越界返回 403。
- **Grok 全自动的风险**：自动化操作第三方站点可能违反其服务条款，也可能触发风控；只在你自己的账号上小批量跑。
  遇到未登录、人机验证、额度用尽，流程会**停下来叫人**，不做绕过。
- **ffprobe 是可选依赖**：找不到时视频时长/分辨率显示为空，不影响分流与派发。可用 `FFPROBE_PATH` 指定。
- **改完哪半边要重启**：只改 `client.js` → **刷新页面**就够（宿主按内容哈希重新发 bundle）；
  动了 `index.js`（路由、扩展名清单、扫描层数默认值、清晰度白名单、状态清洗、驱动清单）→
  **必须重启 DSH Desktop**。实测两件事：① 往 `profiles/web/cordis.patch.yml` 加注释**不会**触发
  web profile 重载；② 面板会照常打开、选项照常能填，但旧进程会静默丢掉它不认识的东西 ——
  例如 `PUT /dvp/state` 只存下 `aspect`/`count`、把 `clarity: 720p` 吞掉，`/dvp/source` 也不存在。
  **别只看面板长得对就以为通了**：改完 `index.js` 之后要用 `PUT /dvp/state` 回读一次
  `grokOptions.clarity` 是否被采纳，作为"新宿主真的起来了"的判据。
- **预览页的桩数据**：面板的独立预览页（`/dvp/preview/`）优先打真宿主路由，宿主不在时才退到本地桩，
  所以它不会替你"假装成功"。

## 自检

```bash
node tools/selfcheck.mjs        # 243 项：静态契约、纯函数、槽注册、面板渲染、布局分配、技能包、热重扫、本地文件读取、镜像一致性
node tools/probe-host.mjs       # 190 项：把 apply() 挂到真 node:http 上，打真 /dvp/* 路由（临时 fixture）
node tools/verify-grok-bytes.mjs # 207 项：字节不进会话 + 三道门 + 统一任务记录（状态/续跑/取消/只读）
node tools/probe-live.mjs       # 24 项：对真实媒体根目录跑扫描/分流/状态/Grok 产物核对（只读）
node tools/sync-servable.mjs    # 改完 client.js 后同步预览页那一份（不跑就地同步会被 3f 断言拦住）
```

`probe-host.mjs` 覆盖：路由注册、扫描分流与 `depth` 语义、路径围栏（越界 403、非图片扩展名拒绝）、
图片字节（PNG 魔数校验）、文本读取、manifest 写读回、运行目录落盘、Grok 批次与图片保存、静态预览页、
静态预览的路径穿越防护、`ctx.skills.register` 的真实注册内容（含 frontmatter 块标量解析）。
`verify-grok-bytes.mjs` 的第 5 节覆盖统一任务记录：一次成功批次的记录与产物齐全、部分缺图 ⇒ `partial` 与失败项清单、
续跑 / 仅重试失败项的输出、取消语义、**只读查询不写盘**（整树 sha256 前后比对）、旧批次向后兼容。
两套都全绿才输出 `全部通过：N 项检查`。

## 已修的坑（都是实测出来的，不是猜的）

1. **`depth` 语义错位**（严重）：原实现把传入值与当前层直接比较，默认 `depth=1` 时**一个子目录都不进**。
   而最常见的摆法就是 `media/images`、`media/videos` —— 面板会显示 0 张图片 0 个视频。
   已改为"给定目录之外的递归层数"（0 = 只看这一层），默认 2 层，并在 `probe-host.mjs` 留了回归用例。
2. **YAML 块标量解析**：`prompt-videos` 的 frontmatter 用的是 `description: >`（折叠块）。
   原解析器只认 `key: value` 单行，description 会变成字面量 `>`，技能目录里就会出现一个
   只有 1 个字符描述、说不清干什么的技能。已支持 `>`/`|` 两种块标量并端到端验证解析结果。
3. **`watch` 的 ffmpeg 调用在中文 Windows 上必崩**：上游 `frames.py`/`whisper.py` 用
   `subprocess.run(..., text=True)`，默认按系统区域（GBK）解码 ffmpeg 的 UTF-8 stderr，
   抛 `UnicodeDecodeError` 后 `result.stderr` 变 `None`，下一行 `finditer(None)` 直接 `TypeError`。
   已给 6 处加 `encoding="utf-8", errors="replace"`（本包 skills 内副本已修）。
4. **Grok 批次会把文档前言当成提示词**：原切分把第一个标题之前的行归为一条，
   于是"文档标题 + 人物/风格锚点"变成两条假提示词（实测 4 张图解析出 5 条）。
   已改为丢弃前言段、按锚点标题与最小长度过滤，并对 `runs/demo-01/optimized-image-prompt.md`
   的真实文档留了"恰好 4 条"的回归用例。
5. **产物目录被当成素材扫回来**（实盘暴露）：`media/grok-output/` 是本插件自己的成图产出，
   扫描时却被算进图片组——实测扫出 8 张图，其中 4 张是上一轮 Grok 成图。
   面板默认全勾选，点「用 Grok 生图」就会**把 Grok 的产出再喂回 Grok**。
   已把 `grok-output` 加进 `SKIP_DIRS`，并在 `probe-live.mjs` 留了"图片恰好 4 张、产物不参与扫描"的回归。
6. **面板比视口高，底部按钮点不到**（2026-09-11 实测）：输入条贴在屏幕中下部时，面板往下展开会
   整块落到视口外（实测面板 y 744→1329、视口只有 805）；顶部那种"面板贴底就向上翻"的判定也救不了——
   上下都不够时它仍然溢出。另外 `.dvp-panel>*{flex:0 0 auto}` 会以更高特指度吃掉
   `.dvp-body{flex:…}`，中段根本不收缩。
   现在改成：**先量输入条位置决定向上/向下展开并算出可用高度（`--dvp-room`），再由 `layoutPanel()`
   按实测值把中段高度顶死**，装不下就让面板整体可滚；底部说明压成一行、按钮行 `nowrap`、
   媒体列表 `27vh` 上限、正文框默认收起。回归用例在 `selfcheck.mjs` 的 3e/3e2 两段。
   注意 `layoutPanel` 是由 `flipPanelIntoView` **直接调用**的：先试过放在另一个 `useEffect` 里，
   实测出现"effect 计数在涨、函数却没执行到"，不要再改回去。
7. **预览页演的是旧代码**：`/dvp/preview/` 由宿主按 `servable/` 白名单目录提供，
   它引用的 `./client.js` 是一份**独立副本**。改完包根 `client.js` 忘了同步，就会出现
   "预览页看得见、DSH 里看不见"的假象（第一次改完 UI 就踩了：预览页还是旧面板）。
   已加 `tools/sync-servable.mjs`，并在 selfcheck 3f 段用 sha256 断言两份必须一致。
8. **面板背景是透明的**：面板原来用 `var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-base, #fff))`，
   两层别名任一被主题改成半透明，面板就会透出后面的消息内容。现在背景写死实色 token（`#fff` 兜底），
   再压一层同色 `background-image` 和 `isolation:isolate`。
9. **素材列表没有滑块、只看得见两格**（用户反馈）：列表原来只有 `max-height:min(27vh,240px)`，
   没有固定高度也没有可见滑块——素材一多就靠外层面板滚，看着像"只剩两格"。
   现在两列各自 `height:min(30vh,280px); min-height:132px` + `overflow-y:auto` +
   加粗的 webkit 滚动条；面板中段下限 `PANEL_BODY_MIN` 也抬到 220，保证装得下列表。
10. **扫描层数太浅，盘里有图面板里没有**（用户反馈）：`/dvp/scan` 默认 `depth=2`，
   而最常见的摆法是「一部剧/一本书一个子目录」，2 层只扫到一半。默认改 4（上限 8），
   面板加了「层数」下拉可以现场调；`probe-host.mjs` 里造了 `books/vol1/ch01/frames/deep.png`
   做回归（默认层数必须扫到它，调到 1 层必须扫不到）。
11. **扩展名收录不全**（用户反馈"格式要都收录进来"）：图片补上 `jpe/jfif/tif/tiff/svg/heic/heif`，
    视频补上 `mts/m2ts/ogv/flv/wmv/mpeg/mpg/3gp`，文本补上 `markdown/text/log/ini/conf`。
    更关键的是**宿主与客户端的清单必须逐项一致**：面板列不出来就选不进出图批次，
    所以 `probe-host.mjs` 加了一条把两份源码里的 `IMAGE_EXT/VIDEO_EXT/TEXT_EXT` 抠出来比对的断言
    （实测第一次就把 `csv/srt` 的顺序写反了）。
12. **大纲一展开，底部按钮被顶出面板**：大纲正文约 400px 高，同时展开素材列表与生图要求时，
    面板要多滚 489px 才够。现在大纲展开时临时收起这两块，大纲正文自己滚；
    另外 `layoutPanel` 的"下限不能大于可用空间"也修了（原来 `PANEL_BODY_MIN` 直接当底线，
    面板会带着它顶出视口）。
13. **md 文档在面板里完全隐形**（用户反馈"生图插件不能识别 md"）：宿主扫描其实早就把
    `TEXT_EXT` 归好类返回（`texts` 数组），但面板只渲染视频/图片两列，文档收了也不显示；
    并且 `GET /dvp/file` 的围栏写成了只对 `mediaRoot` 解析，产物目录里的章纲报"越界"。
    现在：三列分流、文档可勾选并随派发/出图/爆款三种请求各得其所；围栏对所有允许根生效
    （`probe-host.mjs` 留了"runs 里的 md 可读 + 真越界仍 404"两条回归）。
14. **四个文件就滚不动**（用户反馈）：`.dvp-list` 原来写死 `height:min(30vh,280px)`，
    面板中段被 `layoutPanel` 压矮时，列头以下多出来的部分（含滑块底段）被
    `.dvp-col{overflow:hidden}` 直接裁掉——最后一两项看不见也滚不到。
    现在列表高度由 `layoutPanel` 按实测空间写进 `--dvp-list-h`（列头 42 + 列表 = 中段高，
    列表下限 64），内容自然高改按"条目数 × 实测行高"估算（读 DOM 固定高会反馈死锁，
    涨不回去）；装不下时中段**不再被压矮**，改为面板整体滚动。
    顺带挖出真根因：**面板自己的 `wrapRef` 从未挂到 DOM 上**，它的每轮 flip effect 与
    ResizeObserver 一直在空跑（就是旧记录里"effect 计数在涨、函数却没执行到"的真相）——
    现在 `ref: wrapRef` 挂在面板根节点，`flipPanelIntoView` 用 `findPanelNode`
    兼容"传外层 wrap"和"传面板本身"两种锚点（锚点仍优先取非面板节点，避免上翻后自测错位）。
    回归断言在 selfcheck 3e 的 `--dvp-list-h` 三条与 3e2 的 wrapRef/findPanelNode 两条。
15. **过程产物混进素材池**（实盘暴露）：上一轮 `watch` 拆的 `frame_0001~0015.jpg` 直接躺在
    `media/images/` 里，扫描出来 19 张"图"，跟 4 张源关键帧混在一起。新增 `/dvp/process`
    过程目录（`<runsRoot>\process\年-月-日_时分-素材名\`，预建 `frames\`），派发请求里写明
    归位路径；散落的帧已迁到 `runs/process/*_cleanup-sweep-frames/`，probe-live 的
    "图片恰好 4 张"恢复成立。
16. **probe-live 断言漂移**：宿主默认层数从 2 改到 4 时只更新了 probe-host，probe-live 还在
    断言 `depth === 2`，一直红着（用户环境里跑了很久没人发现）。已对齐为 4，并明确：
    **改默认值要三个测试一起过**（selfcheck / probe-host / probe-live）。
17. **「加文本文件」选得到、读不出**（用户反馈"读取md还是出错"）：点按钮能弹出系统选择框、
    选完文件后报 `读取文本文件失败：Failed to execute 'getFile' on 'FileSystemFileHandle':
    The request is not allowed by the user agent or the platform in the current context`。
    根因：老实现走 File System Access API，而**在 DSH 桌面端（Electron 渲染进程）里
    `window.showOpenFilePicker` 是存在的**（实测 `typeof === 'function'`），所以那层
    "支持性检查"顺利通过，真正被平台拒绝的是随后的 `handle.getFile()` —— 权限在读取那一刻才被拒。
    现在「加文本文件」和「本地挑文件夹」都改走**原生 `<input type="file">`**（文件夹用
    `webkitdirectory`，顺带获得递归子目录与相对路径；原来只读一层），读文本优先 `File.text()`、
    退回 `FileReader`，并监听 `cancel` 以免用户取消时 Promise 挂死；顺手删掉从未被读过的
    `localHandle` 死字段。selfcheck 新增 6 条断言（含"不许再出现 FSA 调用形式"）；
    活宿主实测：分发的 bundle 里有 `pickFiles`/`readTextFile` 且无 FSA 调用，
    并在真内核里用 `input[type=file]` + `File.text()` 把一段 md 内容读回来了。
    「按路径加」（宿主 `GET /dvp/file`，白名单内）本来就是好的，仍是确定可用的那条路。
18. **Grok 批次共用一个目录，新批次覆盖旧批次**（审计定 P1）：`grok-output` 是固定目录，
    `plan.json` / `driver.md` / `source-*.md` / 成图全写在同一个平面里 —— 新批次的 `plan.json`
    直接盖掉上一批，同名 slug 的图互相盖；而 `ledger.json` 是**追加**的，于是盘上只剩最后一批、
    账上却留着两条批次记录，`ledger.items[].file` 指向已被覆盖的文件（**账本与产物对不上**）。
    同文件的 `/dvp/process`、`/dvp/run` 早就在用"一跑一个唯一目录"，这条线没跟上。
    现在每批一个目录 `<mediaRoot>/grok-output/<批次ID>/`（`batchId = 年-月-日_时分-<素材名>`，
    同分钟重复派发加 `-2`），该批的 `plan.json`/`driver.md`/`source-*.md`/成图/**本批 ledger.json**
    同处一目录；传 `batchId` 即续做/重试（写回原目录），GET 不传参读最新一批、`?batch=<id>` 读指定批次，
    旧平铺 `grok-output/plan.json` 仍读得到（`?batch=legacy`）且不再被写入。
    `probe-host.mjs` 新增 8c 段 45 条断言覆盖这些路径（批次隔离/重试/最新与指定/旧布局兼容/越界拒绝/索引容错）。

## Grok 出图的实测硬约束（2026-09-11 在真实页面验证）

这一节是拿真实账号跑过一次之后写的，不是推测：

| 观察 | 结论 |
| --- | --- |
| 成图 URL 形如 `assets.grok.com/users/<uid>/generated/<id>/image.jpg` | 带签名 |
| 用 node 直连该 URL | **403** |
| 页面内不带凭据 `fetch` | **0 字节** |
| 页面内 `fetch(url,{credentials:'include'})` | **成功，259316 字节，784×1168 竖版** |
| 出图过程中取图 | 拿到的是**点阵占位**（页面上是 canvas），此时"已生成"的文案已经出现 |
| 点 UI 的 Download 按钮 | 自动化附加模式下**不落盘**，`downloads/` 空 |

所以：**取图必须发生在已登录的页面上下文里，且必须等到流式输出收尾**
（`Stop model response` 消失 / 出现 `Download`·`Make video` 工具条）再去读，
否则会拿到空壳。`tools/grok-shot.mjs` 的 `grokRecipe()` 已按这个结论写死步骤。
存图时**带上批次 ID**（`POST /dvp/grok/save` 的 `batch` 查询参数，或 JSON 体的 `batchId`），
并带上该批次的 **nonce**（建批次时响应里的 `saveNonce`），图才会进它所属的那一批目录。

`/dvp/grok/save` 现在有**两种请求体**：

| 体 | 用途 | 谁在用 |
| --- | --- | --- |
| **raw bytes**（首选） | 请求体就是图片字节本身，`?batch=&index=&slug=&ext=` 走 URL 参数 | 会话里的 agent：页面上下文 `fetch` 成 `arrayBuffer` 后**原样 POST**，宿主回 `{ok,status:"saved",file,bytes,sha256,width,height}` |
| JSON `{ base64 \| url }` | 兼容旧调用方与别的图源 | 宿主侧工具；**URL 那条路对 Grok 不可用**（403），留着是给别的图源 |

**图片字节（含 base64）任何情况下不进会话文本**：1 MiB 图 ≈ 140 万字符 base64，既爆上下文，
又会被工具结果上限在分块搬运时截坏（截到的 base64 落盘就是坏图，且账上记成功）。
raw 直传下请求体里的 base64 字符数是 **0**，会话只收路径/字节数/sha256/宽高/状态
（`tools/verify-grok-bytes.mjs` 就是这么量化的：同样一张 1 MiB 假图，旧路径会话文本 1,398,527 字符、
其中 base64 1,398,444；新路径元信息 211 字符、其中 base64 **0**）。
这一条路由必须回 CORS——不放，页面内直传就永远读不回元信息，agent 只能把字节搬回会话里再 POST，
正是要防的绕行。但**不是** `Access-Control-Allow-Origin: *`：那等于告诉浏览器"任何被访问过的网页
都能读写这条本机端点"。现在这一条路由有三道门（`index.js` 里集中定义，`tools/verify-grok-bytes.mjs`
逐条断言正反两面）：

| 门 | 口径 | 被拒的样子 |
| --- | --- | --- |
| ① CORS 白名单回显 | 只回显**请求自己的 Origin**（`https://grok.com`、`https://x.ai` 及其子域；判据是解析后的 hostname，不是字符串后缀——`grok.com.evil.example` 这类伪装域不算），并带 `Vary: Origin` | 白名单外的源**一个 CORS 头都不回** + 403（跨源 JS 连错误信息都读不到，写也写不进去） |
| ② 批次 nonce | 建批次（`POST/PUT /dvp/grok/plan`）时宿主发一把随机 nonce，回在响应里、写进该批 `plan.json`、随驱动清单与面板派发请求交给会话；存图时用 `?nonce=` 或请求头 `X-DVP-Nonce` 带上，缺/错一律 403 | 403；重发同一批会换新 nonce，旧的那把立刻作废。`GET /dvp/grok/plan` **不回吐** nonce（那是跨源读得到的只读端点） |
| ③ 图片魔术字节 | 按魔数收 PNG/JPEG/GIF/WebP，不看扩展名与 content-type（页面直传常常是 `application/octet-stream`） | 415，并在错误里回带请求体前 16 字节便于现场对账 |

写入位置仍被批次目录围栏挡在 `grok-output/<batchId>/` 里（门①②③之外另有一道）。
运维要给别的来源临时开口：`DVP_GROK_SAVE_ORIGINS="https://a.example"`（只按 origin 精确匹配）；
本机无浏览器调用方要免 nonce：`DVP_GROK_SAVE_ALLOW_ANON=1`（默认关）。
两道逃生口都只认环境变量，不会因为某个请求长得像旧版就被自动打开。

**取图的三条通道，按推荐顺序**：

| 通道 | 怎么做 | 边界 |
| --- | --- | --- |
| ① 页面内读字节（首选） | `fetch(url,{credentials:'include'})` → `arrayBuffer` → **原样 POST** `/dvp/grok/save?batch=&index=&slug=&nonce=`（raw bytes） | 需要宿主路由在；nonce 必带（见上表门②），响应只回元信息，字节不进会话 |
| ② 浏览器磁盘缓存 | `node tools/scan-cache.mjs --bytes <体积> --out <批次目录> --name <文件名>` | 只对**已完整显示过**的图有效；体积撞车要验签名；缓存会被轮转，尽早取 |
| ③ 用户点一次 Download | `node tools/watch-downloads.mjs --out <批次目录>` 接住并自动改名写账 | 需要人点；自动化附加模式下点按钮不落盘 |

②③ 都是**盘到盘**：字节从浏览器缓存/下载目录直接进批次目录，会话里只走路径 + 字节数 + sha256。
旧版"宿主不可用就把 base64 按每 20k 字符分块交回会话再写盘"的兜底**已删除**（2026-09-15）；
`tools/verify-grok-bytes.mjs` 里有一条断言盯着这个：配方文本中每处"分块"附近必须有禁止性措辞，
否则算旧通道复活。

③ 的退出判据：从**最后一次成功收图**开始算空闲，默认连续空闲 20 秒才收工，且只在收过图之后
才允许按空闲退出。收到图就把计时归零，所以"边投提示词边出图"的长批次不会被半路掐断
（旧实现按"空闲轮数"计且收到图不重置，第 5 轮必定退出）。到 `--minutes` 上限则按"等满时限"收工。
也可以 `import { watchDownloads }` 直接用（可注入 `clock` / `sleep`，`tools/verify-watch-idle.mjs` 就是这么离线验的）。

② 是 2026-09-11 实测走通的那条：Grok 成图显示过之后，按 259316 字节在 Edge 缓存里命中
`f_001527`，取出后 sha256 与页面内读到的一致，`read_image` 正常解码成 784×1168。
首张成图落盘为 `media/grok-output/01-01-门廊按铃.jpg`（259316 字节）并写入 `ledger.json` ——
这是**旧版平铺布局**的路径；新版一律落 `<mediaRoot>/grok-output/<批次ID>/`，
旧平铺目录仍读得到（`GET /dvp/grok/plan` 不传参在没有任何批次时返回它，`?batch=legacy` 显式读），
但不会再往里写新批次。详情见下方「Grok 批次目录（P1 数据覆盖修复）」。
