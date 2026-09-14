// ============================================================================
// dsh-video-prompt · 宿主端（Host half）
//
// 职责三件，全部挂在 profile 组合里的一行 dsh.bundle 上：
//
//   ① HTTP 路由 /dvp/*（webServer 服务）
//        GET  /dvp/scan?path=<dir>&depth=1   扫描媒体目录，按图片/视频分流
//        GET  /dvp/file?path=<file>          读文本文件（提示词预览用，带大小上限）
//        GET  /dvp/image?path=<file>         读图片字节（面板缩略图用）
//        GET  /dvp/probe?path=<file>         视频时长/分辨率（ffprobe，尽力而为）
//        GET  /dvp/state                     读面板持久化配置 + 默认目录
//        PUT  /dvp/state                     写面板持久化配置
//        GET  /dvp/manifest?dir=<dir>        读该目录的逐项状态（.dsh-video-prompt/manifest.json）
//        PUT  /dvp/manifest                  写该目录的逐项状态
//        POST /dvp/run                       为一个媒体文件建运行目录并落盘提示词
//        POST /dvp/process                   建一次派发的「过程目录」（runsRoot/process/年-月-日_时分-slug），
//                                            拆帧、爆款元素分析等中间产物都写这里
//        POST /dvp/source                    把「来源文本」（小说正文/章纲）落盘成文件
//        POST /dvp/grok/plan                 建 Grok 出图批次（含生图要求与来源文本）
//        POST /dvp/grok/save                 保存抓到的成图字节（首选 raw bytes 直传，
//                                            兼容 JSON base64/URL；响应只回元信息，字节不进会话）
//                                            CORS 白名单回显 + 批次 nonce + 图片魔术字节，三道门见下方同名注释
//        GET  /dvp/grok/run                  统一任务记录：按 batchId 取单条明细（只读，不写盘）
//                                            ?driver=1 附「仅重试失败项」清单；?verify=stat 只做存在性/字节校验
//        GET  /dvp/grok/runs                 统一任务记录：最近若干批的列表（只读，stat 级校验）
//        POST /dvp/grok/run                  统一任务记录：显式登记 begin / cancel / clear
//                                            （只写该批 run.json 的 control 段，不动 plan/ledger/产物）
//        POST /dvp/skills/reload             重扫技能目录：开机后新增的技能免重启注册
//                                            （同名 first-wins，改已有技能正文仍需重启）
//
//   ② 技能注册（skills 服务，全局层）
//        把本包 skills/ 下 6 个技能注册进目录：
//        video-prompt-pipeline / watch / oneshot-prompt-generator /
//        prompt-videos / video-generation / viral-media-copywriter
//        注册内容含 frontmatter 摘要与正文，resourceBase 指向包内真实目录，
//        因此 agent 读 references/ scripts/ 时路径是通的。
//
//   ③ 配置默认值：媒体根目录 / 运行产物根目录（cordis.patch.yml 可覆盖）
//
// 安全边界：所有路径必须落在 config.mediaRoot / runsRoot 之内（规范化后前缀比较），
// 越界直接 403。面板本地挑选的目录（File System Access API）只在浏览器侧读，不进宿主。
// ============================================================================

import { createReadStream, existsSync, promises as fsp, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

export const name = 'dsh-video-prompt'
export const inject = ['webServer']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.')
const SKILLS_ROOT = path.join(PACKAGE_ROOT, 'skills')
const SERVABLE_ROOT = path.join(PACKAGE_ROOT, 'servable')
const SERVABLE_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

// 收录的扩展名：面板（client.js 的 IMAGE_EXT / VIDEO_EXT / TEXT_EXT）必须与这里逐项对齐，
// 否则会出现"盘里有图、面板里没有"。图片收全（含 heic/tif/svg），视频补上常见封装。
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif', '.tif', '.tiff', '.svg'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.flv', '.wmv', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts', '.ogv', '.3gp'])
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.json', '.yaml', '.yml', '.srt', '.vtt', '.csv', '.log', '.ini', '.conf'])
// 扫描时跳过的目录名。`grok-output` 是本插件自己的**产物**目录：
// 一旦把它当素材扫进来，面板会默认勾选，点「用 Grok 生图」就把 Grok 的产出再喂回 Grok
// （实盘验证时扫出 8 张图，其中 4 张是上一轮成图）。产物不进输入池。
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-video-prompt', '__pycache__', '.venv', 'grok-output'])
const MAX_TEXT_BYTES = 512 * 1024
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_BYTES = 24 * 1024 * 1024
const MAX_SCAN_ENTRIES = 4000

// 默认值刻意**不绑定任何设备**：留空即落到本机 DSH 数据目录下的媒体/产物目录
// （$DSH_HOME/dsh-video-prompt/media 与 .../runs）。要指向自己的素材盘有两个途径：
//   ① 面板里改 —— 写进 $DSH_HOME/dsh-video-prompt/state.json，优先于 config；
//   ② profile 的 cordis.patch.yml 里按 id 覆盖 config —— 每台机器一份，不进本包。
// 因此本包任何地方都不该出现某个人的盘符路径。
const DEFAULTS = Object.freeze({
  mediaRoot: '',
  runsRoot: '',
  registerSkills: true,
})

// ── 配置与持久化状态 ────────────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

function stateDir() {
  return path.join(dshHome(), 'dsh-video-prompt')
}

function stateFile() {
  return path.join(stateDir(), 'state.json')
}

/** 展开用户输入里的 ~ 与 $DSH_HOME / %DSH_HOME%；空串（或非字符串）返回空串。 */
function expandRoot(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text === '') return ''
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (text === '~') text = home
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(home, text.slice(2))
  return text.replace(/\$\{?DSH_HOME\}?/gi, dshHome()).replace(/%DSH_HOME%/gi, dshHome())
}

/** 配置里留空的根 → 本机数据目录；非空 → 展开 ~/$DSH_HOME 后取绝对路径。 */
function resolveRoot(value, fallback) {
  const expanded = expandRoot(value)
  return path.resolve(expanded !== '' ? expanded : fallback)
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const out = {
    mediaRoot: resolveRoot(config.mediaRoot, path.join(stateDir(), 'media')),
    runsRoot: resolveRoot(config.runsRoot, path.join(stateDir(), 'runs')),
    registerSkills: config.registerSkills !== false,
  }
  return out
}

