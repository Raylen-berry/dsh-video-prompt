# 变更记录

## 未发布 — 统一任务记录（`run.json`）：状态 / 当前步骤 / 失败原因 / 产物位置，支撑续跑 · 仅重试失败项 · 取消

**问题**：一条"视频流水线任务"的进度散在四处 —— `plan.json`（要做什么）、`driver.md`（谁去做）、
`ledger.json`（落了哪几张图）、`/dvp/manifest` 的 `runs`（面板派发历史）。想知道"这一批现在到哪一步、
哪几项失败了、为什么失败、产物在哪"得自己把四份东西对起来，而且**没有任何地方回答得了"还差几项"**。
取消 / 续跑 / 仅重试失败项也没有载体：批次重试只能靠"把 `batchId` 传回 `/dvp/grok/plan`"，
而"到底哪几项该重试"完全靠人肉比对账本与计划。

**核实**（动手前先读清楚，三条结论直接决定了做法）：

1. **续跑有现成机制**：`POST/PUT /dvp/grok/plan` 带 `batchId`（或 `batch`/`dir`）写回同一目录、换发新 nonce；
   `POST /dvp/grok/save?batch=<id>` 也按批次目录落图。于是"续跑"= 重发 plan + 只补没落的那几项。
2. **"仅重试失败项"不存在**：没有任何代码把 `plan.entries` 与 `ledger.items` 对起来算差集。
   这个领域里最自然的定义就是这个差集：本批计划有 N 项，账本里没有的（从未落图）、
   账本里有但盘上文件没了 / 字节或哈希不符的 ⇒ 该重跑。
3. **取消不存在，也没有真中断机制**：执行者是**会话里的浏览器插件**（它持用户的 Edge 登录态），
   宿主根本看不到那个进程，没有任何东西可杀。所以只做**显式语义**：谁、何时、为什么把它标成取消。
   不新造杀进程逻辑。

**改法**：

1. **另起一本 `<批次目录>/run.json`，不往 `ledger.json` 上加字段**（三条理由写进 `index.js` 同名注释）：
   账本是**追加式**的（为了改状态去重写它，它就不再是账本）；还没落图的新批次**根本没有**账本；
   而 `run.json` 是**可重算的物化视图**（源：`plan.json` + `ledger.json` + 盘上事实 + `control`）。
   唯一推导不出来的 `control`（谁登记了 begin/cancel、何时、为什么）才需要显式写进去。
2. **一条记录 = 一个批次**：`runId`/`batchId`、`status`
   （`pending`/`running`/`partial`/`succeeded`/`failed`/`cancelled`）、`step`（当前步骤）、
   `counts`（总数/成功/失败/未跑/账上多出来的）、`failures`（逐项失败要点 = 「仅重试失败项」的输入清单）、
   `artifacts`（每个产物的路径/相对路径/字节/sha256/序号/slug/落盘时间）、`orphans`、`warnings`、
   `control`、三份文件位置、开始与更新时间。恒等式 `succeeded + failed + missing === total`。
   状态判定顺序固定；`running`/`dispatch` **只在有人显式登记 begin 时出现**（宿主看不到那个浏览器会话，不猜），
   且 begin 标记 2 小时过期（否则一个没清掉的标记会永远显示运行中）。
3. **查询入口（只读，不写任何文件）**：`GET /dvp/grok/run?batch=<id>`（默认 sha256 档，逐项重算哈希）、
   `&driver=1` 附「仅重试失败项」驱动清单、`&verify=stat` 只做存在性与字节校验；
   `GET /dvp/grok/runs?limit=N` 列最近若干批；既有 `GET /dvp/grok/plan` 顺带回同一份 `record`。
   记录与清单里**不含 nonce**（那把钥匙只沿"派发"那条线走）。
4. **状态登记**（唯一会写 `run.json` 的路径）：`POST /dvp/grok/run`
   + `{batchId, action: begin|cancel|clear, by, reason}` —— 只动 `control` 段，
   `plan.json` / `ledger.json` / 产物一个字节都不碰。`legacy` 只读别名不接受登记。
