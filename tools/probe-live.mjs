// 对**真实工作区**跑一遍宿主扫描与分流（不是临时 fixture）。
//
//   node tools/probe-live.mjs
//
// 与 probe-host.mjs 的分工：那个用临时目录验证路由行为；这个用你实际用的媒体根目录，
// 验证"面板打开时会看到什么"——图片几张、视频几个、文本几个、状态读不读得到。
// 只读，不写任何东西（除了打印）。

import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const MEDIA = 'D:/DeepSeek/01-video技能/media'
const RUNS = 'D:/DeepSeek/01-video技能/runs'

let checks = 0
let failures = 0
function ok(label, condition, detail) {
  checks += 1
  if (condition) console.log('  ✓ ' + label)
  else {
    failures += 1
    console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''))
  }
}

if (!existsSync(MEDIA)) {
  console.error('真实媒体根目录不存在：' + MEDIA)
  process.exit(2)
}

// 真 HTTP 承托 webServer 契约
const routes = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((r) => (r.kind === 'exact' ? r.path === url.pathname : url.pathname.startsWith(r.path)))
  if (route === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false}')
    return
  }
  await route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = 'http://127.0.0.1:' + server.address().port

const host = await import(pathToFileURL(path.join(PKG, 'index.js')).href)
const skills = []
await host.apply({
  get: (key) => {
    if (key === 'webServer') return { register: (r) => { routes.push(r); return () => {} }, tapIndex: () => () => {} }
    if (key === 'skills') return { register: (s) => { skills.push(s); return () => {} }, list: async () => [] }
    return undefined
  },
  effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
}, { mediaRoot: MEDIA, runsRoot: RUNS, registerSkills: true })

console.log('\n真实媒体根目录：' + MEDIA)
console.log('路由已挂：' + routes.length + ' 条，技能已注册：' + skills.length + ' 个\n')

console.log('1) 扫描与分流')
const scan = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(MEDIA))).json()
ok('扫描成功', scan.ok === true, scan.error)
// 默认层数 4（见已修坑 10：素材常按「一部剧/一本书一个子目录」摆，2 层只扫到一半）
ok('默认 depth=4', scan.depth === 4, scan.depth)
console.log('    图片 ' + scan.images.length + ' 张：' + scan.images.map((i) => i.rel).join(', '))
console.log('    视频 ' + scan.videos.length + ' 个：' + scan.videos.map((v) => v.rel).join(', '))
ok('按扩展名正确分流（图片集合）', scan.images.every((i) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(i.name)), scan.images.map((i) => i.name))
ok('按扩展名正确分流（视频集合）', scan.videos.every((v) => /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(v.name)), scan.videos.map((v) => v.name))
ok('没有把 .md 当媒体', ![...scan.images, ...scan.videos].some((i) => /\.md$/i.test(i.name)))
ok('四张关键帧都在图片组里', ['01-doorbell.jpg', '02-downcast.jpg', '03-glowing-vial.jpg', '04-moonlit-manor.jpg'].every((n) => scan.images.some((i) => i.name === n)), scan.images.map((i) => i.name))
ok('示例视频在视频组里', scan.videos.some((v) => v.name === 'sample-feishu-clip.mp4'))
// 回归：grok-output 是产物目录，不能被当成素材扫回来（否则会把 Grok 的产出再喂回 Grok）
ok('产物目录 grok-output 不参与扫描（回归）', !scan.images.some((i) => i.rel.includes('grok-output')), scan.images.map((i) => i.rel))
ok('图片恰好 4 张（只有源关键帧）', scan.images.length === 4, scan.images.map((i) => i.rel))
ok('每条带体积', [...scan.images, ...scan.videos].every((i) => typeof i.bytes === 'number' && i.bytes > 0))

console.log('\n2) 逐项状态（面板上那一列「待处理」）')
const manifest = await (await fetch(BASE + '/dvp/manifest?dir=' + encodeURIComponent(MEDIA))).json()
ok('读得到 manifest', manifest.ok === true)
const stateCount = Object.keys(manifest.items || {}).length
console.log('    已记录状态项：' + stateCount + '（0 表示这批还没跑过，面板会全显示「待处理」）')
ok('manifest 结构合法', manifest.items !== undefined && Array.isArray(manifest.runs || []), { items: typeof manifest.items })
ok('扫描结果里带回了这些状态', scan.state !== undefined)

console.log('\n3) Grok 产物目录')
const grokDir = path.join(MEDIA, 'grok-output')
if (existsSync(grokDir)) {
  const files = await fsp.readdir(grokDir)
  const plan = JSON.parse(await fsp.readFile(path.join(grokDir, 'plan.json'), 'utf8'))
  const ledgerFile = path.join(grokDir, 'ledger.json')
  const ledger = existsSync(ledgerFile) ? JSON.parse(await fsp.readFile(ledgerFile, 'utf8')) : { items: [] }
  console.log('    目录内容：' + files.join(', '))
  ok('批次 4 条', plan.count === 4, plan.count)
  ok('批次每条都有真提示词（无占位符）', plan.entries.every((e) => !String(e.prompt).startsWith('（待填') && String(e.prompt).length > 300), plan.entries.map((e) => String(e.prompt).length))
  ok('driver.md 存在', files.includes('driver.md'))
  ok('账本 4 张成图', ledger.items.length === 4, ledger.items.length)
  ok('成图文件真的在盘上', ledger.items.every((i) => existsSync(i.file)), ledger.items.map((i) => path.basename(i.file)))
  ok('每张图都有 sha256', ledger.items.every((i) => typeof i.sha256 === 'string' && i.sha256.length === 64))
  const jpg = files.filter((f) => /\.jpe?g$/i.test(f))
  ok('成图文件 4 个', jpg.length === 4, jpg)
} else {
  console.log('    （还没有 grok-output）')
}

console.log('\n4) 技能注册内容')
ok('6 个技能', skills.length === 6, skills.map((s) => s.name))
ok('含 viral-media-copywriter（爆款蒸馏底座）', skills.some((s) => s.name === 'viral-media-copywriter'))
ok('resourceBase 指向包内真目录', skills.every((s) => existsSync(s.resourceBase.path)))
ok('描述都是正文（非块标量记号）', skills.every((s) => s.description.length > 20 && !/^[>|]$/.test(s.description.trim())), skills.map((s) => [s.name, s.description.slice(0, 24)]))

server.close()
console.log('\n' + (failures === 0 ? '全部通过：' + checks + ' 项检查' : failures + ' / ' + checks + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