async function readState() {
  try {
    const text = await fsp.readFile(stateFile(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeState(patch) {
  const current = await readState()
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  // 明确清空（null）= 把键删掉，state.json 里不留 `"mediaRoot": null`
  // —— 留着 null 会在下次启动时被 `persisted.mediaRoot || config…` 当成"没配"，
  // 看着一样，但 JSON 里的脏值会让人以为配过。
  for (const key of Object.keys(next)) if (next[key] === null) delete next[key]
  await fsp.mkdir(stateDir(), { recursive: true })
  await fsp.writeFile(stateFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

// ── 生图要求（可选项）────────────────────────────────────────────────────────
// 与客户端 GROK_OPTIONS 一一对应，只留这三个真正能落到 Grok 页面上的参数。
// 宿主不做业务判断，只做清洗与落档：值不在白名单里就丢掉，避免 state.json 被写脏。
const GROK_OPTION_VALUES = {
  // 从低到高排；默认档在客户端是 1080p（省额度）。加新档位时两处都要改：
  // 这里（白名单）和 client.js 的 GROK_OPTIONS / CLARITY_ORDER。
  clarity: ['720p', '1080p', '2K', '4K', '8K', '8K电影级+胶片颗粒'],
  aspect: ['2:3 竖版', '3:4 竖版', '9:16 全竖', '1:1 方形', '16:9 横版', '3:2 横版'],
  count: ['1', '2', '4'],
}

// 流水线「路径」：prompt = 素材→提示词→生图（既有主线）；
// viral = 视频/图片→爆款元素（蒸馏 skill 的分析路径）。客户端 PIPELINE_MODES 必须与这里一致。
const PIPELINE_MODE_VALUES = ['prompt', 'viral']

function sanitizeGrokOptions(raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const out = {}
  for (const key of Object.keys(GROK_OPTION_VALUES)) {
    const value = raw[key]
    if (typeof value === 'string' && GROK_OPTION_VALUES[key].includes(value)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizePipelineMode(raw) {
  return typeof raw === 'string' && PIPELINE_MODE_VALUES.includes(raw) ? raw : undefined
}

/** 本地时间戳，精确到分钟：`2026-09-11_1705`。过程目录/运行目录的命名主体。 */
function localStampMinute(date) {
  const t = date || new Date()
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + '_' + pad(t.getHours()) + pad(t.getMinutes())
}

/** 同名目录已存在时追加 -2/-3…（分钟粒度命名，同一分钟里多次派发会撞名）。 */
function resolveUniqueDir(parent, name) {
  let candidate = path.join(parent, name)
  let n = 2
  while (existsSync(candidate) && n < 100) {
    candidate = path.join(parent, name + '-' + n)
    n += 1
  }
  return candidate
}

/** 文件名安全化：保留中英文与点横线，其余压成 '-'。 */
function slugify(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned === '' ? fallback : cleaned
}

// ── Grok 批次的目录身份 ─────────────────────────────────────────────────────
// 批次的"目录名"就是 batchId；它必须是单个路径段（不含分隔符、不是 . / ..），
// 这样 `path.join(grokRoot, batchId)` 天然越不出 grok-output。
// LEGACY_BATCH_ID 是旧版平铺布局的别名：读得到，但不许再往里写新批次。

const LEGACY_BATCH_ID = 'legacy'

/** 把调用方给的批次身份收成合法目录名；不合法返回 ''（调用方按 400 拒掉，不静默改名）。 */
function normalizeGrokBatchId(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > 96) return ''
  if (trimmed === '.' || trimmed === '..') return ''
  if (/[\\/]/.test(trimmed) || trimmed.includes(':')) return ''
  if ((trimmed.split('').map((ch) => ch.charCodeAt(0))).some((code) => code < 32)) return ''
  return trimmed
}

/** 在 grok-output 下占一个没人用的批次目录（撞名加 -2/-3…）。返回 { batchId, dir }。 */
function resolveUniqueGrokBatch(root, slug) {
  const base = localStampMinute() + '-' + slug
  let batchId = base
  let n = 2
  while (existsSync(path.join(root, batchId)) && n < 100) {
    batchId = base + '-' + n
    n += 1
  }
  return { batchId, dir: path.join(root, batchId) }
}

// ── Grok 请求体里的"批次身份" ────────────────────────────────────────────────
// batchId / batch / dir 三个键都收（dir 是旧调用方的口径，取末段目录名）。
// 四种结论分得很开，宁可口径严一点也不许猜：
//   ''      + ok  → 调用方没指定批次 ⇒ 新建
//   非空     + ok  → 续做/重试这一批 ⇒ 写回同一目录
//   非空     + !ok → 给了批次身份但非法 ⇒ 400（不许静默改成新建，否则调用方会以为重试成功了）
//   ROOT    + ok  → 旧版面板把平铺的 grok-output 目录当 dir 传上来 ⇒ 等同没指定（新建子目录）

const BATCH_ROOT = Symbol('grok-output-root')

/** index.json 只是加速用的轻量索引：缺失/损坏/不合法一律当没有，绝不因此报错。 */
async function readGrokIndex(root) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(root, 'index.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** 扫 grok-output 下的批次目录（含旧版平铺布局，它算一个历史批次）。目录名即批次 ID。 */
function scanGrokBatches(root) {
  const out = []
  try {
    if (existsSync(path.join(root, 'plan.json'))) out.push({ batchId: LEGACY_BATCH_ID, legacy: true, mtime: mtimeOf(path.join(root, 'plan.json')) })
  } catch { /* 读不到就当没有 */ }
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const planFile = path.join(root, entry.name, 'plan.json')
    if (!existsSync(planFile)) continue
    out.push({ batchId: entry.name, legacy: false, mtime: mtimeOf(planFile) })
  }
  return out
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 写/更新 index.json。这是缓存，失败不影响批次本身，所以整段吞掉。 */
async function touchGrokIndex(root, batchId) {
  try {
    const previous = await readGrokIndex(root)
    const batches = Array.isArray(previous && previous.batches) ? previous.batches : []
    const next = [{ batchId, at: new Date().toISOString() }, ...batches.filter((item) => !item || item.batchId !== batchId)]
    await fsp.writeFile(path.join(root, 'index.json'), JSON.stringify({
      updatedAt: new Date().toISOString(),
      latest: batchId,
      batches: next.slice(0, 200),
    }, null, 2), 'utf8')
  } catch { /* 索引只是加速件 */ }
}

// ── /dvp/grok/save 的三道门（CORS 白名单 · nonce · 魔术字节）──────────────────
//
// 背景（2026-09 那一轮放开 CORS 时留下的口子）：图是在 **grok.com 那个跨源页面**里读出来、
// 再 POST 回 127.0.0.1 的，所以这一条路由必须回 CORS 头，否则页面读不到响应里的元信息。
// 但当时的 `Access-Control-Allow-Origin: *` + 无鉴权 = **任何被访问过的网页**都能 POST 到这个
// 本机端点（写入虽被批次目录围栏限制，可它仍能把图片/任意字节写进用户的 grok-output 批次目录，
// 并读回路径/哈希/宽高）。三道门分别堵三件事：
//   ① 白名单回显：只有真的会用到的源（grok.com / x.ai）能读到响应；别人的请求不回 ACAO。
//   ② batch nonce：跨源页面拿不到 nonce 就 403 —— 挡住"任意网页"这条路（见 nonce 生成注释）。
//   ③ 魔术字节：确实像 PNG/JPEG/GIF/WebP 才收，别把任意载荷写成"图"。

/**
 * 允许读取 /dvp/grok/save 响应的源。集中定义在这里，断言直接读它（tools/verify-grok-bytes.mjs）。
 *
 * 为什么是这两个域：取图必须发生在**已登录 grok.com 的页面上下文**里（签名 URL 绑定会话，
 * 见 README「Grok 出图的实测硬约束」），所以实际会 POST 回来的只有 Grok 自己与它的 x.ai 同族域。
 * 通配子域（*.grok.com / *.x.ai）而不是逐个白名单，是因为 assets.grok.com / grok.com 之间
 * 跳转时页面 origin 会变，逐个列会漏 —— 而这两个域都是同一家、同一份登录态。
 *
 * 刻意**不**收 127.0.0.1 / localhost：面板与宿主是同源（同源请求不需要 CORS），
 * 收了反而等于把口子还给"本机上任何别的 HTTP 服务"。
 * 运维需要临时加源：DVP_GROK_SAVE_ORIGINS="https://a.example,https://b.example"（只按 origin 精确匹配）。
 */
export const GROK_SAVE_ALLOWED_ORIGINS = Object.freeze(['https://grok.com', 'https://x.ai'])

const GROK_SAVE_ALLOWED_HEADERS = 'Content-Type, X-DVP-Nonce'

/** 请求里能带 nonce 的三个位置：JSON 体的 body.nonce、查询参数 ?nonce=、请求头 X-DVP-Nonce。 */
export const GROK_SAVE_NONCE_HEADER = 'x-dvp-nonce'

/** 环境变量里那种"逗号分隔的额外源"（运维口），坏值一律忽略而不是抛。 */
function extraAllowedOrigins(env) {
  const raw = typeof (env && env.DVP_GROK_SAVE_ORIGINS) === 'string' ? env.DVP_GROK_SAVE_ORIGINS : ''
  const out = []
  for (const piece of raw.split(',')) {
    const value = piece.trim().toLowerCase()
    if (value === '') continue
    try {
      const parsed = new URL(value)
      if (parsed.origin !== 'null' && parsed.origin !== undefined) out.push(parsed.origin)
    } catch { /* 不是合法 origin 就当没写 */ }
  }
  return out
}

/** 把 origin 解成 { protocol, hostname }（小写）；解不出（不是合法 URL）返回 null。 */
function parseOrigin(value) {
  try {
    const url = new URL(value)
    return { protocol: String(url.protocol || '').toLowerCase(), hostname: String(url.hostname || '').toLowerCase() }
  } catch {
    return null
  }
}

/**
 * Origin 是不是我们认得的那种"grok 网页"。大小写不敏感（origin 规范上是小写的）。
 *
 * 判据是**解析后的 hostname**，不是字符串前后缀 —— 前后缀那种写法会放过 `grok.com.evil.example`
 * 这类伪装域（它以 `.grok.com` 之外的形式巧妙地躲过 endsWith 检查）与 `notgrok.com`。
 * 端口不参与判断：`https://grok.com:443` 与 `https://grok.com` 是同一个源。
 *
 * **没有 Origin 头 = 放行**（返回 true）。浏览器发的每一个跨源请求都带 Origin，这是规范行为；
 * 不带 Origin 的只有两类：同源请求（面板 → 宿主，本来就不受 CORS 约束）、以及 node/curl 这类
 * 非浏览器调用方。这两类的边界不靠 CORS —— 靠 nonce 门与批次目录围栏（见「三道门」注释）。
 * 反过来，如果这里把"没有 Origin"当白名单外拒掉，面板自己的同源调用与宿主侧脚本会一起失效。
 */
export function isAllowedGrokSaveOrigin(origin, env) {
  const raw = origin === undefined || origin === null ? '' : String(origin).trim()
  if (raw === '') return true
  const parsed = parseOrigin(raw)
  const extra = extraAllowedOrigins(env === undefined ? process.env : env)
  if (parsed === null) {
    // 解不出 URL（`null` / 畸形值）：只认环境变量里显式写下的精确串。
    return extra.includes(raw.toLowerCase())
  }
  // 只认 https（白名单里两个域都是 https）：`http://grok.com` 这种协议降级不认。
  if (parsed.protocol !== 'https:') return false
  if (GROK_SAVE_ALLOWED_ORIGINS.some((allowed) => {
    const base = parseOrigin(allowed)
    if (base === null) return false
    return parsed.hostname === base.hostname || parsed.hostname.endsWith('.' + base.hostname)
  })) return true
  return extra.includes(raw.toLowerCase())
}

/**
 * 这一条响应的 CORS 头。
 *
 * 关键：**只回显请求自己的 Origin**，不再回 `*` —— 回 `*` 等于告诉浏览器"任何页面都能读这条响应"。
 * 白名单外的源回空对象（没有 ACAO，浏览器就不放行读取；写操作也被下面的 nonce 门挡在 403）。
 * `Vary: Origin` 必须带：响应体/头随 Origin 变，别让任何中间缓存把"给 A 源的响应"发给 B 源。
 */
export function grokSaveCorsHeaders(origin, env) {
  if (!isAllowedGrokSaveOrigin(origin, env)) return {}
  const echoed = origin === undefined || origin === null ? '' : String(origin).trim()
  // 没有 Origin（同源调用 / 非浏览器调用方）⇒ 不带 ACAO：本来就不需要，带了反而多一句话。
  if (echoed === '') return { Vary: 'Origin' }
  return {
    'Access-Control-Allow-Origin': echoed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

/** 白名单外的源：不回任何 CORS 头，但仍是可读的 JSON 403（跨源 JS 读不到，本机/无 Origin 调用方读得到）。 */
function grokSaveDenyJson(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

// 一次性 nonce 的台账。作用域是**进程内**，键是 batchId：
//   * 生成：POST/PUT /dvp/grok/plan 建批次（或续做）时新生成一个，回在响应里、写进 plan.json，
//     宿主把它一起交给会话（driver.md / 面板派发请求），会话里的 agent 在执行取图那一步把它带上。
//   * 校验：/dvp/grok/save 先按 batchId 查内存，内存没有（宿主重启过）再读该批次目录里的 plan.json。
//   * 上限 500 条，超了挤掉最早的一条；进程重启后内存台账清空，靠 plan.json 兜底。
const GROK_SAVE_NONCE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const GROK_SAVE_NONCE_MAX = 500
const grokSaveNonces = new Map()

/** 给一个批次发新 nonce（32 字节随机 → 64 位十六进制）。批次重发 ⇒ 旧 nonce 立刻作废。 */
function issueGrokBatchNonce(batchId) {
  const nonce = randomBytes(32).toString('hex')
  grokSaveNonces.set(batchId, { nonce, at: Date.now() })
  const now = Date.now()
  for (const [key, item] of grokSaveNonces) {
    if (now - item.at > GROK_SAVE_NONCE_TTL_MS) grokSaveNonces.delete(key)
  }
  while (grokSaveNonces.size > GROK_SAVE_NONCE_MAX) {
    const oldest = grokSaveNonces.keys().next()
    if (oldest.done) break
    grokSaveNonces.delete(oldest.value)
  }
  return nonce
}

/** 定长比较，别让 nonce 的长度/前缀差异从耗时里漏出去。 */
export function grokSaveNonceEquals(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8')
  const b = Buffer.from(String(provided), 'utf8')
  if (a.length === 0 || b.length === 0) return false
  const salt = randomBytes(16)
  const hashA = createHash('sha256').update(salt).update(a).digest()
  const hashB = createHash('sha256').update(salt).update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/**
 * nonce 校验是否强制。默认**强制**；DVP_GROK_SAVE_ALLOW_ANON=1 是给"本机无浏览器调用方"
 * 的逃生口（例如宿主侧脚本直接把图 POST 上来），要在环境里显式打开才算数。
 */
export function grokSaveNonceRequired(env) {
  const source = env === undefined ? process.env : env
  return String((source && source.DVP_GROK_SAVE_ALLOW_ANON) || '') !== '1'
}

/**
 * 这个批次该用的 nonce：内存台账优先（进程内最新发出的那次），内存没有（宿主重启过）就读
 * 该批次目录 plan.json 里记着的那一个。两处都没有 ⇒ 空串 ⇒ 一律 403（宁可拒，也不放行）。
 */
async function expectedGrokSaveNonce(batchId, readPlanNonce) {
  const known = grokSaveNonces.get(batchId)
  if (known !== undefined && typeof known.nonce === 'string' && known.nonce !== '') return known.nonce
  return await readPlanNonce()
}

/**
 * 请求体是不是"真图片"（只认魔数，不看 content-type：页面直传时 content-type 常常是
 * application/octet-stream）。返回 .ext 便于跟 ext 参数对不上时留个话头，认不出返回 ''。
 *
 * 这是三道门里最弱的一道（魔数能被伪造），它的定位是"别把明显不是图的东西写成图"，
 * 不是鉴权 —— 鉴权是 nonce 那道。
 */
export function imageFileSignature(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return ''
  const head = bytes.toString('binary')
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return '.png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return '.gif'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return '.webp'
  return ''
}

// ── Grok 驱动清单（写给人看，也写给会话里的 agent 看）────────────────────────

// 导出只为离线断言：tools/verify-grok-bytes.mjs 要直接验"这份清单里没有 base64 搬运通道"，
// 不必起 HTTP 服务。纯函数（只读 plan 对象 + path.join），无副作用。
export function driverDoc(plan) {
  const lines = []
  lines.push('# Grok 出图驱动清单')
  lines.push('')
  lines.push('- 生成时间：' + plan.createdAt)
  if (plan.batchId) lines.push('- 批次 ID：' + plan.batchId + '（重试这一批时把它回传给 /dvp/grok/plan，写回同一目录）')
  if (plan.saveNonce) {
    lines.push('- 存图 nonce：`' + plan.saveNonce + '` —— 往 /dvp/grok/save 存图时必须带上它（`?nonce=` 或请求头 `X-DVP-Nonce`），')
    lines.push('  否则 403。非白名单来源（grok.com / x.ai 之外）的页面同样被拒：这一步挡的是"任意网页往本机端点写图"。')
  }
  lines.push('- 目标站点：' + plan.grokUrl)
  lines.push('- 批次条数：' + plan.count)
  lines.push('- 图片落地：' + plan.dir)
  lines.push('- 批次文件：' + path.join(plan.dir, 'plan.json'))
  if (plan.processDir) lines.push('- 过程目录：' + plan.processDir + '（拆帧/中间草稿写这里，目录名=执行时间 年-月-日_时分）')
  if (plan.options && typeof plan.options === 'object') {
    const labels = { clarity: '清晰度', aspect: '画幅', count: '每个提示词张数' }
    const parts = []
    for (const key of Object.keys(labels)) {
      if (typeof plan.options[key] === 'string' && plan.options[key] !== '') parts.push(labels[key] + ' ' + plan.options[key])
    }
    if (parts.length > 0) lines.push('- 生图要求：' + parts.join(' · '))
    if (typeof plan.options.aspect === 'string' && plan.options.aspect !== '') {
      lines.push('  （画幅要真的在 Grok 页面上切到对应比例按钮；清晰度/质感写进提示词正文里。）')
    }
  }
  if (plan.sourceFile) lines.push('- 来源文本：' + plan.sourceFile)
  lines.push('')
  lines.push('## 执行方式')
  lines.push('')
  lines.push('由会话里的 agent 用浏览器插件驱动用户的 Edge：')
  lines.push('')
  lines.push('1. `browser_open(use:"edge", url:"' + plan.grokUrl + '")` —— 走用户登录态。')
  lines.push('2. 未登录 / 出现人机验证 / 额度用尽时**停下来叫人**，不允许绕过。')
  lines.push('3. 逐条把下面提示词贴进 Grok 输入框并发送，等新图出现。')
  if (typeof plan.options === 'object' && plan.options !== null && typeof plan.options.aspect === 'string') {
    lines.push('   发送前先把输入框下方的画幅比例切到 ' + plan.options.aspect + '，逐条对齐。')
  }
  if (plan.sourceFile) {
    lines.push('   提示词要对着来源文本里的具体情节写：先读 ' + plan.sourceFile + '，再动笔。')
  }
  lines.push('4. 每拿到一张图，在**页面上下文里**把成图字节原样 `POST /dvp/grok/save?index=<序号>&slug=<slug>'
    + (plan.batchId ? '&batch=' + plan.batchId : '')
    + (plan.saveNonce ? '&nonce=' + plan.saveNonce : '')
    + '`（raw bytes，宿主回 {file,bytes,sha256,width,height} 元信息即算落盘成功；'
    + (plan.batchId ? '同一批的图必须带同一个 batch，才会进同一目录；' : '')
    + (plan.saveNonce ? 'nonce 必须是本清单里那一个，错了直接 403；' : '')
    + '图片内容/base64 一律不进会话文本）。')
  lines.push('5. 全部投完检查 ' + path.join(plan.dir, 'ledger.json') + ' 对账。')
  lines.push('')
  lines.push('## 提示词清单')
  lines.push('')
  for (const entry of plan.entries) {
    lines.push('### ' + entry.index + '. ' + (entry.title || entry.slug))
    lines.push('')
    lines.push('- 落盘文件名：`' + String(entry.index).padStart(2, '0') + '-' + entry.slug + '.png`')
    if (entry.source) lines.push('- 素材来源：`' + entry.source + '`')
    lines.push('')
    lines.push('```text')
    lines.push(entry.prompt)
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

// ── 统一任务记录（run.json）：一条记录 = 一个批次 ─────────────────────────────
//
// 一条记录要能回答四件事：**当前步骤 / 失败原因 / 产物位置 / 状态**，并支撑三个动作：
// 续跑、仅重试失败项、取消。这里先把它落成一个**推导函数**，再由路由去读盘喂给它。
//
// 为什么另起一本 run.json，而不是往 ledger.json 上加字段：
//   ① ledger.json 是**追加式账本**：每落一张图 push 一条，`items[].file` 指回本批产物，
//      「一批一本账」是上一轮刚修好的语义。任务记录是**可变的状态视图**（当前步骤、失败原因、
//      取消标记、计数），往账本里塞这些字段就必须**为了改状态而重写账本** —— 账本就不再是账本。
//   ② 还没落任何图的新批次**根本没有** ledger.json，而任务记录从建批次那一刻就该存在。
//   ③ run.json 是**物化视图**（源：plan.json + ledger.json + 盘上事实 + control）：丢了/坏了都能重算，
//      账本与产物则一条都不能少 —— 所以"可重算的东西"单独放一份，别去污染"事实记录"。
//
// control 是唯一推导不出来的东西：谁登记了开始/取消、何时、为什么。它只由 POST /dvp/grok/run 写。
// 查询（GET）**全程只读**：不建目录、不动 index.json、不刷 run.json（断言见 verify-grok-bytes 第 5 节）。
//
// 「失败项」的判据（也就是"仅重试失败项"的输入清单）：
//   never-run        计划里有这一项，账本里没有 ⇒ 从未落图（含跑到一半被打断的）
//   file-missing     账本记过这一项，产物文件已不在盘上
//   bytes-mismatch   盘上文件字节数与账本记的不一致
//   sha256-mismatch  盘上文件 sha256 与账本记的不一致（只有 sha256 档校验查得出）
// 同一 index 被重存多次时**以账本里最后一条为准**（前面的已被覆盖，不算失败）。

const RUN_RECORD_FILE = 'run.json'
// 六个状态（README 有对照表）：pending / running / partial / succeeded / failed / cancelled。
// running **只在有人显式登记 begin 时出现** —— 宿主看不到那个浏览器会话，不猜。
const RUN_CONTROL_ACTIONS = Object.freeze(['begin', 'cancel', 'clear'])
const RUN_CONTROL_HISTORY_LIMIT = 50
/** begin 登记的有效期：过了就不再算"运行中"（否则一个没清掉的标记会永远显示运行中）。 */
const RUN_RUNNING_TTL_MS = 2 * 60 * 60 * 1000
const RUN_LIST_LIMIT = 20
const RUN_LIST_MAX = 50
const RUN_FAILURE_REASONS = Object.freeze({
  'never-run': '计划里有这一项，账本里没有：从未落图（含跑到一半被打断的）',
  'file-missing': '账本记过这一项，但产物文件已不在盘上',
  'bytes-mismatch': '盘上文件的字节数与账本记的不一致',
  'sha256-mismatch': '盘上文件的 sha256 与账本记的不一致（内容被动过）',
})

/** 计划条目的序号：plan.json 落盘时就是 `Number(entry.index) || 位置+1`，这里同一口径。 */
function runEntryIndex(entry, position) {
  const index = Number(entry && entry.index)
  return Number.isFinite(index) && index > 0 ? Math.floor(index) : position + 1
}

function runEntrySlug(entry) {
  const slug = String((entry && entry.slug) || '').trim()
  return slug === '' ? 'prompt' : slug
}

/** 这一项"本该落在哪"：账本里记过就用账本那条路径，否则按 driver.md 的命名规矩推。 */
function runExpectedFile(dir, index, slug, item) {
  if (item !== undefined && typeof item.file === 'string' && item.file !== '') return item.file
  return path.join(dir, String(index).padStart(2, '0') + '-' + slug + '.png')
}

/** control 段落清洗：坏值一律当没有（它是状态标记，不值得为它报错）。 */
export function normalizeRunControl(raw) {
  const out = { running: null, cancelled: null, history: [] }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const mark = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    if (typeof value.at !== 'string' || value.at === '') return null
    return {
      at: value.at,
      by: typeof value.by === 'string' ? value.by : '',
      reason: typeof value.reason === 'string' ? value.reason : '',
    }
  }
  out.running = mark(raw.running)
  out.cancelled = mark(raw.cancelled)
  const history = Array.isArray(raw.history) ? raw.history : []
  out.history = history
    .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.action === 'string')
    .slice(-RUN_CONTROL_HISTORY_LIMIT)
    .map((item) => ({ action: item.action, at: String(item.at || ''), by: String(item.by || ''), reason: String(item.reason || '') }))
  return out
}

/**
 * 登记一次状态动作（纯函数）。三个动作各自的语义：
 *   begin   "我开始做这一批了"（重发 plan = 续跑时自动登记）。它会**解掉取消标记**并留一条 resume ——
 *           否则"取消过就永远不能再跑"。新建批次不登记 begin：那只是"建好了待派发"。
 *   cancel  没有真中断机制，所以这里只**记下**取消（谁、何时、为什么）：不动产物、不杀进程。
 *   clear   把 running / cancelled 两个标记都清掉（误标一次不至于让这一批废掉）。
 * 返回 `{ control, action }`；动作不认识时返回 `{ error }`。
 */
export function applyRunControl(raw, action, options) {
  const control = normalizeRunControl(raw)
  const opts = options !== null && typeof options === 'object' ? options : {}
  const name = typeof action === 'string' ? action.trim() : ''
  if (!RUN_CONTROL_ACTIONS.includes(name)) {
    return { error: '未知动作：' + (name === '' ? '（空）' : name) + '（只认 ' + RUN_CONTROL_ACTIONS.join(' / ') + '）' }
  }
  const at = typeof opts.at === 'string' && opts.at !== '' ? opts.at : new Date().toISOString()
  const by = String(opts.by || 'session').slice(0, 120)
  const reason = String(opts.reason || '').slice(0, 300)
  const push = (entry) => {
    control.history.push({ action: entry, at, by, reason })
    if (control.history.length > RUN_CONTROL_HISTORY_LIMIT) control.history = control.history.slice(-RUN_CONTROL_HISTORY_LIMIT)
  }
  if (name === 'begin') {
    if (control.cancelled !== null) {
      control.cancelled = null
      push('resume')
    }
    control.running = { at, by, reason }
    push('begin')
    return { control, action: name }
  }
  if (name === 'cancel') {
    control.cancelled = { at, by, reason }
    control.running = null
    push('cancel')
    return { control, action: name }
  }
  control.running = null
  control.cancelled = null
  push('clear')
  return { control, action: name }
}

/**
 * 由可观测事实推导一条任务记录（纯函数：不读盘、不写盘、不看时钟以外的东西）。
 *
 *   输入 plan / ledger   —— plan.json、ledger.json 的内容（都可缺）
 *        control          —— run.json 里那段推导不出来的东西（可缺）
 *        disk             —— Map<绝对路径, { exists, bytes, sha256 }>（不在表里 = 盘上没这个文件）
 *        verify           —— 'sha256'（逐项重算哈希）| 'stat'（只看存在与字节数）
 *        batchId / dir / now
 *   输出 一条记录的完整形状 —— **run.json 里存的就是它**，所以落盘与查询走同一份口径。
 *
 * 状态判定顺序（先满足的先算）：
 *   ① missing=0 且 failed=0 且 total>0            → succeeded（全部有可校验的产物）
 *   ② control.cancelled 有值                      → cancelled（有产物但有半截时也算 cancelled，计数说明一切）
 *   ③ control.running 未过期                       → running
 *   ④ succeeded>0（还有没成的）                    → partial
 *   ⑤ failed>0（一个都没成）                       → failed
 *   ⑥ 其余                                        → pending（一项都还没跑）
 * 计数恒等式：succeeded + failed + missing === total（账上多出来的产物记在 orphans，另算）。
 */
export function buildGrokRunRecord(input) {
  const src = input !== null && typeof input === 'object' ? input : {}
  const now = Number.isFinite(src.now) ? src.now : Date.now()
  const verify = src.verify === 'sha256' ? 'sha256' : 'stat'
  const batchId = typeof src.batchId === 'string' ? src.batchId : ''
  const dir = typeof src.dir === 'string' ? src.dir : ''
  const plan = src.plan !== null && typeof src.plan === 'object' && !Array.isArray(src.plan) ? src.plan : null
  const ledger = src.ledger !== null && typeof src.ledger === 'object' && !Array.isArray(src.ledger) ? src.ledger : null
  const control = normalizeRunControl(src.control)
  const disk = src.disk instanceof Map ? src.disk : new Map()
  const warnings = []

  const entries = plan !== null && Array.isArray(plan.entries) ? plan.entries : []
  const items = ledger !== null && Array.isArray(ledger.items) ? ledger.items : []
  if (plan === null) warnings.push('plan.json 读不到：总数以账本条目的序号为准')
  else if (entries.length === 0) warnings.push('plan.json 的 entries 为空：总数以账本条目的序号为准')

  // 同一 index 重存多次：数组顺序即写入顺序 ⇒ 最后一条胜出。
  const latest = new Map()
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const index = Number(item.index)
    if (!Number.isFinite(index) || index <= 0) continue
    latest.set(Math.floor(index), item)
  }
  const entryByIndex = new Map()
  entries.forEach((entry, position) => {
    const index = runEntryIndex(entry, position)
    if (!entryByIndex.has(index)) entryByIndex.set(index, entry)
  })
  const planned = entries.length > 0 ? new Set(entryByIndex.keys()) : new Set(latest.keys())

  const artifacts = []
  const orphans = []
  const failures = []
  const missingSha = []
  for (const index of [...latest.keys()].sort((a, b) => a - b)) {
    const item = latest.get(index)
    const entry = entryByIndex.get(index)
    const slug = entry === undefined ? runEntrySlug(item) : runEntrySlug(entry)
    const title = entry === undefined ? '' : String((entry && entry.title) || '')
    const file = typeof item.file === 'string' ? item.file : ''
    const fact = file === '' ? undefined : disk.get(file)
    const exists = !!(fact && fact.exists === true)
    let reason = ''
    if (!exists) reason = 'file-missing'
    else if (typeof item.bytes === 'number' && fact.bytes !== item.bytes) reason = 'bytes-mismatch'
    // fact.sha256 为空 = 这一档没重算哈希（stat 档）⇒ 只当"没校验到"，不当"不符"。
    else if (verify === 'sha256' && typeof item.sha256 === 'string' && item.sha256 !== ''
      && typeof fact.sha256 === 'string' && fact.sha256 !== '' && fact.sha256 !== item.sha256) reason = 'sha256-mismatch'
    if (exists && typeof item.sha256 !== 'string' && !missingSha.includes(index)) missingSha.push(index)
    const artifact = {
      index,
      slug,
      title,
      file,
      relFile: dir === '' || file === '' ? '' : path.relative(dir, file).split(path.sep).join('/'),
      bytes: exists ? fact.bytes : (typeof item.bytes === 'number' ? item.bytes : 0),
      sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
      signature: typeof item.signature === 'string' ? item.signature : '',
      at: typeof item.at === 'string' ? item.at : '',
    }
    if (planned.has(index)) {
      if (reason === '') artifacts.push({ ...artifact, verified: verify })
      else failures.push({ index, slug, title, reason, detail: RUN_FAILURE_REASONS[reason], file, expectedFile: runExpectedFile(dir, index, slug, item), at: artifact.at })
    } else {
      // 账上有、计划里没有：不当成失败（它可能是手动补投的图），单独列出来并留一句警告。
      orphans.push({ ...artifact, verified: reason === '' ? verify : reason })
    }
  }
  for (const [index, entry] of entryByIndex) {
    if (latest.has(index)) continue
    const slug = runEntrySlug(entry)
    failures.push({
      index,
      slug,
      title: String((entry && entry.title) || ''),
      reason: 'never-run',
      detail: RUN_FAILURE_REASONS['never-run'],
      file: '',
      expectedFile: runExpectedFile(dir, index, slug, undefined),
      at: '',
    })
  }
  failures.sort((a, b) => a.index - b.index)

  const total = planned.size
  const succeeded = artifacts.length
  const failed = failures.filter((item) => item.reason !== 'never-run').length
  const missing = failures.filter((item) => item.reason === 'never-run').length
  if (orphans.length > 0) {
    warnings.push('账本里有 ' + orphans.length + ' 条产物不在本批计划里（序号 ' + orphans.map((o) => o.index).join('/') + '）：不计入成功/失败，另列 orphans')
  }
  if (missingSha.length > 0) warnings.push('账本缺 sha256 的旧条目（序号 ' + missingSha.join('/') + '）：只能按存在性与字节数校验')

  const runningFresh = control.running !== null && (() => {
    const at = Date.parse(control.running.at)
    return Number.isFinite(at) && now - at >= 0 && now - at <= RUN_RUNNING_TTL_MS
  })()
  if (control.running !== null && !runningFresh) warnings.push('begin 登记已超过 ' + Math.round(RUN_RUNNING_TTL_MS / 3600000) + ' 小时，不再算运行中')

  let status
  if (total > 0 && missing === 0 && failed === 0) status = 'succeeded'
  else if (control.cancelled !== null) status = 'cancelled'
  else if (runningFresh) status = 'running'
  else if (succeeded > 0) status = 'partial'
  else if (failed > 0) status = 'failed'
  else status = 'pending'

  // 当前步骤：**由可观测事实推导**，不是会话自述。running/dispatch 只在有人登记过 begin 时出现。
  let step
  if (status === 'succeeded') {
    step = { id: 'done', label: '完成：' + total + ' 项都有可校验的产物' }
  } else if (status === 'cancelled') {
    const mark = control.cancelled
    step = { id: 'cancelled', label: '已取消（' + (mark.by || '未记名') + ' 于 ' + mark.at + (mark.reason === '' ? '' : '：' + mark.reason) + '）' }
  } else if (status === 'failed') {
    step = { id: 'verify', label: '产物校验未过：' + failed + ' 项坏/缺，' + missing + ' 项未跑' }
  } else if (status === 'running') {
    const mark = control.running
    step = { id: 'dispatch', label: '驱动中（' + (mark.by || '未记名') + ' 于 ' + mark.at + ' 登记开始）' }
  } else if (succeeded > 0) {
    step = { id: 'collect', label: '收图中：已落 ' + succeeded + ' / ' + total + ' 项（还差 ' + (failed + missing) + ' 项）' }
  } else {
    step = { id: 'plan', label: '批次已建立，尚无成图（待派发）' }
  }

  const stamps = [plan === null ? '' : String(plan.createdAt || ''), ledger === null ? '' : String(ledger.updatedAt || '')]
    .concat(artifacts.map((a) => a.at), failures.map((f) => f.at), control.history.map((h) => h.at))
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
  stamps.sort((a, b) => Date.parse(a) - Date.parse(b))

  return {
    runId: batchId,
    batchId,
    kind: 'grok-batch',
    status,
    step,
    counts: { total, succeeded, failed, missing, orphan: orphans.length },
    failures,
    artifacts,
    orphans,
    control,
    warnings,
    dir,
    planFile: dir === '' ? '' : path.join(dir, 'plan.json'),
    ledgerFile: dir === '' ? '' : path.join(dir, 'ledger.json'),
    runFile: dir === '' ? '' : path.join(dir, RUN_RECORD_FILE),
    createdAt: plan === null ? '' : String(plan.createdAt || ''),
    startedAt: (plan !== null && typeof plan.createdAt === 'string' && plan.createdAt !== '')
      ? plan.createdAt
      : (stamps.length > 0 ? stamps[0] : ''),
    updatedAt: stamps.length > 0 ? stamps[stamps.length - 1] : '',
    verify,
  }
}

/**
 * 「仅重试失败项」的驱动清单（纯函数，给人看也给会话里的 agent 看）。
 *
 * 这只做到了**清单输出**：宿主不驱动浏览器，"自动重跑"这件事由会话里的 agent 照着这份清单做。
 * 清单刻意**不新建批次、不重发 plan**：已成功的那几项不再投，只补失败项，图照旧进同一批目录。
 * nonce 不写进这份文本（它只沿"派发"那条线走）——只告诉你去本批 plan.json 里读。
 */
export function runRetryDriverDoc(record, plan) {
  const rec = record !== null && typeof record === 'object' ? record : {}
  const failures = Array.isArray(rec.failures) ? rec.failures : []
  const counts = rec.counts !== null && typeof rec.counts === 'object' ? rec.counts : {}
  const batchId = String(rec.batchId || '')
  const dir = String(rec.dir || '')
  const planFile = String(rec.planFile || (dir === '' ? 'plan.json' : path.join(dir, 'plan.json')))
  const entries = plan !== null && typeof plan === 'object' && Array.isArray(plan.entries) ? plan.entries : []
  const promptOf = (index) => {
    for (let i = 0; i < entries.length; i += 1) {
      if (runEntryIndex(entries[i], i) === index) return String((entries[i] && entries[i].prompt) || '')
    }
    return ''
  }
  const n = (value) => (Number.isFinite(value) ? value : 0)
  const lines = []
  lines.push('# 仅重试失败项 · ' + batchId)
  lines.push('')
  lines.push('- 批次目录：' + dir)
  lines.push('- 本批共 ' + n(counts.total) + ' 项：成功 ' + n(counts.succeeded) + ' / 失败 ' + n(counts.failed) + ' / 未跑 ' + n(counts.missing))
  lines.push('- 本次**只重跑下面 ' + failures.length + ' 项**：已成功的那 ' + n(counts.succeeded) + ' 项不再投，也**不新建批次**')
  lines.push('  （新建批次会另起一个目录，本批永远补不齐）。')
  lines.push('- 存图 nonce 从本批 `' + planFile + '` 里读 `saveNonce`（`GET /dvp/grok/plan` 刻意不回吐它）。')
  lines.push('  本机没有那个值（宿主重启过、批次被别人重发过）时：对**同一个批次**重发 `POST /dvp/grok/plan`')
  lines.push('  （带 `batch=' + batchId + '` 与全量 entries）换一把新的 —— 那也算续跑，写回同一目录，历史里会留一条 resume。')
  lines.push('')
  if (failures.length === 0) {
    lines.push('（本批没有需要重跑的项。）')
    return lines.join('\n')
  }
  lines.push('## 重跑清单')
  lines.push('')
  for (const item of failures) {
    const slug = String(item.slug || 'prompt')
    const expected = String(item.expectedFile || item.file || '')
    lines.push('### ' + String(item.index).padStart(2, '0') + '. ' + (item.title || slug))
    lines.push('')
    lines.push('- 为什么重跑：' + (item.detail || RUN_FAILURE_REASONS[item.reason] || item.reason) + '（reason=' + item.reason + '）')
    lines.push('- 落盘文件名：`' + (expected === '' ? String(item.index).padStart(2, '0') + '-' + slug + '.png' : path.basename(expected)) + '`')
    lines.push('- 取图 → 落盘：`POST /dvp/grok/save?batch=' + batchId + '&index=' + item.index + '&slug=' + slug
      + '&ext=<该图真实封装>&nonce=<本批 saveNonce>`（raw bytes；字节/base64 一律不进会话文本）')
    const prompt = promptOf(item.index)
    if (prompt !== '') {
      lines.push('')
      lines.push('```text')
      lines.push(prompt)
      lines.push('```')
    }
    lines.push('')
  }
  lines.push('## 做完之后')
  lines.push('')
  lines.push('- 重新 `GET /dvp/grok/run?batch=' + batchId + '&driver=1` 看 `status` 与 `counts`：')
  lines.push('  `failures` 空、`missing` 与 `failed` 都是 0 才算这一批做完；')
  lines.push('- 若中途要停：`POST /dvp/grok/run`（`{batchId:"' + batchId + '",action:"cancel",by:"<谁>",reason:"<为什么>"}`）')
  lines.push('  只**记下**取消（不动产物、不杀进程）；下次重发 plan 就是续跑，会留一条 resume。')
  return lines.join('\n')
}

/** 账本里所有记过的产物路径（去重前先收齐，缺字段的旧账本一律忽略）。 */
function ledgerArtifactFiles(ledger) {
  const out = []
  if (ledger !== null && typeof ledger === 'object' && Array.isArray(ledger.items)) {
    for (const item of ledger.items) {
      if (item !== null && typeof item === 'object' && typeof item.file === 'string' && item.file !== '') out.push(item.file)
    }
  }
  return out
}

/** 读一份 JSON；缺失/损坏都返回 null（记录是推导件，读不到就当没有，绝不因此报错）。 */
async function readJsonOrNull(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    return parsed === null || typeof parsed !== 'object' ? null : parsed
  } catch {
    return null
  }
}

/** 把盘上事实收成 Map<路径, {exists,bytes,sha256}>。sha256 档才真的读文件算哈希。 */
async function collectRunDiskFacts(files, verify) {
  const disk = new Map()
  for (const file of files) {
    if (typeof file !== 'string' || file === '' || disk.has(file)) continue
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) {
        disk.set(file, { exists: false, bytes: 0, sha256: null })
        continue
      }
      const fact = { exists: true, bytes: stat.size, sha256: null }
      if (verify === 'sha256') fact.sha256 = createHash('sha256').update(await fsp.readFile(file)).digest('hex')
      disk.set(file, fact)
    } catch {
      disk.set(file, { exists: false, bytes: 0, sha256: null })
    }
  }
  return disk
}

// ── 路径围栏 ────────────────────────────────────────────────────────────────

function within(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 解析本次运行实际生效的媒体/产物根，并**同步刷新**运行期配置。
 *
 * 两个边界必须一起成立，否则会出现"保存了新目录、后续还是写旧目录"：
 *   ① 语义上：`undefined` = 调用方没提交这个字段（保留现值）；`null` = 明确清空（回默认）。
 *      —— 只用 `typeof x === 'string'` 判断的话，面板只提交一个 `{ pipelineMode }` 时
 *      媒体/产物目录会被 `undefined` 覆盖掉，state.json 里两个根一起消失。
 *   ② 运行期：`apply()` 里各个路由用的是 `runtime.mediaRoot` / `runtime.runsRoot`（对象读），
 *      不是启动时锁死的常量 —— 否则 `/dvp/state` 保存新目录后，写盘的那些路由仍打旧目录。
 */
function resolveRuntime(config, patch, current) {
  const base = current || {}
  patch = patch && typeof patch === 'object' ? patch : {}
  // 注意 `if (patch.mediaRoot === null) next.mediaRoot = …` 这种写法是错的：
  // 当前值优先会让"明确清空"被忽略（null 判了也没用）。用 `in` 判"提交了没有"：
  //   提交了（含 null）→ 用提交值（null = 回落到 config 默认）；
  //   没提交 → 保留当前值（current）→ 再退 config。
  return {
    mediaRoot: 'mediaRoot' in patch
      ? resolveRoot(patch.mediaRoot, path.resolve(config.mediaRoot))
      : (base.mediaRoot || path.resolve(config.mediaRoot)),
    runsRoot: 'runsRoot' in patch
      ? resolveRoot(patch.runsRoot, path.resolve(config.runsRoot))
      : (base.runsRoot || path.resolve(config.runsRoot)),
  }
}

/**
 * 追加一条派发历史并按任务 ID 去重，保留最近 RUN_HISTORY_LIMIT 条。
 *
 * 面板每次只提交**最新一条**（body.runs 长度为 1），所以宿主必须做"追加"，
 * 直接 `body.runs` 覆盖会把已有历史挤没 —— 界面上就是"派发过几次，历史里只剩最后一次"。
 * 去重口径：优先用 run.id；没有 id 的旧记录退到 `at|kind|processDir` 指纹
 * （同一次派发的重复提交会撞在同一个指纹上，不同批次不会）。
 */
const RUN_HISTORY_LIMIT = 30

function runKey(run) {
  if (typeof run.id === 'string' && run.id !== '') return 'id:' + run.id
  return 'fp:' + [String(run.at || ''), String(run.kind || ''), String(run.processDir || '')].join('|')
}

function mergeRunHistory(existing, incoming, limit = RUN_HISTORY_LIMIT) {
  const out = []
  const seen = new Set()
  const push = (run) => {
    if (run === null || typeof run !== 'object' || Array.isArray(run)) return
    const key = runKey(run)
    if (seen.has(key)) return
    seen.add(key)
    out.push(run)
  }
  for (const run of Array.isArray(existing) ? existing : []) push(run)
  for (const run of Array.isArray(incoming) ? incoming : []) push(run)
  return out.length > limit ? out.slice(out.length - limit) : out
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function classify(ext) {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'other'
}

/**
 * 扫描媒体目录。
 *
 * `maxDepth` 是**给定目录之外的递归层数**：0 = 只看这一层，1 = 再进一层子目录。
 * 早期实现把传入值直接和当前层比较，默认 depth=1 时一个子目录都不进 —— 于是
 * `media/images`、`media/videos` 这种最常见的摆法会扫出空列表（实测复现过）。
 * 现在 /dvp/scan 的默认值是 4：素材常见摆法是「一层剧/书 + 一层章节/集数」，
 * 给 2 层时用户的体感就是"图在盘里、面板里没有"。面板上有层数下拉可以改。
 */
async function scanDir(root, dir, maxDepth) {
  const items = []
  const skipped = []
  let truncated = false

  async function walk(current, level) {
    if (truncated) return
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch (err) {
      skipped.push({ path: current, reason: String((err && err.message) || err) })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    for (const entry of entries) {
      if (items.length >= MAX_SCAN_ENTRIES) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (level < maxDepth) await walk(full, level + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      const kind = classify(ext)
      if (kind === 'other') continue
      let stat
      try {
        stat = await fsp.stat(full)
      } catch {
        continue
      }
      items.push({
        name: entry.name,
        path: full,
        rel: path.relative(root, full).split(path.sep).join('/'),
        ext,
        kind,
        bytes: stat.size,
        mtime: stat.mtimeMs,
      })
    }
  }

  await walk(dir, 0)
  const images = items.filter((i) => i.kind === 'image')
  const videos = items.filter((i) => i.kind === 'video')
  const texts = items.filter((i) => i.kind === 'text')
  return { dir, images, videos, texts, skipped, truncated, depth: maxDepth }
}

// ── ffprobe（尽力而为，失败不影响流程）────────────────────────────────────────

let ffprobePath

async function findFfprobe() {
  if (ffprobePath !== undefined) return ffprobePath
  const candidates = [
    process.env.FFPROBE_PATH,
    'D:/ChatGPT/video-prompt-tools/bin/ffprobe.exe',
    'ffprobe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const ok = await new Promise((resolve) => {
      try {
        execFile(candidate, ['-version'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err))
      } catch {
        resolve(false)
      }
    })
    if (ok) {
      ffprobePath = candidate
      return ffprobePath
    }
  }
  ffprobePath = null
  return ffprobePath
}

function probeVideo(bin, file) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-show_entries', 'format=duration', '-of', 'json', file],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: String((err && err.message) || err) })
          return
        }
        try {
          const parsed = JSON.parse(stdout)
          const stream = (parsed.streams && parsed.streams[0]) || {}
          const duration = Number(stream.duration || (parsed.format && parsed.format.duration) || 0)
          resolve({
            ok: true,
            width: Number(stream.width) || null,
            height: Number(stream.height) || null,
            duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
          })
        } catch (parseErr) {
          resolve({ ok: false, error: String((parseErr && parseErr.message) || parseErr) })
        }
      },
    )
  })
}

// ── 逐项状态（每目录一份 manifest）──────────────────────────────────────────

function manifestFile(dir) {
  return path.join(dir, '.dsh-video-prompt', 'manifest.json')
}

async function readManifest(dir) {
  try {
    const text = await fsp.readFile(manifestFile(dir), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && parsed.items ? parsed : { items: {}, runs: [] }
  } catch {
    return { items: {}, runs: [] }
  }
}

async function writeManifest(dir, data) {
  const file = manifestFile(dir)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
  return data
}

// ── 技能注册 ────────────────────────────────────────────────────────────────

/**
 * 解析 SKILL.md 的 YAML frontmatter（只取本插件需要的字段）。
 *
 * 必须处理 YAML 块标量：本包 5 个技能里 `prompt-videos` 用的是
 * `description: >`（折叠块，正文在后续缩进行里），`oneshot-prompt-generator`
 * 用的是带引号的单行。早期版本只认 `key: value` 单行，块标量会解析成字面量
 * ">"，description 变成 1 个字符 —— 技能目录里就会出现一个说不清干什么的技能。
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { attrs: {}, body: text }
  const lines = match[1].split(/\r?\n/)
  const attrs = {}
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1]
    const inline = kv[2].trim()
    // 块标量：`>` 折叠（换行接空格）/ `|` 字面（保留换行），可带 chomping 指示符
    if (/^[>|][+-]?\d*$/.test(inline)) {
      const folded = inline.startsWith('>')
      const block = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const line = lines[j]
        if (line.trim() === '') {
          block.push('')
          continue
        }
        if (!/^[ \t]/.test(line)) break
        block.push(line.replace(/^[ \t]+/, ''))
      }
      i = j - 1
      const text2 = folded
        ? block.join(' ').replace(/[ \t]+/g, ' ').trim()
        : block.join('\n').trim()
      if (text2 !== '') attrs[key] = text2
      continue
    }
    let value = inline
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    attrs[key] = value
  }
  return { attrs, body: text.slice(match[0].length) }
}

async function loadSkills(root) {
  let dirs
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const file = path.join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    const { attrs, body } = parseFrontmatter(text)
    const skillName = (attrs.name || entry.name).trim()
    const description = (attrs.description || '').replace(/\s+/g, ' ').trim()
    if (skillName === '' || description === '') continue
    skills.push({
      name: skillName,
      description,
      whenToUse: attrs.whenToUse || attrs.when_to_use || undefined,
      contentRange: body.trim() === '' ? text : body.trim(),
      resourceBase: { kind: 'directory', path: dir },
      dir,
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return skills
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    ...(extraHeaders || {}),
  })
  res.end(body)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function query(url, key) {
  const index = url.indexOf('?')
  if (index < 0) return ''
  const params = new URLSearchParams(url.slice(index + 1))
  return params.get(key) || ''
}

/** 与 readBody 同一段逻辑，但回 Buffer —— raw 图片字节直传模式不能过 toString('utf8')。 */
function readRaw(req, limit = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 只读头部几十字节的图片宽高清道器（PNG / JPEG / GIF / WebP）。
 * 目的只有一个：让宿主在 /dvp/grok/save 的**响应里**回带 width/height，
 * 会话里的 agent 拿元信息就能确认"这张图确实取到了"，不必（也不许）把图片
 * 内容读回上下文。解不出尺寸返回 0/0 —— 0 不代表失败，只代表这条通道不认这个封装。
 */
function imageSize(bytes) {
  const out = { width: 0, height: 0 }
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) return out
  // PNG: 8 字节签名 + 4 长度 + "IHDR" + BE width/height
  if (bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    out.width = bytes.readUInt32BE(16)
    out.height = bytes.readUInt32BE(20)
    return out
  }
  // GIF: "GIF87a"/"GIF89a" + LE width/height
  if (bytes.toString('ascii', 0, 6).startsWith('GIF8')) {
    out.width = bytes.readUInt16LE(6)
    out.height = bytes.readUInt16LE(8)
    return out
  }
  // JPEG: 从 SOI 起扫 SOF0..SOF15（跳过 DHT/DAC/RST 等定长段）
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) { off += 1; continue }
      const marker = bytes[off + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        out.height = bytes.readUInt16BE(off + 5)
        out.width = bytes.readUInt16BE(off + 7)
        return out
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
      off += 2 + bytes.readUInt16BE(off + 2)
    }
    return out
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X 三种子头各有尺寸编码
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const tag = bytes.toString('ascii', 12, 16)
    if (tag === 'VP8 ' && bytes.length >= 30) {
      out.width = bytes.readUInt16LE(26) & 0x3fff
      out.height = bytes.readUInt16LE(28) & 0x3fff
    } else if (tag === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21)
      out.width = (bits & 0x3fff) + 1
      out.height = ((bits >> 14) & 0x3fff) + 1
    } else if (tag === 'VP8X' && bytes.length >= 30) {
      out.width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      out.height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    }
    return out
  }
  return out
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

// 离线断言用的纯函数出口（tools/probe-host.mjs、tools/verify-*.mjs 直接 import 这些，
// 不必起 HTTP 服务就能验"只提交一个字段不覆盖别的字段"与"历史追加去重"）。
export { resolveRuntime, mergeRunHistory, RUN_HISTORY_LIMIT, imageSize }

export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const persisted = await readState()
  // 运行期生效的根：**可变对象**，/dvp/state 保存后同步刷新（见 resolveRuntime 注释）
  const runtime = resolveRuntime(config, {
    // 盘上存过的根优先；没存过的键不放进 patch，交给 config 兜底
    ...('mediaRoot' in persisted ? { mediaRoot: persisted.mediaRoot } : {}),
    ...('runsRoot' in persisted ? { runsRoot: persisted.runsRoot } : {}),
  })
  const mediaRoot = () => runtime.mediaRoot
  const runsRoot = () => runtime.runsRoot
  const allowedRoots = [runtime.mediaRoot, runtime.runsRoot, path.resolve(process.cwd())]

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.warn('[dsh-video-prompt] webServer 不可用，宿主路由未挂载')
    return
  }

  const disposers = []
  const allowAny = (target) => allowedRoots.some((root) => within(root, target))

  // ---- ① 扫描 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/scan',
    handler: async (req, res) => {
      try {
        const raw = query(req.url, 'path') || mediaRoot()
        const depthParam = query(req.url, 'depth')
        // 默认 4 层：素材常按「一部剧/一本书一个子目录」摆，默认 2 层会只扫到一半
        // （用户看到的现象就是"图明明在盘里，面板里没有"）。上限 8 层防呆。
        const depth = depthParam === '' ? 4 : Math.max(0, Math.min(8, Number(depthParam) || 0))
        const dir = path.resolve(raw)
        if (!allowAny(dir)) {
          sendJson(res, 403, { ok: false, error: '目录不在允许的根目录内', dir, allowedRoots })
          return
        }
        if (!existsSync(dir)) {
          sendJson(res, 404, { ok: false, error: '目录不存在', dir })
          return
        }
        const result = await scanDir(dir, dir, depth)
        const manifest = await readManifest(dir)
        sendJson(res, 200, {
          ok: true,
          ...result,
          state: manifest.items || {},
          counts: { images: result.images.length, videos: result.videos.length, texts: result.texts.length },
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ①b 选目录（v0.4.0：输出/媒体文件夹不再只能手打路径）----
  // 用宿主自己的目录选择缝 `ctx.directoryPicker`（由 dsh-host-directory-picker-auto 按宿主处境
  // 挂 native 或 browse 后端）：native 后端 `capability().pick()` 直接弹 OS 对话框并返回绝对路径，
  // 取消返回 null。**不自己造对话框**（PowerShell/Electron 各写一套既不统一也不可移植）。
  // 服务没组合（或被卸载）时如实报 unavailable，前端退回"手填路径"，不假装能用。
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/pick-dir',
    handler: async (req, res) => {
      try {
        const picker = ctx.get('directoryPicker')
        if (picker === undefined || typeof picker.capability !== 'function') {
          sendJson(res, 200, { ok: false, error: 'unavailable', message: '这个宿主没有组合目录选择器：请直接手填路径（或装 dsh-host-directory-picker-auto）' })
          return
        }
        const cap = picker.capability()
        if (cap && cap.kind === 'native') {
          const dir = await cap.pick()
          sendJson(res, 200, { ok: true, dir: typeof dir === 'string' ? dir : '', canceled: typeof dir !== 'string' })
          return
        }
        // browse 后端（远程/无头宿主）：能力词汇是"在应用内列举与创建"，不是 OS 对话框。
        // 本插件前端还没接那套浏览 UI，如实说明，别让用户以为是弹框失败。
        sendJson(res, 200, { ok: false, error: 'browse-only', message: '这个宿主的目录选择是应用内浏览式：请手填路径' })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ② 读文本（提示词预览）----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/file',
    handler: async (req, res) => {
      try {
        // 围栏对**所有**允许根生效（mediaRoot / runsRoot / 工作区 / 记住过的目录）。
        // 早先只对着 allowedRoots[0]（mediaRoot）解析，产物目录里的 md 会被误判"越界"，
        // 面板「按路径加」就永远加不上非媒体目录里的文档（用户报"识别不了 md"的成因之一）。
        const resolved = path.resolve(String(query(req.url, 'path') || ''))
        const target = allowAny(resolved) && existsSync(resolved) ? resolved : null
        if (!target || !existsSync(target)) {
          sendJson(res, 404, { ok: false, error: '文件不存在或越界' })
          return
        }
        const stat = await fsp.stat(target)
        const name = path.basename(target)
        if (stat.size > MAX_TEXT_BYTES) {
          sendJson(res, 200, { ok: true, path: target, name, truncated: true, text: (await fsp.readFile(target, 'utf8')).slice(0, MAX_TEXT_BYTES) })
          return
        }
        sendJson(res, 200, { ok: true, path: target, name, bytes: stat.size, truncated: false, text: await fsp.readFile(target, 'utf8') })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ③ 读图片字节（缩略图）----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/image',
    handler: async (req, res) => {
      try {
        const target = path.resolve(query(req.url, 'path'))
        const ext = path.extname(target).toLowerCase()
        if (!allowAny(target) || !IMAGE_EXT.has(ext) || !existsSync(target)) {
          sendJson(res, 404, { ok: false, error: '图片不存在或越界' })
          return
        }
        const stat = await fsp.stat(target)
        if (stat.size > MAX_IMAGE_BYTES) {
          sendJson(res, 413, { ok: false, error: '图片过大' })
          return
        }
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': String(stat.size),
        })
        createReadStream(target).pipe(res)
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ④ ffprobe ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/probe',
    handler: async (req, res) => {
      try {
        const target = path.resolve(query(req.url, 'path'))
        if (!allowAny(target) || !existsSync(target)) {
          sendJson(res, 404, { ok: false, error: '文件不存在或越界' })
          return
        }
        const bin = await findFfprobe()
        if (bin === null) {
          sendJson(res, 200, { ok: false, error: '未找到 ffprobe', hint: '设置 FFPROBE_PATH 或把 ffprobe 放进 PATH' })
          return
        }
        sendJson(res, 200, await probeVideo(bin, target))
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑤ 面板配置读写 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/state',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const state = await readState()
          sendJson(res, 200, {
            ok: true,
            state,
            defaults: { mediaRoot: mediaRoot(), runsRoot: runsRoot() },
            skills: (await currentSkills()).map((s) => s.name),
          })
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const patch = JSON.parse(await readBody(req))
          const grokOptions = sanitizeGrokOptions(patch.grokOptions)
          const pipelineMode = sanitizePipelineMode(patch.pipelineMode)
          // 只提交了哪个字段就只改哪个：没提交（undefined）保留现值，null 才是明确清空。
          // 早先写成 `typeof patch.mediaRoot === 'string' ? … : undefined`，于是面板只提交
          // `{ pipelineMode }` 时两个根被 undefined 覆盖 —— state.json 里的媒体/产物目录直接消失。
          const statePatch = {}
          if ('mediaRoot' in patch) statePatch.mediaRoot = patch.mediaRoot === null || patch.mediaRoot === '' ? null : resolveRoot(patch.mediaRoot, path.join(stateDir(), 'media'))
          if ('runsRoot' in patch) statePatch.runsRoot = patch.runsRoot === null || patch.runsRoot === '' ? null : resolveRoot(patch.runsRoot, path.join(stateDir(), 'runs'))
          if (grokOptions !== undefined) statePatch.grokOptions = grokOptions
          if (pipelineMode !== undefined) statePatch.pipelineMode = pipelineMode
          const next = await writeState(statePatch)
          // 保存成功就同步刷新运行期配置：后面写盘的每个路由都打新目录
          // （不再"保存了新目录、还写旧目录"）。`statePatch` 里带 null 的键 = 明确清空，
          // resolveRuntime 会把它落回 config 默认目录。
          const effective = resolveRuntime(config, statePatch, runtime)
          runtime.mediaRoot = effective.mediaRoot
          runtime.runsRoot = effective.runsRoot
          for (const root of [effective.mediaRoot, effective.runsRoot]) {
            if (!allowedRoots.includes(root)) allowedRoots.push(root)
          }
          sendJson(res, 200, {
            ok: true,
            state: next,
            // 当前**实际生效**的路径（展开过 ~ / $DSH_HOME 的绝对路径），面板据此显示与回报
            effective: { mediaRoot: runtime.mediaRoot, runsRoot: runtime.runsRoot },
            defaults: { mediaRoot: runtime.mediaRoot, runsRoot: runtime.runsRoot },
          })
          return
        }
        sendJson(res, 405, { ok: false, error: '方法不允许' })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑥ 目录级 manifest ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/manifest',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const dir = path.resolve(query(req.url, 'dir'))
          if (!allowAny(dir)) {
            sendJson(res, 403, { ok: false, error: '目录越界' })
            return
          }
          sendJson(res, 200, { ok: true, ...(await readManifest(dir)) })
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = JSON.parse(await readBody(req))
          const dir = path.resolve(String(body.dir || ''))
          if (!allowAny(dir)) {
            sendJson(res, 403, { ok: false, error: '目录越界' })
            return
          }
          const merged = await readManifest(dir)
          const items = { ...merged.items, ...(body.items && typeof body.items === 'object' ? body.items : {}) }
          // 历史按任务 ID **追加去重**，保留最近 RUN_HISTORY_LIMIT 条。
          // 面板每次只提交最新一条，直接拿 body.runs 覆盖会把之前的历史挤没
          // （界面上的现象就是"派发过几次，历史里只剩最后一次"）。
          const runs = mergeRunHistory(merged.runs, body.runs)
          const written = await writeManifest(dir, { items, runs, updatedAt: new Date().toISOString() })
          sendJson(res, 200, { ok: true, ...written, runCount: runs.length })
          return
        }
        sendJson(res, 405, { ok: false, error: '方法不允许' })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑦ 建运行目录 + 落盘提示词 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/run',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        const body = JSON.parse(await readBody(req))
        const slug = String(body.slug || 'run').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'run'
        // 目录名用本地时间、精确到分钟（2026-09-11_1705-slug），与 /dvp/process 同一套命名；
        // 同一分钟内的第二次派发自动追加 -2。
        const runDir = resolveUniqueDir(runsRoot(), localStampMinute() + '-' + slug)
        if (!allowAny(runDir)) {
          sendJson(res, 403, { ok: false, error: '运行目录越界' })
          return
        }
        await fsp.mkdir(runDir, { recursive: true })
        const written = []
        if (typeof body.optimizedPrompt === 'string' && body.optimizedPrompt.trim() !== '') {
          const file = path.join(runDir, 'optimized-image-prompt.md')
          await fsp.writeFile(file, body.optimizedPrompt, 'utf8')
          written.push(file)
        }
        if (typeof body.videoPrompt === 'string' && body.videoPrompt.trim() !== '') {
          const file = path.join(runDir, 'optimized-video-prompt.md')
          await fsp.writeFile(file, body.videoPrompt, 'utf8')
          written.push(file)
        }
        if (typeof body.inversePrompt === 'string' && body.inversePrompt.trim() !== '') {
          const file = path.join(runDir, 'inverse-prompt.md')
          await fsp.writeFile(file, body.inversePrompt, 'utf8')
          written.push(file)
        }
        if (typeof body.request === 'string' && body.request.trim() !== '') {
          const file = path.join(runDir, 'dispatch-request.md')
          await fsp.writeFile(file, body.request, 'utf8')
          written.push(file)
        }
        sendJson(res, 200, { ok: true, runDir, written })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑧ 插件自带静态页（预览页 / 以后的面板独立页）----
  // 只在包内白名单目录 servable/ 下取文件，且按扩展名给 Content-Type。
  // 用途：不重启 DSH 也能在真实页面里验收 UI（/dvp/preview/）。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: '/dvp/preview',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://dsh.invalid')
        const rel = decodeURIComponent(url.pathname.replace(/^\/dvp\/preview\/?/, '')) || 'index.html'
        const file = path.resolve(SERVABLE_ROOT, rel.replace(/^[/\\]+/, ''))
        if (!within(SERVABLE_ROOT, file)) {
          sendJson(res, 403, { ok: false, error: '路径越界' })
          return
        }
        const ext = path.extname(file).toLowerCase()
        const body = await fsp.readFile(file)
        res.writeHead(200, {
          'Content-Type': SERVABLE_MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      } catch (err) {
        sendJson(res, 404, { ok: false, error: '预览资源不存在：' + String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑧b 来源文本落盘（小说免费章节 / 章纲）----
  // 面板里的正文不塞进对话框，也不进 state.json：落成 runsRoot/source/<label>.md，
  // 请求里只带路径，agent 按需去读。
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/source',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST' && req.method !== 'PUT') {
          sendJson(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        const body = JSON.parse(await readBody(req, 8 * 1024 * 1024))
        const text = typeof body.text === 'string' ? body.text : ''
        if (text.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'text 为空' })
          return
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
          sendJson(res, 413, { ok: false, error: '来源文本过大（上限 ' + Math.round(MAX_SOURCE_BYTES / 1024 / 1024) + ' MB）' })
          return
        }
        const dir = path.join(runsRoot(), 'source')
        if (!allowAny(dir)) {
          sendJson(res, 403, { ok: false, error: '目录越界' })
          return
        }
        const label = slugify(body.label || 'novel', 'novel')
        const file = path.join(dir, label + '.md')
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(file, text, 'utf8')
        sendJson(res, 200, { ok: true, file, bytes: Buffer.byteLength(text, 'utf8'), chars: text.length, dir })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑧c 过程目录：一次派发一个，按执行时间命名（年-月-日_时分）----
  // 拆帧结果、爆款元素分析、提示词草稿这类**过程产物**都归到 <runsRoot>/process/ 下，
  // 目录名就是执行时间（2026-09-11_1705-<slug>），与最终产物（runsRoot 根下的 run 目录、
  // grok-output 成图）分开。宿主只负责建目录；往里写什么由会话里的 agent 按派发请求执行。
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/process',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST' && req.method !== 'PUT') {
          sendJson(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        const body = JSON.parse(await readBody(req))
        const slug = slugify(body.slug || 'batch', 'batch')
        const mode = sanitizePipelineMode(body.mode) || 'prompt'
        const root = path.join(runsRoot(), 'process')
        if (!allowAny(root)) {
          sendJson(res, 403, { ok: false, error: '过程目录越界' })
          return
        }
        const dir = resolveUniqueDir(root, localStampMinute() + '-' + slug)
        const frames = path.join(dir, 'frames')
        await fsp.mkdir(frames, { recursive: true })
        const analysis = mode === 'viral' ? path.join(dir, '爆款元素') : ''
        if (analysis !== '') await fsp.mkdir(analysis, { recursive: true })
        sendJson(res, 200, { ok: true, dir, frames, ...(analysis === '' ? {} : { analysis }), root, mode })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑨ Grok 出图：批次落盘 / 读回 / 图片字节保存 ----
  // 浏览器驱动那一步由会话里的浏览器插件做（它持用户的 Edge 登录态）；
  // 宿主这边只负责把提示词批次记下来、把抓到的图落到工作区。
  //
  // **每批一个目录**：<mediaRoot>/grok-output/<batchId>/，batchId = 年-月-日_时分-<slug>
  // （同一分钟重复派发自动加 -2/-3，与 /dvp/run、/dvp/process 同一套写法）。
  // 早先 plan.json / driver.md / source-*.md / 成图都直接落在 grok-output 根下，
  // 于是"新批次覆盖旧批次"、"同名 slug 的图互相盖"，而 ledger.json 是**追加**的
  // （见下方 save 路由），账上留着两条批次记录、盘上只剩最后一批 —— 账本与产物对不上。
  const grokRoot = () => path.join(mediaRoot(), 'grok-output')

  /** 解析请求体里的批次身份（口径见 BATCH_ROOT 上的注释）。 */
  function wantBatch(body) {
    const raw = typeof body.batchId === 'string' && body.batchId.trim() !== '' ? body.batchId
      : typeof body.batch === 'string' && body.batch.trim() !== '' ? body.batch
        : typeof body.dir === 'string' && body.dir.trim() !== '' ? path.basename(body.dir.trim()) : ''
    if (raw === '') return { ok: true, id: '' }
    const normalized = normalizeGrokBatchId(raw)
    if (normalized === '') return { ok: false, id: '' }
    if (normalized.toLowerCase() === LEGACY_BATCH_ID) return { ok: false, id: '', legacyAlias: true }
    // 名字恰好等于 grok-output 的目录：是个真批次目录就照常当批次用，否则认定为"旧调用方把平铺目录当 dir 传上来了"
    const rootName = path.basename(grokRoot())
    if (normalized === rootName && !existsSync(path.join(grokRoot(), normalized, 'plan.json'))) return { ok: true, id: BATCH_ROOT }
    return { ok: true, id: normalized }
  }

  /** 批次的响应形状：批次身份 + 目录 + 文件路径。dir/plan 字段名沿用旧版，调用方不用改。 */
  const grokBatchInfo = (root, batchId, dir) => ({
    batchId,
    legacy: dir === root,
    dir,
    planFile: path.join(dir, 'plan.json'),
    driverFile: path.join(dir, 'driver.md'),
    ledgerFile: path.join(dir, 'ledger.json'),
    runFile: path.join(dir, RUN_RECORD_FILE),
    root,
  })

  /** 不传参时的"最新一批"：可信索引 → 目录 mtime。索引缺失/陈旧都不影响结论。 */
  async function resolveLatestGrokBatch(root, index) {
    const scanned = scanGrokBatches(root)
    if (scanned.length === 0) return null
    const byId = new Map(scanned.map((item) => [item.batchId, item]))
    if (index && Object.keys(index).length > 0 && typeof index.latest === 'string' && byId.has(index.latest)) {
      return byId.get(index.latest)
    }
    return scanned.reduce((best, item) => (item.mtime > best.mtime ? item : best), scanned[0])
  }

  /**
   * 推导一条任务记录（**只读**：不建目录、不动 index.json、不刷 run.json）。
   * 查询路由走它，写盘路由也走它 —— 落盘与查询同一份口径，不会各自长歪。
   */
  async function deriveGrokRunRecord(batchId, dir, verify, controlOverride) {
    const plan = await readJsonOrNull(path.join(dir, 'plan.json'))
    const ledger = await readJsonOrNull(path.join(dir, 'ledger.json'))
    const stored = await readJsonOrNull(path.join(dir, RUN_RECORD_FILE))
    const control = controlOverride === undefined ? (stored === null ? null : stored.control) : controlOverride
    const disk = await collectRunDiskFacts(ledgerArtifactFiles(ledger), verify)
    const record = buildGrokRunRecord({ plan, ledger, control, disk, verify, batchId, dir, now: Date.now() })
    return { record, plan, ledger, stored }
  }

  /** 把推导出来的记录落到 `<批次目录>/run.json`（图已经躺在盘上了，这一步失败不翻转成失败）。 */
  async function refreshGrokRunRecord(batchId, dir, verify, controlOverride) {
    const { record } = await deriveGrokRunRecord(batchId, dir, verify, controlOverride)
    await fsp.writeFile(path.join(dir, RUN_RECORD_FILE), JSON.stringify(record, null, 2), 'utf8')
    return record
  }

  /** 落盘一批：新建（不传批次身份）或续做（传了 batchId/dir）。返回 { error } 表示调用方要拒掉。 */
  async function writeGrokBatch(req, res) {
    const body = JSON.parse(await readBody(req, 8 * 1024 * 1024))
    const entries = Array.isArray(body.entries) ? body.entries : []
    if (entries.length === 0) {
      sendJson(res, 400, { ok: false, error: 'entries 为空' })
      return undefined
    }
    const root = grokRoot()
    const wanted = wantBatch(body)
    if (!wanted.ok) {
      sendJson(res, 400, {
        ok: false,
        error: wanted.legacyAlias === true
          ? 'legacy 是旧版平铺布局的只读别名，不能写入；请不传 batchId 新建批次'
          : 'batchId 非法：只能是单个目录名（不含 / \\ : 与 ..）',
      })
      return undefined
    }
    let batchId = wanted.id === BATCH_ROOT ? '' : wanted.id
    let dir = ''
    if (batchId !== '') {
      // 续做/重试：写回调用方指定的那一批，不新建、不改名。
      dir = path.join(root, batchId)
    } else {
      // 调用方没指定批次（或只给了平铺目录）：新建一个独立批次目录。
      const fresh = resolveUniqueGrokBatch(root, slugify(body.slug || (body.source && body.source.file) || 'grok', 'grok'))
      batchId = fresh.batchId
      dir = fresh.dir
    }
    // 传进来的批次身份经 normalize 后只剩单个路径段，这里再兜一道 403（与其它路由同一口径）。
    if (!allowAny(dir)) {
      sendJson(res, 403, { ok: false, error: '批次目录越界' })
      return undefined
    }
    await fsp.mkdir(dir, { recursive: true })
    // 来源文本（小说正文/章纲）跟着批次落盘：几万字不进对话上下文，agent 按路径去读。
    let sourceFile = ''
    let sourceChars = 0
    const sourceText = body.source && typeof body.source.text === 'string' ? body.source.text.trim() : ''
    if (sourceText !== '') {
      if (Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_BYTES) {
        sendJson(res, 413, { ok: false, error: '来源文本过大（上限 ' + Math.round(MAX_SOURCE_BYTES / 1024 / 1024) + ' MB）' })
        return undefined
      }
      const label = slugify(body.source && body.source.file ? body.source.file : 'novel', 'novel')
      sourceFile = path.join(dir, `source-${label}.md`)
      await fsp.writeFile(sourceFile, sourceText, 'utf8')
      sourceChars = sourceText.length
    }
    const options = sanitizeGrokOptions(body.options)
    // 每批一个新 nonce：写进 plan.json（宿主重启后仍能校验）、回给调用方、进 driver.md 与面板派发请求。
    // 重发同一批次（PUT/POST 带 batchId）会换新 nonce ⇒ 旧的那把立刻作废。
    const saveNonce = issueGrokBatchNonce(batchId)
    const plan = {
      createdAt: new Date().toISOString(),
      batchId,
      saveNonce,
      grokUrl: typeof body.grokUrl === 'string' && body.grokUrl !== '' ? body.grokUrl : 'https://grok.com/',
      dir,
      count: entries.length,
      ...(typeof body.processDir === 'string' && body.processDir !== '' ? { processDir: body.processDir.slice(0, 300) } : {}),
      ...(options === undefined ? {} : { options }),
      ...(sourceFile === '' ? {} : { sourceFile, sourceChars }),
      entries: entries.map((entry, index) => ({
        index: Number(entry.index) || index + 1,
        title: String(entry.title || '').slice(0, 120),
        prompt: String(entry.prompt || ''),
        slug: String(entry.slug || 'prompt').slice(0, 48),
        source: String(entry.source || ''),
        chars: String(entry.prompt || '').length,
      })),
    }
    await fsp.writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8')
    await fsp.writeFile(path.join(dir, 'driver.md'), driverDoc(plan), 'utf8')
    await touchGrokIndex(root, batchId)
    // 任务记录跟着批次一起落盘：建批次那一刻就该有一条记录（此刻还没图 ⇒ pending / 待派发）。
    // 续做已有批次（调用方给了批次身份）时登记一次 begin —— 那正是"续跑"这件事本身：
    // 写回同一目录、换新 nonce，并解掉可能存在的取消标记（历史里留一条 resume，谁解的、何时有据可查）。
    let record = null
    try {
      const previous = await readJsonOrNull(path.join(dir, RUN_RECORD_FILE))
      let control = previous === null ? null : previous.control
      if (wanted.id !== '' && wanted.id !== BATCH_ROOT) {
        const applied = applyRunControl(control, 'begin', {
          at: new Date().toISOString(),
          by: 'plan-reissue',
          reason: '重发同一批次（续跑 / 重试这一批）',
        })
        if (applied.error === undefined) control = applied.control
      }
      record = await refreshGrokRunRecord(batchId, dir, 'stat', control)
    } catch (err) {
      // 记录是推导件（源在 plan.json + ledger.json + 盘上事实），写不进去不影响这一批本身。
      console.warn('[dsh-video-prompt] run.json 未能落盘（查询路由会按 plan/ledger 重算）：' + String((err && err.message) || err))
    }
    sendJson(res, 200, {
      ok: true,
      ...grokBatchInfo(root, batchId, dir),
      count: plan.count,
      // nonce 交给调用方（面板 → 派发请求 → 会话里的 agent → 页面内 POST 时带上）。
      // 它只在这条批次通道里有效，不是账号凭据；但除本响应与批次 plan.json 外不再另发一份。
      saveNonce,
      ...(options === undefined ? {} : { options }),
      ...(sourceFile === '' ? {} : { sourceFile, sourceChars }),
      ...(record === null ? {} : { record }),
    })
    return undefined
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/grok/plan',
    handler: async (req, res) => {
      try {
        const root = grokRoot()
        if (req.method === 'GET') {
          const requested = normalizeGrokBatchId(query(req.url, 'batch'))
          if (query(req.url, 'batch') !== '' && requested === '') {
            sendJson(res, 400, { ok: false, error: 'batch 非法（只能是单个目录名）' })
            return
          }
          const index = await readGrokIndex(root)
          let picked
          if (requested !== '') {
            picked = requested.toLowerCase() === LEGACY_BATCH_ID
              ? (existsSync(path.join(root, 'plan.json')) ? { batchId: LEGACY_BATCH_ID, legacy: true, mtime: mtimeOf(path.join(root, 'plan.json')) } : null)
              : scanGrokBatches(root).find((item) => item.batchId === requested) || null
          } else {
            picked = await resolveLatestGrokBatch(root, index)
          }
          if (picked === null || picked === undefined) {
            sendJson(res, 200, { ok: true, plan: null, dir: root, batchId: '', batches: [] })
            return
          }
          const info = grokBatchInfo(root, picked.batchId, picked.legacy ? root : path.join(root, picked.batchId))
          const planFile = path.join(info.dir, 'plan.json')
          if (!existsSync(planFile)) {
            sendJson(res, 200, { ok: true, plan: null, ...info, batches: [] })
            return
          }
          const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'))
          // nonce 只沿"派发"那条线走（POST/PUT 响应 → 会话 → 页面内 POST）：GET 是跨源读得到的
          // 只读端点，把 nonce 放在这里等于让任意网页读它 —— 那 nonce 就白加了。
          if (plan !== null && typeof plan === 'object') delete plan.saveNonce
          const batches = scanGrokBatches(root).sort((a, b) => b.mtime - a.mtime).map((item) => item.batchId)
          // 顺手带上任务记录（stat 级，不逐项重算哈希）：面板读一次就能看到状态/当前步骤/还差几项。
          // 只读 —— 这里**不**写 run.json，也不碰 index.json。
          const runRecord = (await deriveGrokRunRecord(picked.batchId, info.dir, 'stat')).record
          sendJson(res, 200, { ok: true, ...info, plan, batches, record: runRecord })
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          await writeGrokBatch(req, res)
          return
        }
        sendJson(res, 405, { ok: false, error: '方法不允许' })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/grok/save',
    handler: async (req, res) => {
      // 浏览器页面上下文与宿主之间的字节直传通道。响应体**只有元信息**
      // （路径/字节数/哈希/宽高/状态），图片内容任何形态（含 base64）都不经会话文本：
      // 1 MiB 图 ≈ 140 万字符 base64，既爆上下文又会被工具结果上限截坏。
      // 这一条路由必须回 CORS（不放，页面内直传就读不回元信息，agent 只能把字节搬回会话来 POST
      // —— 正是要防的绕行），但不再是 `*`：**只回显白名单内请求自己的 Origin**，白名单外的源
      // 连响应都读不到（写操作另有 nonce 门，见文件上方「三道门」注释）。
      //
      // 响应头口径（三道门的可见结果，tools/verify-grok-bytes.mjs 逐条断言）：
      //   * 白名单外的源 ⇒ 403 且**一个 CORS 头都不回**（跨源 JS 连错误信息都读不到）；
      //   * 白名单内的源但 nonce 错/缺 ⇒ 403，仍回 CORS 头 —— 让页面能读到"nonce 不对"这句话
      //     （不这么做，agent 只能看到一句 "Failed to fetch"，分不清是路由不通还是被拒），
      //     no-CORS 的伪造请求则因拿不到 nonce 而永远写不进任何字节。
      const cors = grokSaveCorsHeaders(req.headers.origin)
      const deny = (status, message, headers) => sendJson(res, status, { ok: false, error: message }, headers)
      try {
        if (Object.keys(cors).length === 0) {
          deny(403, '来源未被允许：/dvp/grok/save 只接受白名单内的页面来源（' + GROK_SAVE_ALLOWED_ORIGINS.join(' / ') + ' 及其子域）')
          return
        }
        if (req.method === 'OPTIONS') {
          // 预检：把 X-DVP-Nonce 也放进 Allow-Headers（否则非简单请求的预检会被浏览器拦掉）。
          res.writeHead(204, {
            ...cors,
            'Access-Control-Allow-Headers': GROK_SAVE_ALLOWED_HEADERS,
            'Access-Control-Max-Age': '600',
            'Content-Length': '0',
          })
          res.end()
          return
        }
        if (req.method !== 'POST') {
          deny(405, '方法不允许', cors)
          return
        }
        const contentType = String(req.headers['content-type'] || '').toLowerCase()
        const isJson = contentType.includes('application/json')
        const root = grokRoot()
        let body = {}
        let bytes = null
        let source = ''
        if (isJson) {
          // 旧口径：JSON { base64 | url }，保留给宿主侧工具与既有调用方。
          // 会话里的首选已改成下面的 raw bytes —— 别再让 agent 拼 base64 JSON。
          body = JSON.parse(await readBody(req, 48 * 1024 * 1024))
          if (typeof body.base64 === 'string' && body.base64 !== '') {
            bytes = Buffer.from(body.base64.replace(/^data:[^,]+,/, ''), 'base64')
            source = 'inline-base64'
          } else if (typeof body.url === 'string' && /^https?:\/\//i.test(body.url)) {
            const response = await fetch(body.url)
            if (!response.ok) {
              deny(502, '下载失败 HTTP ' + response.status, cors)
              return
            }
            bytes = Buffer.from(await response.arrayBuffer())
            const responseContentType = response.headers.get('content-type') || ''
            if (responseContentType.includes('webp')) body.ext = '.webp'
            else if (responseContentType.includes('jpeg')) body.ext = '.jpg'
            else if (responseContentType.includes('png')) body.ext = '.png'
            source = body.url
          } else {
            deny(400, '需要 base64 或 url；或把图片字节原样作请求体走 raw 模式（批次/序号/slug 放 URL 参数 ?batch=&index=&slug=）', cors)
            return
          }
        } else {
          // raw bytes 模式（首选）：请求体就是图片字节本身（页面内 fetch 成图的 arrayBuffer
          // 原样 POST），标识走 URL 参数：/dvp/grok/save?batch=<batchId>&index=<序号>&slug=<slug>&ext=.jpg
          // 字节全程 浏览器 → 宿主，不进会话文本。
          body = {
            batchId: query(req.url, 'batch'),
            index: query(req.url, 'index'),
            slug: query(req.url, 'slug'),
            ext: query(req.url, 'ext'),
            note: query(req.url, 'note'),
          }
          bytes = await readRaw(req, 48 * 1024 * 1024)
          source = 'raw-bytes'
          if (bytes.length === 0) {
            deny(400, '请求体为空：raw 模式要把图片字节原样放进请求体（生成中取到的占位图就是 0 字节，等流式收尾再取）', cors)
            return
          }
          if (typeof body.ext !== 'string' || body.ext === '') {
            if (contentType.includes('webp')) body.ext = '.webp'
            else if (contentType.includes('jpeg') || contentType.includes('jpg')) body.ext = '.jpg'
            else if (contentType.includes('png')) body.ext = '.png'
            else if (contentType.includes('gif')) body.ext = '.gif'
          }
        }
        if (source === 'inline-base64') {
          const mimeMatch = /^data:([^;,]+)/.exec(body.base64)
          if (mimeMatch) {
            const mime = mimeMatch[1]
            if (mime.includes('webp')) body.ext = '.webp'
            else if (mime.includes('jpeg') || mime.includes('jpg')) body.ext = '.jpg'
            else if (mime.includes('png')) body.ext = '.png'
          }
        }
        // 图的去处必须跟着批次走：传了 batchId 就进那一批；没传就进最新一批（没有批次才新建），
        // 绝不退回 grok-output 根目录 —— 那正是"新批次盖掉旧批次图"的老毛病。
        const wanted = wantBatch(body)
        if (!wanted.ok) {
          deny(400, wanted.legacyAlias === true
            ? 'legacy 是旧版平铺布局的只读别名，不能写入；请传具体 batchId'
            : 'batchId 非法：只能是单个目录名（不含 / \\ : 与 ..）', cors)
          return
        }
        let batchId = wanted.id === BATCH_ROOT ? '' : wanted.id
        let dir = ''
        if (batchId !== '') {
          dir = path.join(root, batchId)
          // 存图是"往已有批次里放结果"：批次得先存在。批次 ID 写错时宁可 404，
          // 也不要凭空建一个只有图片、没有 plan.json 的孤儿目录。
          if (!existsSync(dir)) {
            deny(404, '批次不存在：' + batchId + '（先用 /dvp/grok/plan 建批次）', cors)
            return
          }
        } else {
          const latest = await resolveLatestGrokBatch(root, await readGrokIndex(root))
          if (latest !== null && !latest.legacy) {
            batchId = latest.batchId
            dir = path.join(root, batchId)
          } else {
            // 没有批次就现建一个（保持"直接调 save 也能用"的老行为），但落进自己的子目录。
            const fresh = resolveUniqueGrokBatch(root, 'grok')
            batchId = fresh.batchId
            dir = fresh.dir
          }
        }
        if (!allowAny(dir)) {
          deny(403, '批次目录越界', cors)
          return
        }
        // ── 门②：batch nonce。缺/错一律 403，且**在 mkdir 之前**判 —— 被拒的请求不在盘上留痕迹。
        if (grokSaveNonceRequired()) {
          const provided = String(
            (isJson && typeof body.nonce === 'string' ? body.nonce : '')
            || query(req.url, 'nonce')
            || req.headers[GROK_SAVE_NONCE_HEADER]
            || '',
          ).trim()
          const expected = await expectedGrokSaveNonce(batchId, async () => {
            try {
              const parsed = JSON.parse(await fsp.readFile(path.join(root, batchId, 'plan.json'), 'utf8'))
              return parsed && typeof parsed.saveNonce === 'string' ? parsed.saveNonce : ''
            } catch {
              return '' // 没有 plan.json（批次刚现建）⇒ 只能靠内存台账
            }
          })
          if (!grokSaveNonceEquals(expected, provided)) {
            deny(403, expected === ''
              // 内存台账与 plan.json 都没有这个批次的 nonce（宿主刚重启、批次目录里也没记着）：
              // 不放行，给一句能照着做的错误。
              ? 'nonce 无法校验：先 POST /dvp/grok/plan 建批次（或续做该批次）拿 saveNonce'
              : provided === ''
                ? '缺少 nonce：存图必须带本批次的 saveNonce（?nonce= 或请求头 X-DVP-Nonce，见该批次 driver.md / plan.json）'
                : 'nonce 不正确：它不是本批次当前有效的 saveNonce（重新建批次会换新 nonce）', cors)
            return
          }
        }
        // ── 门③：魔术字节。只认魔数（PNG/JPEG/GIF/WebP），不认扩展名 —— raw 模式下页面直传的
        // content-type 常常是 application/octet-stream，扩展名也常常是默认的 .png。
        // 拦的是"把别的载荷当图写进批次目录"，不是鉴权（鉴权在门②）。
        const signature = imageFileSignature(bytes)
        if (signature === '') {
          deny(415, '不是图片字节：只接受 PNG/JPEG/GIF/WebP（按魔数判断，不看扩展名与 content-type）；'
            + '请求体前 16 字节是 ' + bytes.subarray(0, 16).toString('hex'), cors)
          return
        }
        await fsp.mkdir(dir, { recursive: true })
        const index = Number(body.index) || 1
        const slug = String(body.slug || 'prompt').replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]+/g, '-').slice(0, 48) || 'prompt'
        let ext = typeof body.ext === 'string' && /^\.[a-z0-9]{2,5}$/i.test(body.ext) ? body.ext.toLowerCase() : '.png'
        const file = path.join(dir, String(index).padStart(2, '0') + '-' + slug + ext)
        await fsp.writeFile(file, bytes)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const dims = imageSize(bytes)
        // 账本就写在批次目录里：一批一本账，条目里的 file 绝对路径直接指回本批产物，
        // 账本与产物不可能再分家（旧版账本在 grok-output 根下跨批次累加，才对不上）。
        const ledgerFile = path.join(dir, 'ledger.json')
        let ledger = { items: [], updatedAt: '' }
        try {
          ledger = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'))
        } catch {
          ledger = { items: [], updatedAt: '' }
        }
        ledger.batchId = batchId
        ledger.dir = dir
        ledger.items.push({
          at: new Date().toISOString(),
          index,
          slug,
          file,
          bytes: bytes.length,
          sha256,
          source,
          // 魔数认出来的真实封装（.png/.jpg/.gif/.webp）。只记账、**不改**调用方给的 ext：
          // 改扩展名会动到落盘文件名，而文件名是调用方与账本对齐的锚点（旧调用方还可能给 .jpeg 这类等价写法）。
          signature,
          note: typeof body.note === 'string' ? body.note.slice(0, 300) : '',
        })
        ledger.updatedAt = new Date().toISOString()
        await fsp.writeFile(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8')
        await touchGrokIndex(root, batchId)
        // 任务记录跟着刷一次（stat 级：刚落的这张已知哈希，不必再把整批读一遍）。
        // 落盘失败不翻转成失败：图已经躺在盘上了，而记录可由 plan/ledger 重算。
        let runRecord = null
        try {
          runRecord = await refreshGrokRunRecord(batchId, dir, 'stat')
        } catch (err) {
          console.warn('[dsh-video-prompt] run.json 未能刷新（查询路由会按 plan/ledger 重算）：' + String((err && err.message) || err))
        }
        // 回给会话的全部家当就是这一小段元信息 —— 字节本身已经躺在盘上。
        sendJson(res, 200, {
          ok: true,
          status: 'saved',
          batchId,
          file,
          bytes: bytes.length,
          sha256,
          width: dims.width,
          height: dims.height,
          dir,
          ledger: ledgerFile,
          // 记录侧的进度（status 已被占用为 "saved"，这里另起名，不动老字段）。
          run: path.join(dir, RUN_RECORD_FILE),
          ...(runRecord === null ? {} : { runStatus: runRecord.status, remaining: runRecord.failures.length }),
        }, cors)
      } catch (err) {
        deny(500, String((err && err.message) || err), cors)
      }
    },
  }))

  // ---- ⑨b 统一任务记录：一条记录 = 一个批次（查询只读 · 状态登记才写）----
  //
  // 查询（GET）**不写任何文件**：不建目录、不动 index.json、不刷 run.json、不碰 plan/ledger/产物 ——
  // 断言里对该批目录整棵树做 sha256 前后比对（tools/verify-grok-bytes.mjs 第 5 节）。
  // 需要落盘的那一份 run.json 由写盘路径维护（建批次 / 存图 / 下面的 POST 登记），查询只推导不落盘。
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/grok/run',
    handler: async (req, res) => {
      try {
        const root = grokRoot()
        if (req.method === 'GET') {
          const raw = query(req.url, 'batch')
          const requested = normalizeGrokBatchId(raw)
          if (raw !== '' && requested === '') {
            sendJson(res, 400, { ok: false, error: 'batch 非法（只能是单个目录名）' })
            return
          }
          // 默认 sha256 档（逐项重算哈希，能抓出"文件被改过"）；列表与轮询场景可以显式要 stat 档。
          const verify = query(req.url, 'verify') === 'stat' ? 'stat' : 'sha256'
          let picked = null
          if (requested !== '') {
            if (requested.toLowerCase() === LEGACY_BATCH_ID) {
              picked = existsSync(path.join(root, 'plan.json'))
                ? { batchId: LEGACY_BATCH_ID, legacy: true, dir: root }
                : null
            } else {
              // 显式点名一个批次目录：只要目录在就给记录 —— plan.json 丢了也还能按账本看（warnings 里写明）。
              const dir = path.join(root, requested)
              picked = existsSync(dir) ? { batchId: requested, legacy: false, dir } : null
            }
          } else {
            const latest = await resolveLatestGrokBatch(root, await readGrokIndex(root))
            picked = latest === null
              ? null
              : {
                batchId: latest.batchId,
                legacy: latest.legacy === true,
                dir: latest.legacy === true ? root : path.join(root, latest.batchId),
              }
          }
          if (picked === null) {
            sendJson(res, 404, { ok: false, error: '批次不存在：' + (requested === '' ? '（当前没有批次）' : requested) })
            return
          }
          if (!allowAny(picked.dir)) {
            sendJson(res, 403, { ok: false, error: '批次目录越界' })
            return
          }
          const { record, plan, stored } = await deriveGrokRunRecord(picked.batchId, picked.dir, verify)
          const payload = {
            ok: true,
            ...record,
            legacy: picked.legacy === true,
            // 'run.json' = 盘上有落过的那一份（写盘时是 stat 档）；'derived' = 只有源文件，本响应现算（旧批次就走这条）。
            source: stored === null ? 'derived' : 'run.json',
            at: new Date().toISOString(),
          }
          if (query(req.url, 'driver') !== '') payload.retryDriver = runRetryDriverDoc(record, plan)
          sendJson(res, 200, payload)
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 64 * 1024))
          const wanted = wantBatch(body)
          if (!wanted.ok) {
            sendJson(res, 400, {
              ok: false,
              error: wanted.legacyAlias === true
                ? 'legacy 是旧版平铺布局的只读别名，不能登记状态；请对具体 batchId 操作'
                : 'batchId 非法：只能是单个目录名（不含 / \\ : 与 ..）',
            })
            return
          }
          if (wanted.id === '' || wanted.id === BATCH_ROOT) {
            sendJson(res, 400, { ok: false, error: '需要 batchId：状态登记只针对一个具体批次' })
            return
          }
          const dir = path.join(root, wanted.id)
          // "批次"的定义与 plan 路由同一口径：目录里有 plan.json 才算（免得往 grok-output 下的
          // 别的目录里顺手写一份 run.json）。
          if (!existsSync(path.join(dir, 'plan.json'))) {
            sendJson(res, 404, { ok: false, error: '批次不存在：' + wanted.id + '（先用 /dvp/grok/plan 建批次）' })
            return
          }
          if (!allowAny(dir)) {
            sendJson(res, 403, { ok: false, error: '批次目录越界' })
            return
          }
          const previous = await readJsonOrNull(path.join(dir, RUN_RECORD_FILE))
          const applied = applyRunControl(previous === null ? null : previous.control, body.action, { by: body.by, reason: body.reason })
          if (applied.error !== undefined) {
            sendJson(res, 400, { ok: false, error: applied.error })
            return
          }
          // 只动 run.json 的 control 那一段：plan.json / ledger.json / 成图一个字节都不碰。
          const record = await refreshGrokRunRecord(wanted.id, dir, 'stat', applied.control)
          sendJson(res, 200, { ok: true, action: applied.action, ...record, source: 'run.json', at: new Date().toISOString() })
          return
        }
        sendJson(res, 405, { ok: false, error: '方法不允许' })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // 最近若干批：给"任务记录列表"用。stat 档（不逐项算哈希）—— 列表只回答"哪批什么状态、还差几项"。
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/grok/runs',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        const root = grokRoot()
        const wanted = Number(query(req.url, 'limit'))
        const limit = Number.isFinite(wanted) && wanted > 0
          ? Math.min(RUN_LIST_MAX, Math.floor(wanted))
          : RUN_LIST_LIMIT
        const scanned = scanGrokBatches(root).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
        const batches = []
        for (const item of scanned) {
          const dir = item.legacy === true ? root : path.join(root, item.batchId)
          if (!allowAny(dir)) continue
          const { record } = await deriveGrokRunRecord(item.batchId, dir, 'stat')
          batches.push({
            runId: record.runId,
            batchId: item.batchId,
            legacy: item.legacy === true,
            dir,
            status: record.status,
            step: record.step,
            counts: record.counts,
            // 失败项条数 = "仅重试失败项"要重跑多少条（`GET /dvp/grok/run?batch=<id>&driver=1` 拿清单）。
            retryCount: record.failures.length,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })
        }
        sendJson(res, 200, { ok: true, root, verify: 'stat', limit, count: batches.length, batches })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  // ---- ⑩ 技能注册 ----
  // 抽成 registerSkillPack()：开机注册与 /dvp/skills/reload 共用同一份扫描+注册逻辑。
  // 注意 dsh-skill 的 runtime 注册对**同名**是 first-wins（重复注册只告警不覆盖），
  // 所以 reload 只能让"上次开机之后新增的技能目录"免重启生效；改已有技能正文仍要重启。
  async function registerSkillPack() {
    const names = []
    const skillsServiceNow = ctx.get('skills')
    if (skillsServiceNow === undefined) return names
    let skills = []
    try {
      skills = await loadSkills(SKILLS_ROOT)
    } catch (err) {
      console.warn('[dsh-video-prompt] 技能包读取失败：' + String((err && err.message) || err))
      return names
    }
    for (const skill of skills) {
      try {
        const dispose = skillsServiceNow.register({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
          content: skill.contentRange,
          source: 'custom',
          provider: 'dsh-video-prompt',
          invocation: { modelInvocable: true, userInvocable: true },
          resourceBase: skill.resourceBase,
          path: path.join(skill.dir, 'SKILL.md'),
        })
        disposers.push(dispose)
        names.push(skill.name)
      } catch (err) {
        console.warn(`[dsh-video-prompt] 技能 ${skill.name} 注册失败：` + String((err && err.message) || err))
      }
    }
    return names
  }

  let registered = []
  if (config.registerSkills) {
    registered = await registerSkillPack()
    if (registered.length === 0 && ctx.get('skills') === undefined) {
      console.warn('[dsh-video-prompt] skills 服务不可用，技能包未注册')
    }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/skills/reload',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST' && req.method !== 'PUT') {
          sendJson(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        if (ctx.get('skills') === undefined) {
          sendJson(res, 503, { ok: false, error: 'skills 服务不可用' })
          return
        }
        const before = new Set((await currentSkills()).map((s) => s.name))
        const names = await registerSkillPack()
        const after = new Set((await currentSkills()).map((s) => s.name))
        sendJson(res, 200, {
          ok: true,
          added: names.filter((n) => !before.has(n) && after.has(n)),
          alreadyRegistered: names.filter((n) => before.has(n)),
          note: '同名技能是 first-wins：改已有技能的正文要重启桌面端才会换新',
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }))

  async function currentSkills() {
    const skillsServiceNow = ctx.get('skills')
    if (skillsServiceNow === undefined) return []
    try {
      const list = await skillsServiceNow.list({})
      return list.filter((s) => s.provider === 'dsh-video-prompt')
    } catch {
      return []
    }
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载顺序无关紧要，逐个吞掉即可
      }
    }
  })

  console.log(
    '[dsh-video-prompt] 宿主就绪 · 路由 /dvp/* · 技能 ' + (registered.length ? registered.join(', ') : '未注册')
    + ' · mediaRoot=' + mediaRoot() + ' · runsRoot=' + runsRoot(),
  )
}