5. 写盘路径（建批次、存图）顺手刷新 `run.json`；写失败**不翻转成失败**（图已经在盘上，记录可由源重算）。
6. 三个能力的实际支持程度写进 README 对照表：**续跑**支持（复用既有机制，重发 plan 会登记 begin 并解掉取消标记）；
   **仅重试失败项**只做到**清单输出、不自动重跑**（宿主不驱动浏览器）；**取消**只记语义、**不是真中断**。

**数字**（`tools/verify-grok-bytes.mjs` 离线断言，本机实测）：

| 口径 | 结果 |
| --- | --- |
| 新增断言 | 121 → 207 项（其中「统一任务记录」段 86 项：5a 纯函数 34 · 5b 一次成功批次 10 · 5c 续跑与仅重试失败项 17 · 5d 取消 9 · 5e 向后兼容 6 · 5f 列表 6 · 5g 只读审计 4；另有 probe-host 补 2 项路由登记，188 → 190） |
| 全仓套件 | `npm test` 4/4 通过、**658 项检查**（probe-host 190 + verify-watch-idle 18 + verify-grok-bytes 207 + selfcheck 243），退出码 0 |
| 反向验证（新断言指向改动前 `6c4d259`） | **71 / 207 项失败**（新路由全 404、纯函数出口全缺失；旧 121 项仍全绿 ⇒ 失败全部落在新能力上，脚本未崩、跑完给出汇总） |
| 只读边界 | 打完整一轮只读查询后，整个 `grok-output` 树逐字节不变（35 个文件：相对路径+字节数+sha256 全部相同） |
| 旧批次兼容 | 没有 `run.json`、账本条目是旧字段的批次照样读得出（`source: "derived"`），且读它**不会**补出一份 `run.json` |

反向验证用 `git worktree add <临时目录> 6c4d259` + 只把新的 `tools/verify-grok-bytes.mjs` 拷过去，
跑完 `git worktree remove --force`（不用 `git stash`）。三道门（CORS 白名单/nonce/魔术字节）与
"每批一个目录、一批一本账"的语义**一个字没动**。

## 未发布 — /dvp/grok/save 收口：CORS 白名单回显 + 批次 nonce + 图片魔术字节

**问题**：上一轮为了让"页面内直传图片字节"能读回元信息，把这一条本机路由的 CORS 写成了
`Access-Control-Allow-Origin: *`。头本身是必要的（图是在 **grok.com 那个跨源页面**里读出来再 POST 回
127.0.0.1 的），但 `*` + 无鉴权 ⇒ **任何被访问过的网页**都能 POST 到这个本机端点：
写入虽被批次目录围栏限制，仍等于开了一个"任意网页可写（图片/任意字节）+ 可读元信息（路径/哈希/宽高）"的口子。

**核实**（动手前先读清楚）：页面侧脚本是 `tools/grok-shot.mjs` 的 `grokRecipe()` 生成的
「给浏览器插件的操作清单」里的那段 JS —— 它由 `browser_eval` 在页面上下文里执行，POST 的 URL
（`?index=&slug=&batch=&ext=`）与请求头都由这段 JS 自己拼。**结论：能携带额外参数**，
所以 nonce 方案成立，不必退化成"只做白名单"。

**改法**（三道门，集中定义在 `index.js` 顶部同名注释段）：

1. **白名单回显**：`GROK_SAVE_ALLOWED_ORIGINS = ['https://grok.com', 'https://x.ai']` 及其子域；
   回显**请求自己的 Origin**（不再回 `*`），并带 `Vary: Origin`。判据是解析后的 hostname，
   不是字符串后缀 —— `grok.com.evil.example` / `notgrok.com` / `http://grok.com`（协议降级）一律不认。
   白名单外的源：**一个 CORS 头都不回** + 403。没有 Origin 头（同源面板调用、node/curl 调用方）照常放行：
   CORS 管不到它们，边界靠门②与批次目录围栏。运维口 `DVP_GROK_SAVE_ORIGINS`。
