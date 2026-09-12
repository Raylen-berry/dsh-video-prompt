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
//        POST /dvp/grok/save                 保存抓到的成图字节
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

import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
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

// ── Grok 驱动清单（写给人看，也写给会话里的 agent 看）────────────────────────

function driverDoc(plan) {
  const lines = []
  lines.push('# Grok 出图驱动清单')
  lines.push('')
  lines.push('- 生成时间：' + plan.createdAt)
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
  lines.push('4. 每拿到一张图，调 `POST /dvp/grok/save`（base64 或图片 URL + index/slug）落盘。')
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

// ── 路径围栏 ────────────────────────────────────────────────────────────────

function within(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
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

export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const persisted = await readState()
  const mediaRoot = path.resolve(persisted.mediaRoot || config.mediaRoot)
  const runsRoot = path.resolve(persisted.runsRoot || config.runsRoot)
  const allowedRoots = [mediaRoot, runsRoot, path.resolve(process.cwd())]

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
        const raw = query(req.url, 'path') || mediaRoot
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
            defaults: { mediaRoot, runsRoot },
            skills: (await currentSkills()).map((s) => s.name),
          })
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const patch = JSON.parse(await readBody(req))
          const grokOptions = sanitizeGrokOptions(patch.grokOptions)
          const pipelineMode = sanitizePipelineMode(patch.pipelineMode)
          const next = await writeState({
            mediaRoot: typeof patch.mediaRoot === 'string' ? resolveRoot(patch.mediaRoot, path.join(stateDir(), 'media')) : undefined,
            runsRoot: typeof patch.runsRoot === 'string' ? resolveRoot(patch.runsRoot, path.join(stateDir(), 'runs')) : undefined,
            ...(grokOptions === undefined ? {} : { grokOptions }),
            ...(pipelineMode === undefined ? {} : { pipelineMode }),
          })
          if (next.mediaRoot && !allowedRoots.includes(next.mediaRoot)) allowedRoots.push(next.mediaRoot)
          if (next.runsRoot && !allowedRoots.includes(next.runsRoot)) allowedRoots.push(next.runsRoot)
          sendJson(res, 200, { ok: true, state: next })
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
          const runs = Array.isArray(body.runs) ? body.runs.slice(-100) : merged.runs
          sendJson(res, 200, { ok: true, ...(await writeManifest(dir, { items, runs, updatedAt: new Date().toISOString() })) })
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
        const runDir = resolveUniqueDir(runsRoot, localStampMinute() + '-' + slug)
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
        const dir = path.join(runsRoot, 'source')
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
        const root = path.join(runsRoot, 'process')
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
  const grokDir = () => path.join(mediaRoot, 'grok-output')

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dvp/grok/plan',
    handler: async (req, res) => {
      try {
        const dir = grokDir()
        if (req.method === 'GET') {
          if (!existsSync(path.join(dir, 'plan.json'))) {
            sendJson(res, 200, { ok: true, plan: null, dir })
            return
          }
          sendJson(res, 200, { ok: true, dir, plan: JSON.parse(await fsp.readFile(path.join(dir, 'plan.json'), 'utf8')) })
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = JSON.parse(await readBody(req, 8 * 1024 * 1024))
          const entries = Array.isArray(body.entries) ? body.entries : []
          if (entries.length === 0) {
            sendJson(res, 400, { ok: false, error: 'entries 为空' })
            return
          }
          await fsp.mkdir(dir, { recursive: true })
          // 来源文本（小说正文/章纲）跟着批次落盘：几万字不进对话上下文，agent 按路径去读。
          let sourceFile = ''
          let sourceChars = 0
          const sourceText = body.source && typeof body.source.text === 'string' ? body.source.text.trim() : ''
          if (sourceText !== '') {
            if (Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_BYTES) {
              sendJson(res, 413, { ok: false, error: '来源文本过大（上限 ' + Math.round(MAX_SOURCE_BYTES / 1024 / 1024) + ' MB）' })
              return
            }
            const label = slugify(body.source && body.source.file ? body.source.file : 'novel', 'novel')
            sourceFile = path.join(dir, `source-${label}.md`)
            await fsp.writeFile(sourceFile, sourceText, 'utf8')
            sourceChars = sourceText.length
          }
          const options = sanitizeGrokOptions(body.options)
          const plan = {
            createdAt: new Date().toISOString(),
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
          sendJson(res, 200, {
            ok: true,
            dir,
            count: plan.count,
            planFile: path.join(dir, 'plan.json'),
            driverFile: path.join(dir, 'driver.md'),
            ...(options === undefined ? {} : { options }),
            ...(sourceFile === '' ? {} : { sourceFile, sourceChars }),
          })
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
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '方法不允许' })
          return
        }
        const body = JSON.parse(await readBody(req, 48 * 1024 * 1024))
        const dir = grokDir()
        await fsp.mkdir(dir, { recursive: true })
        const index = Number(body.index) || 1
        const slug = String(body.slug || 'prompt').replace(/[^A-Za-z0-9._\u4e00-\u9fa5-]+/g, '-').slice(0, 48) || 'prompt'
        let ext = typeof body.ext === 'string' && /^\.[a-z0-9]{2,5}$/i.test(body.ext) ? body.ext.toLowerCase() : '.png'
        let bytes
        if (typeof body.base64 === 'string' && body.base64 !== '') {
          bytes = Buffer.from(body.base64.replace(/^data:[^,]+,/, ''), 'base64')
          const mimeMatch = /^data:([^;,]+)/.exec(body.base64)
          if (mimeMatch) {
            const mime = mimeMatch[1]
            if (mime.includes('webp')) ext = '.webp'
            else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg'
            else if (mime.includes('png')) ext = '.png'
          }
        } else if (typeof body.url === 'string' && /^https?:\/\//i.test(body.url)) {
          const response = await fetch(body.url)
          if (!response.ok) {
            sendJson(res, 502, { ok: false, error: '下载失败 HTTP ' + response.status })
            return
          }
          bytes = Buffer.from(await response.arrayBuffer())
          const contentType = response.headers.get('content-type') || ''
          if (contentType.includes('webp')) ext = '.webp'
          else if (contentType.includes('jpeg')) ext = '.jpg'
          else if (contentType.includes('png')) ext = '.png'
        } else {
          sendJson(res, 400, { ok: false, error: '需要 base64 或 url' })
          return
        }
        const file = path.join(dir, String(index).padStart(2, '0') + '-' + slug + ext)
        await fsp.writeFile(file, bytes)
        const ledgerFile = path.join(dir, 'ledger.json')
        let ledger = { items: [], updatedAt: '' }
        try {
          ledger = JSON.parse(await fsp.readFile(ledgerFile, 'utf8'))
        } catch {
          ledger = { items: [], updatedAt: '' }
        }
        ledger.items.push({
          at: new Date().toISOString(),
          index,
          slug,
          file,
          bytes: bytes.length,
          source: typeof body.url === 'string' ? body.url : 'inline-base64',
          note: typeof body.note === 'string' ? body.note.slice(0, 300) : '',
        })
        ledger.updatedAt = new Date().toISOString()
        await fsp.writeFile(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8')
        sendJson(res, 200, { ok: true, file, bytes: bytes.length, dir, ledger: ledgerFile })
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
    + ' · mediaRoot=' + mediaRoot + ' · runsRoot=' + runsRoot,
  )
}
