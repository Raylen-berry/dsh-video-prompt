// 下载目录守护：把用户在 Edge 里点 Download 得到的图，自动收进产物目录并写账。
//
//   node tools/watch-downloads.mjs [--minutes 15] [--out <dir>] [--src <dir>]
//
// 为什么需要它：Grok 的成图 URL 带签名、绑浏览器会话（node 直连 403、页面内 canvas 被
// CORS 污染），自动化附加模式下点 Download 又不落盘。于是"最后一公里"由人在真实浏览器里
// 点一次 Download 完成，本地这一侧用本脚本接住——人点一下，剩下的自动。
//
// 行为：
//   * 只收 .jpg/.jpeg/.png/.webp，且大小超过 --min-bytes（默认 20KB，滤掉图标与占位）
//   * 按 mtime 判断"新文件"：只处理启动之后落地、且已稳定的文件（连续两次大小一致才算写完）
//   * 按 plan.json 的序号顺序命名成 `<序号>-<slug>.<ext>`，写进 grok-output/ledger.json
//   * 已处理过的（同名或同 sha256）跳过，可重复运行
//   * 到点自己退出，不留常驻进程
//
// Windows 上 Edge 的默认下载目录是 %USERPROFILE%\Downloads；若你改过下载位置，用 --src 指定。

import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])

function parseArgs(argv) {
  const args = { minutes: 15, out: '', src: '', minBytes: 20 * 1024, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--minutes') { args.minutes = Number(next) || 15; i += 1; continue }
    if (token === '--out') { args.out = next; i += 1; continue }
    if (token === '--src') { args.src = next; i += 1; continue }
    if (token === '--min-bytes') { args.minBytes = Number(next) || 0; i += 1; continue }
    if (token === '--quiet') { args.quiet = true; continue }
  }
  return args
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function log(...parts) {
  console.log('[' + stamp() + '] ' + parts.join(' '))
}

async function readLedger(outDir) {
  const file = path.join(outDir, 'ledger.json')
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    return parsed && Array.isArray(parsed.items) ? parsed : { items: [], updatedAt: '' }
  } catch {
    return { items: [], updatedAt: '' }
  }
}

async function writeLedger(outDir, ledger) {
  ledger.updatedAt = new Date().toISOString()
  await fsp.writeFile(path.join(outDir, 'ledger.json'), JSON.stringify(ledger, null, 2), 'utf8')
}

async function readPlan(outDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(outDir, 'plan.json'), 'utf8'))
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

/** 给第 n 个收到的图挑一个文件名：优先用 plan 里的 slug，缺了就用 download-<n>。 */
function targetName(entries, index, ext, usedNames) {
  const entry = entries[index]
  const slug = entry && entry.slug ? entry.slug : 'download-' + (index + 1)
  let name = String(index + 1).padStart(2, '0') + '-' + slug + ext
  let bump = 1
  while (usedNames.has(name)) {
    name = String(index + 1).padStart(2, '0') + '-' + slug + '-' + bump + ext
    bump += 1
  }
  return name
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(args.out || path.join(process.env.DVP_MEDIA_ROOT || 'media', 'grok-output'))
  const srcDir = path.resolve(args.src || path.join(os.homedir(), 'Downloads'))
  const deadline = Date.now() + args.minutes * 60 * 1000

  if (!existsSync(srcDir)) {
    console.error('下载目录不存在：' + srcDir + '（用 --src 指定你实际的下载位置）')
    process.exit(2)
  }
  await fsp.mkdir(outDir, { recursive: true })

  const startedAt = Date.now()
  log('守护启动 · 监听 ' + srcDir)
  log('收件箱 ' + outDir + ' · 最长等待 ' + args.minutes + ' 分钟 · 只收 >' + Math.round(args.minBytes / 1024) + 'KB 的图片')

  const entries = await readPlan(outDir)
  if (entries.length > 0) log('已读到 plan.json：' + entries.length + ' 条（用于命名）')

  const ledger = await readLedger(outDir)
  const doneHashes = new Set(ledger.items.map((i) => i.sha256).filter(Boolean))
  const doneFiles = new Set(ledger.items.map((i) => path.basename(i.file || '')).filter(Boolean))

  // 记录启动时已存在的文件，避免把历史下载当成本次产物
  const preexisting = new Set()
  for (const name of await fsp.readdir(srcDir)) preexisting.add(name)

  const sizeMemory = new Map()
  let received = 0
  let idleRounds = 0

  while (Date.now() < deadline) {
    let names = []
    try {
      names = await fsp.readdir(srcDir)
    } catch (err) {
      log('读下载目录失败：' + String((err && err.message) || err))
    }

    for (const name of names) {
      if (preexisting.has(name)) continue
      const ext = path.extname(name).toLowerCase()
      if (!IMAGE_EXT.has(ext)) continue
      if (doneFiles.has(name)) continue
      const full = path.join(srcDir, name)
      let stat
      try {
        stat = await fsp.stat(full)
      } catch {
        continue // 可能正在被浏览器写
      }
      if (stat.size < args.minBytes) continue
      const seen = sizeMemory.get(full)
      if (seen !== stat.size) {
        // 还在长，下一轮再看
        sizeMemory.set(full, stat.size)
        continue
      }

      const bytes = await fsp.readFile(full)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (doneHashes.has(sha256)) {
        doneFiles.add(name)
        continue
      }
      if (stat.mtimeMs < startedAt - 2000) {
        // 启动前就存在的旧图：记入 preexisting，不再处理
        preexisting.add(name)
        continue
      }

      const target = targetName(entries, received, ext, doneFiles)
      const dest = path.join(outDir, target)
      await fsp.writeFile(dest, bytes)
      doneFiles.add(target)
      doneHashes.add(sha256)
      received += 1

      ledger.items.push({
        at: new Date().toISOString(),
        index: received,
        slug: path.basename(target, ext),
        file: dest,
        bytes: bytes.length,
        source: full,
        sha256,
        note: '来自浏览器 Download',
      })
      await writeLedger(outDir, ledger)
      log('✓ 收起第 ' + received + ' 张：' + name + ' → ' + target + '（' + bytes.length + ' 字节）')
    }

    if (received > 0 && idleRounds >= 4) {
      log('已收到 ' + received + ' 张且连续 20 秒无新文件，收工')
      break
    }
    idleRounds = received > 0 ? idleRounds + 1 : 0
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  log(received === 0
    ? '等待超时：这段时间没有新的图片落到下载目录。若你已点过 Download，检查下载位置是否被改过（用 --src 指定）。'
    : '收工：共收下 ' + received + ' 张，账本 ' + path.join(outDir, 'ledger.json'))
  process.exit(0)
}

main().catch((err) => {
  console.error(String((err && err.stack) || err))
  process.exit(1)
})
