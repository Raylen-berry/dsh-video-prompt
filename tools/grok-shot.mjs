// ============================================================================
// dsh-video-prompt · Grok 出图副驾
//
//   node tools/grok-shot.mjs --prompts-file <path.md> [--out <dir>] [--limit N] [--batch <batchId>]
//   node tools/grok-shot.mjs --prompt "单条提示词" --out <dir>
//   node tools/grok-shot.mjs --prompts-file <path.md> --print-grok-doc
//
//   --batch：本批目录（宿主上一轮已改成每批一个 grok-output/<batchId>/）。
//   给了就把 plan.json 写进 <out>/<batchId>/，配方里的取图/兜底命令也都指向该批次目录；
//   不给则维持 <out>/plan.json 的本地批法（宿主侧路由不受影响，它自己管批次）。
//
// 这个脚本**不打开浏览器**：它把「要往 Grok 投什么、投完的图落哪」这件事
// 变成可复现的批次（plan.json + 落盘 + 复盘报告）。真正把提示词打进 Grok 的是
// DSH 的浏览器插件（browser_open / browser_type / browser_click），
// 因为只有它持有用户的 Edge 登录态、拟人输入与观察窗。
//
// 分工：
//   grok-shot.mjs  —— 解析提示词、生成投喂批次、保存图片字节、写报告
//   浏览器插件      —— 打开 grok.com、把提示词贴进输入框、点发送、等出图
//
// 每张图的完整链路：
//   提示词 → 批次条目 → 浏览器插件投喂 Grok → 页面内 fetch 成字节 → 原样 POST 宿主
//          /dvp/grok/save（raw bytes）→ 落到 <批次目录>/<序号>-<slug>.png → 会话只收
//          {file,bytes,sha256,width,height,status} 元信息 → 报告里记录来源与耗时
//
// 已知边界（诚实写在这里，避免假装全自动无人值守）：
//   * Grok 未登录 / 要求人机验证 / 触达额度上限时，脚本无法替代人，必须停下来叫人。
//   * 生成是异步的，站点改版会改变选择器；提示词里带 --sel-* 覆盖项留给现场调。
//   * 自动化操作第三方站点可能违反其服务条款并有风控风险，只在你自己的账号上小批量跑。
// ============================================================================

import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
// 与宿主同一份图片宽高清道器：落盘元信息（saveImage）与宿主路由响应保持同一口径。
import { imageSize } from '../index.js'

const DEFAULT_GROK_URL = 'https://grok.com/'

function parseArgs(argv) {
  const args = { limit: 0, out: '', promptsFile: '', prompt: '', url: DEFAULT_GROK_URL, printGrokDoc: false, batch: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--prompts-file') { args.promptsFile = next; i += 1; continue }
    if (token === '--prompt') { args.prompt = next; i += 1; continue }
    if (token === '--out') { args.out = next; i += 1; continue }
    if (token === '--limit') { args.limit = Number(next) || 0; i += 1; continue }
    if (token === '--url') { args.url = next; i += 1; continue }
    if (token === '--batch') { args.batch = next; i += 1; continue }
    if (token === '--print-grok-doc') { args.printGrokDoc = true; continue }
  }
  return args
}

function slugify(text, max = 48) {
  const cleaned = String(text)
    .replace(/[`*_>#\[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
  const sliced = cleaned.slice(0, max).replace(/^-+|-+$/g, '')
  return sliced === '' ? 'prompt' : sliced
}

/** 段落标题要排除的伪块：文档前言、全局风格/人物锚点、脚注说明。 */
const ANCHOR_TITLE = /^(人物一致性|全局风格|风格锚点|一致性锚点|用途|来源视频|帧来源|正文外|说明|备注|提示)/
/** 太短的段落不是可投喂的提示词（锚点句、单行说明）。真实提示词都远超这个长度。 */
const MIN_PROMPT_CHARS = 40

/**
 * 按 `## 标题` / `### 标题` 切块，并剔除前言、锚点段与脚注。
 *
 * 早期版本把第一个标题之前的所有行都当成一条提示词，于是"文档标题 + 风格锚点"
 * 会被当成两条真提示词投进批次（实测：4 张图解析出 5 条，头一条是文件标题）。
 */
export function splitPrompts(text) {
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  let current = null
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.*\S)\s*$/.exec(line)
    if (heading !== null) {
      if (current !== null && current.body.join('\n').trim() !== '') blocks.push(current)
      current = { title: heading[2].replace(/^\d+[.、)]\s*/, '').trim(), body: [] }
      continue
    }
    // 第一个标题之前的行是文档前言，直接丢弃
    if (current === null) continue
    current.body.push(line)
  }
  if (current !== null && current.body.join('\n').trim() !== '') blocks.push(current)

  return blocks
    .map((block) => {
      const body = block.body.join('\n').trim()
      const firstLine = (body.split(/\n/).find((l) => l.trim() !== '') || '').trim()
      return { title: block.title, body, firstLine }
    })
    .filter((entry) => {
      if (entry.body.length < MIN_PROMPT_CHARS) return false
      if (ANCHOR_TITLE.test(entry.title)) return false
      return true
    })
    .map((entry, index) => {
      const title = entry.title !== '' ? entry.title : entry.firstLine.slice(0, 60)
      return {
        index: index + 1,
        title,
        prompt: entry.body,
        slug: slugify(title !== '' ? title : entry.firstLine),
        chars: entry.body.length,
        hash: createHash('sha256').update(entry.body).digest('hex').slice(0, 12),
      }
    })
    .filter((entry) => entry.prompt.length > 0)
}

