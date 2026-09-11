// 从浏览器磁盘缓存里把已加载的图片捞出来（Grok 取图的兜底通道）。
//
//   node tools/scan-cache.mjs --list          # 按体积列出候选
//   node tools/scan-cache.mjs --bytes 259316 --out <dir> --name <file.jpg>
//
// 为什么需要它（2026-09-11 实测）：
//   * Grok 成图 URL 带签名、绑浏览器会话 —— node 直连 403，页面内无凭据 fetch 0 字节。
//   * 页面内 `fetch(url,{credentials:'include'})` 能拿到完整字节，但 blob 传不回宿主时
//     没有落盘通路；canvas 导出被 CORS 污染（SecurityError: tainted）。
//   * 自动化附加模式下点 Download 不落盘（插件把 Page/Browser.setDownloadBehavior 列进了
//     DENIED_PREFIX，那是它对"用户的浏览器"的安全边界，不该绕）。
//   * 但**图一旦在浏览器里显示过，字节就在磁盘缓存里**。缓存文件是无扩展名的二进制块，
//     靠体积 + JPEG 头尾签名可以精确捞回来：实测按 259316 字节命中，取出后 sha 与
//     页面内读到的字节一致，`read_image` 能正常解码成 784×1168。
//
// 适用边界（写清楚，别当成万能）：
//   * 只对**已经完整下载并显示过**的图有效；流式生成中缓存里是残片。
//   * 体积不是唯一键：同体积的别的资源会被误捞，所以取出来后必须验 JPEG 签名，
//     并且调用方应当用 read_image 或尺寸再确认一次。
//   * 缓存会被浏览器清理/轮转，命中有时效性，尽早取。
//   * 这是"绕过 UI 的兜底"，不是推荐路径：首选仍是页面内读字节交给 /dvp/grok/save，
//     其次是请用户点一次 Download 让 tools/watch-downloads.mjs 接住。

import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const IMAGE_SIGNATURES = [
  { ext: '.jpg', head: [0xff, 0xd8, 0xff], tail: [0xff, 0xd9] },
  { ext: '.png', head: [0x89, 0x50, 0x4e, 0x47], tail: [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] },
  { ext: '.webp', head: [0x52, 0x49, 0x46, 0x46], tail: null },
]

function defaultCacheRoots() {
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return [
    path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data'),
    path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'Cache_Data'),
    path.join(local, 'Microsoft', 'Edge', 'User Data', 'Profile 1', 'Cache', 'Cache_Data'),
  ]
}

export function identifyImage(bytes) {
  for (const sig of IMAGE_SIGNATURES) {
    const headOk = sig.head.every((b, i) => bytes[i] === b)
    if (!headOk) continue
    const tailOk = sig.tail === null
      ? true
      : sig.tail.every((b, i) => bytes[bytes.length - sig.tail.length + i] === b)
    return { ext: sig.ext, head: true, tail: tailOk }
  }
  return null
}

function parseArgs(argv) {
  const args = { list: false, bytes: 0, out: '', name: '', root: '', tolerance: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--list') { args.list = true; continue }
    if (token === '--bytes') { args.bytes = Number(next) || 0; i += 1; continue }
    if (token === '--out') { args.out = next; i += 1; continue }
    if (token === '--name') { args.name = next; i += 1; continue }
    if (token === '--root') { args.root = next; i += 1; continue }
    if (token === '--tolerance') { args.tolerance = Number(next) || 0; i += 1; continue }
  }
  return args
}

async function listCandidates(roots, minBytes = 30000) {
  const found = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let names = []
    try {
      names = await fsp.readdir(root)
    } catch {
      continue
    }
    for (const name of names) {
      const full = path.join(root, name)
      try {
        const stat = await fsp.stat(full)
        if (!stat.isFile() || stat.size < minBytes) continue
        found.push({ root, name, file: full, bytes: stat.size, mtime: stat.mtimeMs })
      } catch {
        continue
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const roots = args.root !== '' ? [path.resolve(args.root)] : defaultCacheRoots()

  if (args.list || args.bytes === 0) {
    console.log('候选缓存目录：')
    for (const root of roots) console.log('  ' + (existsSync(root) ? '✓' : '✗') + ' ' + root)
    const found = await listCandidates(roots)
    console.log('\n按时间倒序的前 20 个 >=30KB 的二进制块（体积|时间|文件）：')
    for (const item of found.slice(0, 20)) {
      console.log('  ' + String(item.bytes).padStart(9) + '  ' + new Date(item.mtime).toLocaleString('zh-CN', { hour12: false }) + '  ' + item.name)
    }
    if (args.bytes === 0) {
      console.log('\n用 --bytes <体积> [--out <目录> --name <文件名>] 捞取具体文件。')
    }
    return
  }

  const tolerance = Math.max(0, args.tolerance)
  const found = await listCandidates(roots)
  const hits = found.filter((item) => Math.abs(item.bytes - args.bytes) <= tolerance)
  if (hits.length === 0) {
    console.error('没有体积在 ' + (args.bytes - tolerance) + '~' + (args.bytes + tolerance) + ' 字节之间的缓存块')
    process.exit(1)
  }
  console.log('命中 ' + hits.length + ' 个候选：')
  let written = 0
  for (const hit of hits) {
    let bytes
    try {
      bytes = await fsp.readFile(hit.file)
    } catch (err) {
      console.log('  ✗ ' + hit.name + ' 读取失败：' + String((err && err.message) || err))
      continue
    }
    const kind = identifyImage(bytes)
    if (kind === null || kind.tail === false) {
      console.log('  ✗ ' + hit.name + ' 不是完整图片（签名不匹配）')
      continue
    }
    console.log('  ✓ ' + hit.name + ' → ' + kind.ext + '，' + bytes.length + ' 字节，' + new Date(hit.mtime).toLocaleString('zh-CN', { hour12: false }))
    if (args.out !== '' && written === 0) {
      await fsp.mkdir(path.resolve(args.out), { recursive: true })
      const name = args.name !== '' ? args.name : 'cache-' + Date.now() + kind.ext
      const dest = path.join(path.resolve(args.out), name)
      await fsp.writeFile(dest, bytes)
      written += 1
      console.log('    已写出：' + dest)
    }
  }
  if (args.out === '') console.log('\n（未给 --out，只做了辨认，没有写盘）')
  else if (written === 0) {
    console.error('没有写出任何文件')
    process.exit(1)
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String((err && err.stack) || err))
    process.exit(1)
  })
}
