# 变更记录

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