/** 落盘一张图片字节，返回元信息（路径/字节数/哈希/尺寸）。字节本身不进任何会话文本。 */
export async function saveImage(outDir, entry, bytes, ext = '.png') {
  await fsp.mkdir(outDir, { recursive: true })
  const file = path.join(outDir, `${String(entry.index).padStart(2, '0')}-${entry.slug}${ext}`)
  await fsp.writeFile(file, bytes)
  const dims = imageSize(bytes)
  return {
    status: 'saved',
    file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: dims.width,
    height: dims.height,
  }
}

/** 从响应体推断扩展名（Grok 有时给 webp/jpeg）。 */
export function extFromContentType(contentType, fallback = '.png') {
  const value = String(contentType || '').toLowerCase()
  if (value.includes('webp')) return '.webp'
  if (value.includes('jpeg') || value.includes('jpg')) return '.jpg'
  if (value.includes('png')) return '.png'
  if (value.includes('gif')) return '.gif'
  return fallback
}

/**
 * 生成浏览器插件的操作清单（给 agent 读，保证每次投喂步骤一致）。
 * 这是「脚本」与「浏览器插件」之间的契约。
 *
 * ⚠️ 取图这一步是实测出来的硬约束（2026-09-11 在真实 Grok 页面上验证）：
 *   * Grok 生成的图放在 `https://assets.grok.com/users/<uid>/generated/<id>/image.jpg`，
 *     该 URL 带签名且**绑定浏览器会话**：换 node 直连、或页面里不带凭据 fetch，都是 403 或 0 字节。
 *   * 所以取图必须发生在**已登录的那个页面上下文**里：页面内 `fetch(url, {credentials:'include'})`
 *     能拿到完整字节（实测 784×1168 竖版，259316 字节）。
 *   * 出图是**流式**的：模型文案会先出现、甚至先出现一句"已生成"，此时页面上那个节点
 *     还是占位（点阵占位图 / canvas），fetch 回来是 0 字节。必须等到"停止生成"变成
 *     "复制/Download/Make video"工具条之后再去取，否则拿到的是空壳。
 *   * 自动化附加模式下浏览器下载不落盘（点 Download 无文件产生），所以不要指望
 *     "点下载再从磁盘拿"；能用的路是：① 页面内 fetch 成 arrayBuffer 后**原样 POST**
 *     给宿主 /dvp/grok/save（raw bytes，eval 只回元信息）；② scan-cache 从浏览器磁盘
 *     缓存按体积直接捞进批次目录；③ 让用户手动点一次 Download 再从其下载目录取。
 *   * ⚠️ 图片内容（含 base64）**任何情况下不进会话文本**：1 MiB 图 ≈ 140 万字符 base64，
 *     既爆上下文，又会被工具结果上限在分块搬运时截坏（同类截断问题 browser-live 刚修过）。
 *     旧版"宿主不可用就把 base64 分块交回会话再写盘"的兜底已于 2026-09-15 删除，
 *     兜底改为盘到盘通道直接落批次目录，会话里只走"路径 + 字节数 + 哈希 + 状态"。
 */
