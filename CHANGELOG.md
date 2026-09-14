# 变更记录

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
