// 下载目录守护：把用户在 Edge 里点 Download 得到的图，自动收进产物目录并写账。
//
//   node tools/watch-downloads.mjs [--minutes 15] [--out <dir>] [--src <dir>]
//
// `--out` 要指向**本批次的目录**（`<mediaRoot>/grok-output/<批次ID>/`）：
// 批次目录隔离之后，账本写在该批次目录里，图和账就不会再跨批次混。缺省仍是
// `$DVP_MEDIA_ROOT/grok-output`（旧版平铺布局），只适合手工收一批图时用。
//
// 为什么需要它：Grok 的成图 URL 带签名、绑浏览器会话（node 直连 403、页面内 canvas 被
// CORS 污染），自动化附加模式下点 Download 又不落盘。于是"最后一公里"由人在真实浏览器里
// 点一次 Download 完成，本地这一侧用本脚本接住——人点一下，剩下的自动。
//
// 行为：
//   * 只收 .jpg/.jpeg/.png/.webp，且大小超过 --min-bytes（默认 20KB，滤掉图标与占位）
//   * 按 mtime 判断"新文件"：只处理启动之后落地、且已稳定的文件（连续两次大小一致才算写完）
//   * 按 plan.json 的序号顺序命名成 `<序号>-<slug>.<ext>`，写进 <out>/ledger.json
//     （out 指批次目录时，账本与本批产物同处一个目录）
//   * 已处理过的（同名或同 sha256）跳过，可重复运行
//   * **真正空闲**才退出：从"最后一次收到图"开始算空闲（`idleExitMs`，默认 20 秒），
//     并且只在收过图之后才允许退出。每一轮只要收到过图，空闲计时就归零
//     —— 早先是 `idleRounds` 自增、收到图也不重置，于是第 5 轮必定退出，
//     边投边出图的长批次会被半路掐断。
//   * 到点自己退出，不留常驻进程

import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

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

/**
 * 守一轮或多轮，收图写账。
 *
 * options:
 *   outDir / srcDir        收件箱与下载目录（必填）
 *   entries                命名用的 plan.entries
 *   minutes / idleExitMs   最长等待、空闲多久算收工（默认 20 秒）
 *   minBytes               过滤小图标
 *   roundMs                每轮间隔（默认 5 秒）
 *   clock                  取当前时间的函数（默认真实时钟，测试可注入假钟）
 *   sleep                  (ms) => Promise（默认真等待，测试可注入）
 *   quiet                  不打日志
 * 返回 { received, reason, idleMs, ledger }：
 *   reason = 'idle'（真空闲退出）| 'deadline'（等满分钟数）| 'src-missing'
 */
export async function watchDownloads(options = {}) {
  const outDir = path.resolve(options.outDir)
  const srcDir = path.resolve(options.srcDir)
  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : 20 * 1024
  const minutes = Number.isFinite(options.minutes) ? options.minutes : 15
  const idleExitMs = Number.isFinite(options.idleExitMs) ? options.idleExitMs : 20 * 1000
  const roundMs = Number.isFinite(options.roundMs) ? options.roundMs : 5000
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const say = options.quiet ? () => {} : log
  const entries = Array.isArray(options.entries) ? options.entries : await readPlan(outDir)

  if (!existsSync(srcDir)) {
    say('下载目录不存在：' + srcDir)
    return { received: 0, reason: 'src-missing', idleMs: 0, ledger: { items: [] } }
  }
  await fsp.mkdir(outDir, { recursive: true })

  const now0 = clock()
  const startedAt = now0
  const deadline = now0 + minutes * 60 * 1000
  say('守护启动 · 监听 ' + srcDir)
  say('收件箱 ' + outDir + ' · 最长等待 ' + minutes + ' 分钟 · 只收 >' + Math.round(minBytes / 1024) + 'KB 的图片 · 连续空闲 '
    + Math.round(idleExitMs / 1000) + ' 秒收工')
  if (entries.length > 0) say('已读到 plan.json：' + entries.length + ' 条（用于命名）')

  const ledger = await readLedger(outDir)
  const doneHashes = new Set(ledger.items.map((i) => i.sha256).filter(Boolean))
  const doneFiles = new Set(ledger.items.map((i) => path.basename(i.file || '')).filter(Boolean))

  // 记录启动时已存在的文件，避免把历史下载当成本次产物
  const preexisting = new Set()
  for (const name of await fsp.readdir(srcDir)) preexisting.add(name)

  const sizeMemory = new Map()
  let received = 0
  // 空闲判据：从"最后一次成功收图"算起。收到一张就把计时归零，
  // 所以只要还有新图进来，就永远不会触发"连续空闲"。
  let lastReceiveAt = 0
  let reason = 'deadline'

  while (clock() < deadline) {
    let roundReceived = 0
    let names = []
    try {
      names = await fsp.readdir(srcDir)
    } catch (err) {
      say('读下载目录失败：' + String((err && err.message) || err))
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
      if (stat.size < minBytes) continue
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
      roundReceived += 1

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
      say('✓ 收起第 ' + received + ' 张：' + name + ' → ' + target + '（' + bytes.length + ' 字节）')
    }

    if (roundReceived > 0) {
      // 这一轮收到图 → 计时从**现在**重新开始（不是"继续累计空闲轮数"）
      lastReceiveAt = clock()
    } else if (received > 0 && clock() - lastReceiveAt >= idleExitMs) {
      reason = 'idle'
      say('已收到 ' + received + ' 张，且从最后一次收图起连续 ' + Math.round((clock() - lastReceiveAt) / 1000) + ' 秒没有新图，收工')
      break
    }
    await sleep(roundMs)
  }

  const idleMs = lastReceiveAt > 0 ? Math.max(0, clock() - lastReceiveAt) : 0
  if (received === 0) {
    say('等待超时：这段时间没有新的图片落到下载目录。若你已点过 Download，检查下载位置是否被改过（用 --src 指定）。')
  } else if (reason === 'deadline') {
    say('等满 ' + minutes + ' 分钟：共收下 ' + received + ' 张，账本 ' + path.join(outDir, 'ledger.json'))
  } else {
    say('收工：共收下 ' + received + ' 张，账本 ' + path.join(outDir, 'ledger.json'))
  }
  return { received, reason, idleMs, ledger }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(args.out || path.join(process.env.DVP_MEDIA_ROOT || 'media', 'grok-output'))
  const srcDir = path.resolve(args.src || path.join(os.homedir(), 'Downloads'))
  const result = await watchDownloads({
    outDir,
    srcDir,
    minutes: args.minutes,
    minBytes: args.minBytes,
    // 命令行口径没变：默认 20 秒空闲即收工
    idleExitMs: 20 * 1000,
    quiet: args.quiet,
  })
  if (result.reason === 'src-missing') {
    console.error('下载目录不存在：' + srcDir + '（用 --src 指定你实际的下载位置）')
    process.exit(2)
  }
  process.exit(0)
}

// 只有直接 `node tools/watch-downloads.mjs` 才跑 CLI；被 import 时不启动守护
// （tools/verify-watch-idle.mjs 就是 import 它来离线断言空闲判据的）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String((err && err.stack) || err))
    process.exit(1)
  })
}