2. **批次 nonce**：`POST/PUT /dvp/grok/plan` 建批次（或续做）时发一把 32 字节随机 nonce，
   回在响应里、写进该批 `plan.json`（宿主重启后仍能校验）、随 `driver.md` 与面板派发请求交给会话；
   存图时 `?nonce=` 或请求头 `X-DVP-Nonce` 带上，缺/错一律 403。重发同一批换新 nonce，旧的立刻作废。
   `GET /dvp/grok/plan` 的 `plan` 里**不含** nonce（那是跨源读得到的只读端点）。比较走
   `timingSafeEqual`（定长、不看长度）。nonce 只在这条批次通道里有效，不是账号凭据；
   除批次 `plan.json`、建批次响应、驱动清单/派发请求外不再另发一份，也不写任何日志。
   逃生口 `DVP_GROK_SAVE_ALLOW_ANON=1`（默认关，只认环境变量）。
3. **图片魔术字节**：按魔数收 PNG/JPEG/GIF/WebP（不看扩展名与 content-type，页面直传常常是
   `application/octet-stream`），拒绝时 415 并回带请求体前 16 字节；账本新增 `signature` 字段记下
   真实封装。

**数字**（`tools/verify-grok-bytes.mjs` 离线断言，本机实测）：

| 口径 | 结果 |
| --- | --- |
| 新增断言 | 71 → 121 项（其中「三道门」段 50 项） |
| 全仓套件 | `npm test` 4/4 通过、570 项检查（188 + 18 + 121 + 243） |
| 反向验证（断言指向改动前 `034a7cf`） | **37 / 121 项失败**（白名单回显、非白名单源 403、nonce 四种拒绝、非图片 415、正常路径回显全部报错） |

反向验证用 `git worktree add <临时目录> 034a7cf` + 只把新的 `tools/verify-grok-bytes.mjs` 拷过去，
跑完 `git worktree remove --force`（不用 `git stash`）。

## 未发布 — 图片字节彻底移出模型上下文（raw bytes 直传 /dvp/grok/save）

**问题**：取图的兜底是"宿主不可用就把图 **base64 每 20k 字符分块**交回会话，再在会话里拼回去写盘"。
1 MiB 的图 ⇒ 会话文本里 **1,398,444 字符 base64**：既爆上下文，又会被工具结果上限在分块搬运时截坏，
截到的 base64 落盘就是坏图 —— 而账上照样记成功。

**改法**（不重构链路，只换字节的运输方式）：

1. `tools/grok-shot.mjs`：`grokRecipe()` 里那条分块兜底**删除**，改为「页面内 `fetch` → `arrayBuffer`
   → **原样 POST** `<宿主基址>/dvp/grok/save?index=&slug=&batch=&ext=`（raw bytes）」，返回值只允许是
   宿主回的那一小段元信息；兜底改成**盘到盘**通道（`scan-cache` 从浏览器缓存捞进本批目录，
   或用户点一次 Download 后 `watch-downloads` 接住）。新增 `--batch <batchId>`：`plan.json` 与取图命令
   一律指向 `<out>/<batchId>/`，不再退回平铺根目录。
2. `index.js` 的 `/dvp/grok/save`：`Content-Type: application/octet-stream` 时把**请求体当图片字节**
   （`readRaw()` 收 Buffer，上限 48 MiB），标识走 URL 参数；响应恒为
   `{ok,status:"saved",batchId,file,bytes,sha256,width,height,dir,ledger}` —— 字节绝不回吐。
   新增 `imageSize()`（PNG/JPEG/GIF/WebP 只读头几十字节，与脚本侧同一口径）与 CORS 头
   （`Access-Control-Allow-Origin: *`：不放，页面内直传就读不回元信息，agent 只能把字节搬回会话 —— 正是要防的绕行；
   写入仍被批次目录围栏挡在 `grok-output/<batchId>/` 里）。JSON `{base64|url}` 体保留给旧调用方与别的图源。
   顺手导出 `driverDoc()`（纯函数）供离线断言。
3. `client.js`（面板派发提示）、`client.js` 的 Grok 派发请求、`tools/backfill-plan.mjs` 的驱动清单：
   措辞同步改为 raw bytes 直传 + 盘到盘兜底，并写明"图片内容/base64 一律不进会话文本"。
