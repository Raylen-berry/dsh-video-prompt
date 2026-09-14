// 把已产出的图片提示词文档回填进 Grok 批次。
//
//   node tools/backfill-plan.mjs --plan <grok-output/plan.json> --doc <optimized-image-prompt.md>
//   node tools/backfill-plan.mjs --plan ... --doc ... --dry
//
// 为什么需要它：面板上的「用 Grok 生图」建批次时，提示词可能还没产出（那时只能写占位符），
// 而批次一旦落盘就该是"能直接投喂"的。这个脚本做两件事：
//   1. 按条目顺序把文档里的提示词正文填回 plan.json 的 entries[].prompt
//   2. 顺带核对条数是否对得上（文档 4 条 vs 批次 4 条），对不上就报出来，不静默吞
//
// 解析规则与 tools/grok-shot.mjs 的 splitPrompts 保持一致（用同一份实现，避免两处漂移）。

import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { splitPrompts } from './grok-shot.mjs'

function parseArgs(argv) {
  const args = { plan: '', doc: '', dry: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--plan') { args.plan = next; i += 1; continue }
    if (token === '--doc') { args.doc = next; i += 1; continue }
    if (token === '--dry') { args.dry = true; continue }
  }
  return args
}

/** 渲染驱动清单。与宿主 index.js 的 driverDoc 同形，但这里带真提示词与 Download 收件步骤。 */
export function renderDriverDoc(plan) {
  const lines = []
  lines.push('# Grok 出图驱动清单')
  lines.push('')
  lines.push('- 生成时间：' + new Date().toISOString())
  lines.push('- 批次文件：' + path.join(plan.dir || path.dirname(plan.planFile || ''), 'plan.json'))
  lines.push('- 目标站点：' + (plan.grokUrl || 'https://grok.com/'))
  lines.push('- 批次条数：' + (plan.count || (plan.entries || []).length))
  lines.push('- 图片落地：' + (plan.dir || ''))
  lines.push('')
  lines.push('## 执行方式')
  lines.push('')
  lines.push('由会话里的 agent 用浏览器插件驱动用户的 Edge：')
  lines.push('')
  lines.push('1. `browser_open(use:"edge", url:"' + (plan.grokUrl || 'https://grok.com/') + '")` —— 走用户登录态。')
  lines.push('2. 未登录 / 出现人机验证 / 额度用尽时**停下来叫人**，不允许绕过。')
  lines.push('3. 逐条把下面提示词贴进 Grok 输入框并点 Submit。')
  lines.push('4. **等流式输出收尾**（`Stop model response` 消失、出现 `Download`/`Make video` 工具条）再去取图；')
  lines.push('   生成中取到的是占位图。单条超时 120 秒记失败并继续。')
  lines.push('5. 取图只能发生在已登录的页面上下文里（签名 URL 换 node 直连是 403，canvas 被 CORS 污染）。')
  lines.push('   首选通道：页面内 fetch 成 arrayBuffer 后把字节**原样** `POST /dvp/grok/save?index=<序号>&slug=<slug>&batch=<批次ID>`')
  lines.push('   （raw bytes；宿主回 {file,bytes,sha256,width,height} 元信息即落盘成功）。')
  lines.push('   ⚠️ 图片内容/base64 一律不进会话文本（1 MiB 图 ≈ 140 万字符，爆上下文且会被结果上限截坏）；')
  lines.push('   拿不到字节时的兜底只能盘到盘：`node tools/scan-cache.mjs --bytes <体积> --out <本目录>` 从浏览器缓存直接捞，')
  lines.push('   或请用户在真实浏览器里点一次 Download，然后用')
  lines.push('   `node tools/watch-downloads.mjs --out <本目录>` 接住并自动改名写账。')
  lines.push('6. 全部投完核对 `ledger.json`：成功几张、失败几张、失败原因（对账只用 file/bytes/sha256，不回读图片内容）。')
  lines.push('')
  lines.push('## 提示词清单')
  lines.push('')
  for (const entry of plan.entries || []) {
    lines.push('### ' + entry.index + '. ' + (entry.title || entry.slug))
    lines.push('')
    lines.push('- 落盘文件名：`' + String(entry.index).padStart(2, '0') + '-' + entry.slug + '.<ext>`')
    if (entry.source) lines.push('- 素材来源：`' + entry.source + '`')
    if (entry.hash) lines.push('- 提示词指纹：`' + entry.hash + '`')
    lines.push('')
    lines.push('```text')
    lines.push(entry.prompt)
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.plan === '' || args.doc === '') {
    console.error('用法：node tools/backfill-plan.mjs --plan <plan.json> --doc <prompts.md> [--dry]')
    process.exit(2)
  }
  const planFile = path.resolve(args.plan)
  const docFile = path.resolve(args.doc)
  for (const [label, file] of [['plan', planFile], ['doc', docFile]]) {
    if (!existsSync(file)) {
      console.error('找不到' + label + '：' + file)
      process.exit(2)
    }
  }

  const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'))
  const entries = Array.isArray(plan.entries) ? plan.entries : []
  const parsed = splitPrompts(await fsp.readFile(docFile, 'utf8'))

  console.log('批次条目：' + entries.length + ' 条')
  console.log('文档提示词：' + parsed.length + ' 条')
  if (entries.length !== parsed.length) {
    console.log('⚠️  条数不一致 —— 不静默处理：下面按顺序配对，多出来的会原样报告。')
  }

  let filled = 0
  const rows = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const source = parsed[i]
    if (!source) {
      rows.push({ index: entry.index, slug: entry.slug, action: '无可配对提示词（保持原值）' })
      continue
    }
    const before = String(entry.prompt || '')
    const placeholder = before.startsWith('（待填') || before.trim() === ''
    entry.prompt = source.prompt
    entry.title = entry.title && !/^（待填/.test(entry.title) ? entry.title : source.title
    entry.chars = source.prompt.length
    entry.hash = source.hash
    entry.sourceDoc = docFile
    if (placeholder || before !== source.prompt) filled += 1
    rows.push({ index: entry.index, slug: entry.slug, action: (placeholder ? '填占位符' : '覆盖') + ' ← ' + source.title, chars: source.prompt.length })
  }

  for (const row of rows) {
    console.log('  ' + String(row.index).padStart(2, '0') + '. ' + row.slug + ' · ' + row.action + (row.chars ? '（' + row.chars + ' 字）' : ''))
  }
  for (let i = entries.length; i < parsed.length; i += 1) {
    console.log('  ⚠️  文档里多出第 ' + parsed[i].index + ' 条：' + parsed[i].title + '（批次里没有对应条目，未写入）')
  }

  if (args.dry) {
    console.log('\n--dry：只报告，没有写盘')
    return
  }
  plan.updatedAt = new Date().toISOString()
  plan.backfilledFrom = docFile
  await fsp.writeFile(planFile, JSON.stringify(plan, null, 2), 'utf8')
  const driverFile = path.join(path.dirname(planFile), 'driver.md')
  await fsp.writeFile(driverFile, renderDriverDoc({ ...plan, dir: path.dirname(planFile), planFile }), 'utf8')
  console.log('\n已写回 ' + planFile)
  console.log('已重写 ' + driverFile)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String((err && err.stack) || err))
    process.exit(1)
  })
}