export function grokRecipe(entries, outDir, batchId = '') {
  const batchDir = batchId === '' ? outDir : outDir + '/' + batchId
  const steps = [
    '1. browser_open(use:"edge", url:"https://grok.com/") —— 用用户的 Edge 登录态；若未登录或出现人机验证，停下来叫人，不要尝试绕过。',
    '2. browser_snapshot —— 找到输入框（Grok 的 composer，contenteditable 或 textarea）。',
  ]
  entries.forEach((entry, i) => {
    const name = String(entry.index).padStart(2, '0') + '-' + entry.slug
    steps.push(
      `3.${i + 1} 把第 ${entry.index} 条提示词（${entry.chars} 字）整段贴进输入框：browser_type(ref=<composer>, text=<完整提示词>)，然后点 Submit（或 Enter）。`,
      `3.${i + 1}b 等待出图：先等页面底部出现 "Stop model response" 再等它消失，或轮询到 "Download" / "Make video" 工具条出现。**生成中不要取图** —— 那时节点是占位，fetch 回来是 0 字节。单条超时 120s 记失败并继续下一条。`,
      `3.${i + 1}c 取图（字节直传，主路径）：browser_eval 在页面上下文里跑一段 JS：fetch(img.currentSrc,{credentials:"include"}) → arrayBuffer，校验 byteLength>0，再把这段字节**原样** POST 给宿主 \`<宿主基址>/dvp/grok/save?index=${entry.index}&slug=${entry.slug}${batchId ? '&batch=' + batchId : ''}&ext=<按响应 content-type 选>)\`（Content-Type: application/octet-stream）。这段 JS 的**返回值只能是宿主回的那一小段元信息 JSON**：{ok,status:"saved",file,bytes,sha256,width,height}，落到 ${batchDir}/${name}.<ext>。❌ 图片内容本身（base64 或其它任何编码）不得出现在 browser_eval 的返回值、命令参数或聊天文本里。`,
      `3.${i + 1}d 兜底（宿主不可达 / 路由 404 时）：**先把 GET <宿主基址>/dvp/state 探一次**确认宿主确实不通，再走盘到盘通道 —— \`node tools/scan-cache.mjs --bytes <上一步 blob.size（只是个数字）> --out ${batchDir} --name ${name}.jpg\`，字节从浏览器磁盘缓存直接进本批目录，工具会验 JPEG/PNG 签名并回报落盘路径；随后 \`Get-FileHash\` 量出 sha256。对账里要写明**为什么走了兜底**（如"宿主 404"）与 {file,bytes,sha256}。⚠️ 不许退回旧做法"把 base64 分块交回会话再写盘"（已删除的通道，1 MiB 图 ≈ 140 万字符，必爆上下文且会被结果上限截坏）。`,
      `3.${i + 1}e 最后一条路（scan-cache 也捞不到时）：请用户在真实浏览器里点一次 Download，用 \`node tools/watch-downloads.mjs --out ${batchDir}\` 接住 —— 同样是盘到盘，只回报路径与账本。`,
    )
  })
  steps.push(
    '4. 全部投完：用本脚本的 report 子命令汇总（成功/失败/耗时），失败的条目原样保留提示词，方便重投；成功条目对账只用 file/bytes/sha256，不回读图片内容。',
    '5. 全程不要修改用户的账号设置、不要删除历史会话、不要点开通订阅类按钮。',
  )
  return steps.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let text = args.prompt
  if (args.promptsFile) {
    if (!existsSync(args.promptsFile)) {
      console.error('找不到提示词文件：' + args.promptsFile)
      process.exit(2)
    }
    text = await fsp.readFile(args.promptsFile, 'utf8')
  }
  if (!text || text.trim() === '') {
    console.error('用法：node tools/grok-shot.mjs --prompts-file <file.md> [--out <dir>] [--limit N] [--batch <batchId>]')
    console.error('      node tools/grok-shot.mjs --prompt "一条提示词" [--out <dir>]')
    process.exit(2)
  }

  let entries = splitPrompts(text)
  if (args.limit > 0) entries = entries.slice(0, args.limit)
  if (entries.length === 0) {
    console.error('没有解析出任何提示词条目')
    process.exit(2)
  }

  const baseDir = path.resolve(args.out || path.join(process.cwd(), 'grok-output'))
  const outDir = args.batch === '' ? baseDir : path.join(baseDir, args.batch)
  const plan = {
    createdAt: new Date().toISOString(),
    grokUrl: args.url,
    batchId: args.batch,
    outDir,
    count: entries.length,
    entries,
  }
  await fsp.mkdir(outDir, { recursive: true })
  const planFile = path.join(outDir, 'plan.json')
  await fsp.writeFile(planFile, JSON.stringify(plan, null, 2), 'utf8')

  console.log('批次已生成：' + planFile)
  console.log('共 ' + entries.length + ' 条，图片将落到 ' + outDir)
  entries.forEach((entry) => {
    console.log('  ' + String(entry.index).padStart(2, '0') + '. ' + entry.slug + '  (' + entry.chars + ' 字)')
  })
  if (args.printGrokDoc) {
    console.log('\n──── 给浏览器插件的操作清单 ────\n' + grokRecipe(entries, outDir, args.batch))
  }
}

// 直接调用判断：Windows 盘符 + 中文路径下手工拼 `file://${argv[1]}` 会漏判，用 pathToFileURL 才可靠。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String((err && err.stack) || err))
    process.exit(1)
  })
}