4. `tools/run-all.mjs` 的 `SUITES` 登记新套件；`servable/client.js` 用 `tools/sync-servable.mjs` 同步。

**数字**（同一张自造 1 MiB 假图，`tools/verify-grok-bytes.mjs` 量化）：

| 口径 | 会话文本字符数 | 其中 base64 字符数 |
| --- | --- | --- |
| 旧（图 base64 进会话文本） | 1,398,527 | 1,398,444（= `ceil(bytes/3)*4`） |
| 新（raw bytes 直传 + 元信息） | **211** | **0** |

压掉 **99.9849%**。落盘对账从"回读图片内容"改为 `file/bytes/sha256/width/height/status`。

**验证**：新增 `tools/verify-grok-bytes.mjs`（已登记进 `SUITES`）离线 **71 项检查全通过** ——
假图自己捏（固定种子伪随机字节，不联网、不用真图、不碰真实媒体盘与浏览器），宿主用真 `node:http`
监听 127.0.0.1 随机端口承托。反向验证：把同一份断言指向改动前的 `c3a8b4e`（临时 `git worktree`）
**36 / 66 项失败**（raw 路由 500、响应无 `bytes/sha256/width/height`、配方仍写"每块 20k 字符"、
`driverDoc` 未导出等），验证后已 `git worktree remove`。
`npm test` **4/4 套件通过**（probe-host 187 + verify-watch-idle 18 + verify-grok-bytes 71 + selfcheck 237 = 513 项），退出码 0。

## 未发布 — CI 装测试依赖 + 恢复 selfcheck（react/react-dom 进 devDependencies，DSH_APP_DIR 指向仓库根）

**问题（"本机全绿、干净机器/CI 全红"）**：`tools/selfcheck.mjs` 第 3e 节要"真 React 渲染成 HTML"，
它用 `createRequire(DSH_APP_DIR/package.json)` 解析 `react` / `react-dom`；
`DSH_APP_DIR` 没设时还会从 `process.execPath` 反推（`<app>/node_modules/node/bin/node.exe ⇒ 上三级`），
也就是**本机 DSH 安装目录**。干净环境里这两条路都拿不到那两包 ⇒
离线报 `Cannot find module 'react'` ⇒ 该套件只能被排除在 CI 之外。

**改法**（不重构，三步）：
1. `package.json` 加 `devDependencies: { "react": "18.3.1", "react-dom": "18.3.1" }`
   （与宿主 DSH Desktop 内置的 React 同版本，渲染出的面板与用户实际看到的是同一大版本），
   并加 `engines.node >= 20`。
2. `tools/run-all.mjs` 的 `ENV` 加 `DSH_APP_DIR: REPO` —— 把那个缝**指向仓库根**，
   于是 `createRequire('<repo>/package.json')` 解析到仓库自己的 `node_modules/`（CI 由 `npm ci` 装出）。
3. `tools/run-all.mjs` 把 `tools/selfcheck.mjs` 从 `EXCLUDED` 挪进 `SUITES`。
   新增 `.npmrc`（`legacy-peer-deps=true` + 钉 `registry.npmjs.org`），提交 `package-lock.json`
   （只有 5 个包：react / react-dom / scheduler / loose-envify / js-tokens）。
   `.github/workflows/ci.yml` 加 `npm ci` 与 `cache: npm`，并写明**测试执行期间不出网**。

**数字**：
- `selfcheck` 在干净环境（`DSH_HOME`/`APPDATA`/`LOCALAPPDATA`/`USERPROFILE`/`DSH_APP_DIR` 全指空目录）
  **全部通过：237 项检查**（`DSH_APP_DIR` 未指向仓库根时必报 `Cannot find module 'react'`）。
- `npm test` 三档 **Node 20 / 22 / 24 均退出码 0**，
  套件 **3/3 通过**：`probe-host` 187 项 + `verify-watch-idle` 18 项 + `selfcheck` 237 项。
- 仍然排除 `tools/probe-live.mjs`（要真实媒体盘里的素材文件；它是探针脚本，不是断言式套件）。

## 未发布 — 修 P2 批次：请求载荷、运行期目录、局部保存、派发历史、收图退出

一轮只读审计报了 5 条缺陷，**逐条先核实**（读代码 + 最小复现）再改。5 条全部成立，
都不是重构；每条都有离线断言，并且都用"把新断言指向改动前的实现"取了反向证据。

### ① 正文落盘后仍被全文塞进派发请求（请求载荷瘦身）

**核实**：`client.js` 的 `buildGrokRequest()` 把 `source` 当字符串直接拼进请求正文块，
哨兵材料（32,399 字符）实测生成的派发请求 **33,536 字符**；面板上却写着"正文不进对话框"。

**改法**：`source` 改成**材料引用** `{ id, path, chars }`，请求里只给材料 ID / 文件路径 / 字数，
并明确要求 agent **按需读取**（先读文件头与目录，按图片数挑最强的 N 个情节，只把那几段读全，
不要整篇搬进上下文、不要在回复里复述正文）。面板侧：勾了「按来源文本生图」但还没落盘时，
派发前先自动 `POST /dvp/source` 落盘拿路径；落盘失败就取消这次派发（不生成读不到材料的请求）。

| 口径 | 派发请求字符数 | 说明 |
| --- | --- | --- |
| 旧（正文拼进请求） | 33,536 | 与用户实测的 30,642 字符同一形态 |
| 新（只带材料引用） | **1,286** | 压掉 **96.2%**；含材料 ID + 路径 + 字数 + 读取要求 |

顺手兜一道：万一有调用方把整块正文当"路径"传进来（老签名的形态），只认第一行当路径，
正文剩余部分仍不进请求 —— 挡住"漏改一处就把正文拼回去"。

### ② 保存新目录后任务仍写旧目录

**核实**：`apply()` 里 `mediaRoot` / `runsRoot` 是启动时解析一次的常量，`/dvp/state` 只把新根
推进允许围栏，写盘的那些路由仍打旧目录（`/dvp/source`、`/dvp/process`、`/dvp/run`、
`/dvp/grok/plan` 全都写老地方）。

**改法**：改为**可变运行期配置** `runtime`，各路由读 `runtime.mediaRoot` / `runtime.runsRoot`；
`/dvp/state` 保存成功后同步刷新，响应回带 `effective: { mediaRoot, runsRoot }`（当前实际生效路径）。

### ③ 局部保存设置会丢掉未提交字段

**核实**：写盘写成 `typeof patch.mediaRoot === 'string' ? … : undefined`，而 `writeState()` 是浅合并
（`{...current, ...patch}`）—— `undefined` 会盖掉现值。面板切「路径」下拉时只提交 `{ pipelineMode }`，
于是 `state.json` 里 `mediaRoot` / `runsRoot` 一起消失（实测确认）。

**改法**：用 `'key' in patch` 区分"没提交该字段"与"明确清空"。
没提交 = 保留现值；`null` / 空串 = 明确清空（从 `state.json` 删键，运行期回落到 config 给的根）。

### ④ 新派发覆盖旧派发历史

**核实**：面板每次只提交最新一条 `run`，宿主 `const runs = body.runs` 直接覆盖 —— 历史里只剩最后一次。

**改法**：`mergeRunHistory()` 按任务 ID 追加去重，保留最近 `RUN_HISTORY_LIMIT = 30` 条；
去重优先 `run.id`，旧记录退到 `at|kind|processDir` 指纹；面板提交时补上 `run.id`，响应回带 `runCount`。

### ⑤ 持续下载时接收脚本仍提前退出

**核实**：`idleRounds` 自增但**收到图也不重置**，`received > 0 && idleRounds >= 4` 让第 5 轮必定退出。
实测旧逻辑：每轮都有新图时在第 5 轮（30 秒）收工，只收到 5 张。

**改法**：改按"**最后一次成功收图**的时间戳"算空闲（默认 20 秒），收到图就归零；
且只在收过图之后才允许按空闲退出。脚本主体抽成可 import 的 `watchDownloads()`（可注入 `clock` / `sleep`），
CLI 行为不变（`--minutes` / `--src` / `--out` 照旧）。

### 反向证据（新断言指向改动前的实现，确认必挂）

在临时 `git worktree`（`8755bec`）里跑同一批断言：

| 套件 | 改动前 | 改动后 |
| --- | --- | --- |
| `tools/selfcheck.mjs` | 7 / 237 失败 | **0 / 237** |
| `tools/probe-host.mjs` | 16 / 187 失败 | **0 / 187** |
| 收图退出断言（旧主线适配版） | 4 / 7 失败（每轮有图仍在第 5 轮退出、只收到 5 张） | **0 / 18** |

失败项与上面 5 条一一对应（逐段状态被 undefined 覆盖、新目录不生效、历史只剩最后一条、
每轮有图仍提前退出……）。工作树跑完已删除。

### 改动文件

- `client.js` + `servable/client.js`：请求只带材料引用；派发前自动落盘来源文本；
  运行历史补 `run.id`；面板文案（"请求里只带路径与字数"）
- `index.js`：`runtime` 可变根 + `/dvp/state` 同步刷新并回传 `effective`；局部保存语义；
  `mergeRunHistory()`（上限 30）；`writeState()` 处理明确清空；导出 `resolveRuntime` / `mergeRunHistory`
- `tools/watch-downloads.mjs`：空闲判据改用"最后一次收图时间"；导出 `watchDownloads`
- `tools/selfcheck.mjs`（新增 3d2 哨兵载荷段）、`tools/probe-host.mjs`（新增 13/14/15 段）、
  `tools/verify-watch-idle.mjs`（新增，18 项）
- `README.md`：来源文本、产物目录即时生效、派发历史上限、收图退出判据同步
- `.gitignore`：忽略断言脚本的临时目录

## 未发布 — 修 P1：Grok 批次共用一个目录，新批次覆盖旧批次

**问题**：`grok-output` 是**固定目录**，每个批次的 `plan.json`、`driver.md`、`source-*.md`
和成图都写在同一个平面里，于是：

- 新批次的 `plan.json` 直接盖掉上一批；
- 同名 slug 的 `source-*.md` 与 `<序号>-<slug>.<ext>` 成图互相盖；
- 而 `ledger.json` 是**追加**的 —— 盘上只剩最后一批，账上却留着两条批次记录，
  **账本与实际产物对不上**（`ledger.items[].file` 指向已被覆盖的文件）。

同文件的 `/dvp/process`、`/dvp/run` 早就在用「一跑一个唯一目录」的写法，这条线没跟上。

**改法**（最小改动，向后兼容）：每批一个目录 `<mediaRoot>/grok-output/<batchId>/`，
`batchId = 年-月-日_时分-<slug>`（复用 `localStampMinute()` / `slugify()`，
同一分钟重复派发自动加 `-2`）。该批的 `plan.json` / `driver.md` / `source-*.md` /
成图 / `ledger.json` 全在这一个目录里。

| 场景 | 行为 |
| --- | --- |
| POST/PUT 不传批次身份 | 新建批次目录（图不再落 `grok-output` 根下） |
| POST/PUT 传 `batchId`（或 `batch`/`dir`） | 写回**同一目录**，不新建 —— 重试/续做 |
| GET 不传参 | 返回**最新一批**（索引 → 目录 mtime），`dir`/`plan` 字段名不变 |
| GET `?batch=<id>` | 读指定批次；`?batch=legacy` 读旧版平铺布局 |
| 盘上只有旧布局 `grok-output/plan.json` | GET 不传参仍读到它（算历史批次），**且不再往里写新批次** |
| `POST /dvp/grok/save` 不传 `batchId` | 进最新一批；批次不存在时 404（不制造孤儿目录） |
| `batchId` 越界（`../evil`、`a/b`、`C:\…`） | 400（口径严，不许静默改成新建） |

响应新增 `batchId` / `legacy` / `planFile` / `driverFile` / `ledgerFile` / `root` / `batches` 字段，
`dir`、`plan`、`count`、`options`、`sourceFile` 保持原样；另写一个**可选**的轻量
`grok-output/index.json`（只是加速件，缺失/损坏/被删都不影响读批次）。

### 改动文件

- `index.js`：新增 `LEGACY_BATCH_ID` / `normalizeGrokBatchId()` / `resolveUniqueGrokBatch()` /
  `scanGrokBatches()` / `readGrokIndex()` / `touchGrokIndex()` 与 `apply()` 内的 `wantBatch()`；
  `/dvp/grok/plan` 与 `/dvp/grok/save` 改为按批次目录读写；`driverDoc()` 写明批次 ID 与「存图带 batchId」
- `client.js` + `servable/client.js`：`buildGrokRequest()` 增加 `batchId` 参数，派发请求里写明批次 ID
- `README.md`：来源文本路径、成图路径、批次目录与对账说明同步
- `tools/probe-host.mjs`：新增 8c 段（批次隔离 / 重试 / 最新与指定 / 旧布局兼容 / 越界拒绝 / 索引容错）
- `tools/selfcheck.mjs`：新增 3 条「派发请求带批次 ID」断言

## 0.1.1 — 去掉一切机器绑定（媒体/产物目录改为按机器解析）

**问题**：0.1.0 把媒体根与产物根写死成开发机上的绝对路径
（`D:/DeepSeek/01-video技能/media`、`.../runs`，以及 `tools/` 里开发机的安装目录），
于是任何别的机器装上都指向一个不存在的目录。

**改法**：本包内**不再出现任何绝对路径**；路径按「面板 → profile → 默认」三层解析。

| 层级 | 位置 | 优先级 |
| --- | --- | --- |
| 面板 | 面板里填的路径 → `$DSH_HOME/dsh-video-prompt/state.json` | 最高 |
| profile | `$DSH_HOME/profiles/web/cordis.patch.yml` 里 `- id: video-prompt` 的 `config` | 中（每机一份，不进本包） |
| 默认 | `$DSH_HOME/dsh-video-prompt/media` 与 `.../runs` | 兜底，随机器走 |

三种写法都支持 `~`、`$DSH_HOME`、`%DSH_HOME%` 展开。

### 改动文件

- `index.js`
  - `DEFAULTS` 的 `mediaRoot`/`runsRoot` 改为空串（不再预设任何路径）
  - 新增 `expandRoot()`（展开 `~` / `$DSH_HOME` / `%DSH_HOME%`）与 `resolveRoot()`
  - `normalizeConfig()`：留空 → `$DSH_HOME/dsh-video-prompt/media|runs`；
    非空 → 展开后取绝对路径（原来留空会落到 `process.cwd()`，即宿主启动目录，是个坑）
  - `PUT/POST /dvp/state` 写回时同样走 `resolveRoot()`
- `cordis.patch.yml`：`insert` 只保留 `registerSkills`，删除写死的 `mediaRoot`/`runsRoot`；
  注释里补上「三层解析」与本机覆盖的写法
- `README.md`：安装示例改成 `<本包目录>`；新增「媒体目录（每台机器不一样）」表格
- `tools/probe-live.mjs`：`MEDIA`/`RUNS` 改为 `DVP_MEDIA_ROOT` / `DVP_RUNS_ROOT` 环境变量
  → 命令行参数 → 相对目录
- `tools/selfcheck.mjs`：`APP` 改为 `DSH_APP_DIR` 环境变量，否则从 `process.execPath`
  反推宿主安装目录；真实产物回归的样本路径改为 `DVP_MEDIA_ROOT`/`DVP_RUNS_ROOT`
  （没配就照旧跳过，不报错）
- `tools/watch-downloads.mjs`：`--out` 缺省值改为 `$DVP_MEDIA_ROOT/grok-output`
- `servable/index.html`：独立预览页里的 demo 假数据路径改为中性路径 `/demo/video-workspace`
  （只是 mock 数据，不参与运行时）
- `package.json`：`0.1.0` → `0.1.1`

### 兼容性

- 行为兼容：面板里已记住的路径（`state.json`）优先级不变，老用户不受影响。
- 唯一的行为变化：**没有在面板里配过、也没有在 profile 里覆盖过**的机器，
  不再落到 `process.cwd()`，而是落到 `$DSH_HOME/dsh-video-prompt/media|runs`。
- 升级方式：`link:` 挂载的直接重启即可；从 registry 装的按常规升级。
