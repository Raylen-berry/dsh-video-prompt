// 运行时集成测试：不启动 DSH，用真 HTTP 服务承托宿主半边。
//
//   node tools/probe-host.mjs
//
// 与 selfcheck 的分工：selfcheck 验静态契约与纯函数；本脚本把 index.js 的 apply()
// 挂到一个真的 node:http 服务上（实现 webServer.register/tapIndex 契约），
// 然后用真请求打每一条 /dvp/* 路由，验证：
//   * 路由真的注册上了、路径与 kind 正确
//   * 扫描分流正确（图片/视频分开、扩展名分类、深度、隐藏目录跳过）
//   * 路径围栏生效（越界 403）
//   * 图片字节真的能取出来（PNG 魔数校验）
//   * 逐项状态能写能读回（manifest）
//   * 运行目录真落盘（optimized-* 文件）
//   * Grok 批次能落盘并生成 driver.md；base64 图片能保存并进 ledger
//   * 技能注册走了 ctx.skills.register（用假 skills 服务断言注册内容）
//
// 所有产物写在 <包>/tools/.probe-tmp 下，跑完删除。

import { createServer } from 'node:http'
import { existsSync, readFileSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PKG = path.resolve(HERE, '..')
const TMP = path.join(HERE, '.probe-tmp')
const MEDIA = path.join(TMP, 'media')
const RUNS = path.join(TMP, 'runs')

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

// ── 1. 造素材 ───────────────────────────────────────────────────────────────
await fsp.rm(TMP, { recursive: true, force: true })
await fsp.mkdir(path.join(MEDIA, 'images'), { recursive: true })
await fsp.mkdir(path.join(MEDIA, 'videos'), { recursive: true })
await fsp.mkdir(path.join(MEDIA, '.hidden'), { recursive: true })
await fsp.mkdir(RUNS, { recursive: true })

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
await fsp.writeFile(path.join(MEDIA, 'images', 'shot-a.png'), PNG_1x1)
await fsp.writeFile(path.join(MEDIA, 'images', 'shot-b.jpg'), Buffer.alloc(2048, 7))
await fsp.writeFile(path.join(MEDIA, 'images', 'notes.md'), '# 不是媒体\n')
await fsp.writeFile(path.join(MEDIA, 'videos', 'clip-one.mp4'), Buffer.alloc(4096, 3))
await fsp.writeFile(path.join(MEDIA, '.hidden', 'ghost.png'), PNG_1x1)
await fsp.writeFile(path.join(MEDIA, 'ignore.txt'), 'x', 'utf8')
// 深层素材：默认层数必须够得到它。（用户报"图在盘里、面板里没有"，就是层数不够）
await fsp.mkdir(path.join(MEDIA, 'books', 'vol1', 'ch01', 'frames'), { recursive: true })
await fsp.writeFile(path.join(MEDIA, 'books', 'vol1', 'ch01', 'frames', 'deep.png'), PNG_1x1)
// 扩展名收录回归：这些以前都不在名单里，扫不到就选不进出图批次
for (const name of ['legacy.jpe', 'cover.svg', 'scan.tiff', 'phone.heic']) {
  await fsp.writeFile(path.join(MEDIA, 'images', name), PNG_1x1)
}
for (const name of ['old.mts', 'clip.ogv']) {
  await fsp.writeFile(path.join(MEDIA, 'videos', name), Buffer.alloc(2048, 5))
}
await fsp.writeFile(path.join(MEDIA, 'story.txt'), '第一章\n\n雨夜按铃。\n', 'utf8')

// 落盘自证：先回读一遍目录，避免"测试自己没建成素材"被误判成插件缺陷
const mediaEntries = []
for (const sub of ['images', 'videos', '.hidden', '']) {
  const dir = sub === '' ? MEDIA : path.join(MEDIA, sub)
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    mediaEntries.push((sub === '' ? '' : sub + '/') + entry.name)
  }
}
console.log('\n0) 素材落盘自证')
const topLevelFiles = mediaEntries.filter((e) => !e.includes('/') && !['images', 'videos', '.hidden', 'books'].includes(e))
ok('素材文件确实写到磁盘（顶层 2 个文件）', topLevelFiles.length === 2, topLevelFiles)

// ── 2. 真 HTTP 服务承托 webServer 契约 ──────────────────────────────────────
const routes = []
const taps = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.find((r) => (r.kind === 'exact' ? r.path === url.pathname : url.pathname.startsWith(r.path)))
  if (route === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '无路由匹配 ' + url.pathname }))
    return
  }
  try {
    await route.handler(req, res)
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('handler 抛错: ' + String((err && err.message) || err))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port
const BASE = 'http://127.0.0.1:' + PORT

const skillRegistrations = []
const fakeSkills = {
  register(skill) {
    skillRegistrations.push(skill)
    return () => {}
  },
  async list() {
    return skillRegistrations.map((s) => ({ name: s.name, provider: s.provider }))
  },
}

const fakeCtx = {
  get(key) {
    if (key === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
        tapIndex(transform) {
          taps.push(transform)
          return () => {}
        },
      }
    }
    if (key === 'skills') return fakeSkills
    return undefined
  },
  effect(fn) {
    return typeof fn === 'function' ? fn() : undefined
  },
}

// 让宿主把允许根设成我们的临时目录：DSH_HOME 指到 TMP 并预写 state.json
process.env.DSH_HOME = TMP
await fsp.mkdir(path.join(TMP, 'dsh-video-prompt'), { recursive: true })
await fsp.writeFile(
  path.join(TMP, 'dsh-video-prompt', 'state.json'),
  JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS }),
  'utf8',
)

const host = await import(pathToFileURL(path.join(PKG, 'index.js')).href)

console.log('\n1) apply() 挂在真 HTTP 服务上')
await host.apply(fakeCtx, { mediaRoot: MEDIA, runsRoot: RUNS, registerSkills: true })
ok('注册了 13 条路由', routes.length === 13, routes.map((r) => r.kind + ' ' + r.path))
for (const expected of ['/dvp/scan', '/dvp/file', '/dvp/image', '/dvp/probe', '/dvp/state', '/dvp/manifest', '/dvp/run', '/dvp/process', '/dvp/source', '/dvp/grok/plan', '/dvp/grok/save', '/dvp/skills/reload']) {
  ok('路由存在 ' + expected, routes.some((r) => r.path === expected), routes.map((r) => r.path))
}

// ── 3. 扫描 ─────────────────────────────────────────────────────────────────
console.log('\n2) /dvp/scan · 图片视频分流')
const scan = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(MEDIA))).json()
const scanNames = (list) => (list || []).map((i) => i.name)
ok('扫描成功', scan.ok === true, scan)
// images/：shot-a.png shot-b.jpg + 4 个新收录格式；books/.../frames/deep.png
ok('图片 7 张（含深层与新增格式）', scan.images && scan.images.length === 7, scanNames(scan.images))
// videos/：clip-one.mp4 + old.mts + clip.ogv
ok('视频 3 个（含 mts/ogv）', scan.videos && scan.videos.length === 3, scanNames(scan.videos))
ok('文本单独归类（notes.md）', scan.texts && scan.texts.some((t) => t.name === 'notes.md'), scanNames(scan.texts))
ok('隐藏目录被跳过', !JSON.stringify(scan).includes('ghost.png'))
ok('分类字段正确', scan.images.every((i) => i.kind === 'image') && scan.videos.every((v) => v.kind === 'video'))
ok('带体积与相对路径', scan.images.every((i) => i.bytes > 0 && typeof i.rel === 'string'))
ok('counts 一致', scan.counts.images === 7 && scan.counts.videos === 3, scan.counts)
// 扩展名收录回归（2026-09-11 用户反馈"格式要都收录进来"）
ok('新收录图片格式全部扫到', ['legacy.jpe', 'cover.svg', 'scan.tiff', 'phone.heic'].every((n) => scanNames(scan.images).includes(n)), scanNames(scan.images))
ok('新收录视频格式全部扫到', ['old.mts', 'clip.ogv'].every((n) => scanNames(scan.videos).includes(n)), scanNames(scan.videos))

const scanDeep = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(TMP) + '&depth=2')).json()
ok('depth=2 能进子目录', scanDeep.ok === true && scanDeep.images.length >= 2, scanDeep.counts)

// 回归：默认 depth（面板不带参数时）必须能进到 images/、videos/ 这一层，
// 否则 mediaboot 摆成 media/images + media/videos 时面板会是空的。
const scanDefault = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(MEDIA))).json()
ok('默认扫描能进到子目录（回归）', scanDefault.ok === true && scanDefault.images.length === 7 && scanDefault.videos.length === 3, scanDefault.counts)
ok('默认 depth 为 4（够到 books/vol1/ch01/frames）', scanDefault.depth === 4, scanDefault.depth)
ok('默认层数能扫到第 4 层深处', scanNames(scanDefault.images).includes('deep.png'), scanNames(scanDefault.images))
const scanShallow = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(MEDIA) + '&depth=1')).json()
ok('层数调浅就看不到深处素材（层数确实生效）', !scanNames(scanShallow.images).includes('deep.png'), scanNames(scanShallow.images))
const scanFlat = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(MEDIA) + '&depth=0')).json()
ok('depth=0 只看这一层', scanFlat.ok === true && scanFlat.images.length === 0 && scanFlat.texts.some((t) => t.name === 'ignore.txt'), scanFlat.counts)
// 面板与宿主的扩展名清单必须一致：不一致就会出现"面板列得出来、宿主不认"
const clientSrc = readFileSync(path.join(PKG, 'client.js'), 'utf8')
const hostSrc = readFileSync(path.join(PKG, 'index.js'), 'utf8')
for (const group of ['IMAGE_EXT', 'VIDEO_EXT', 'TEXT_EXT']) {
  const clientList = (new RegExp('var ' + group + ' = \\[([^\\]]*)\\]').exec(clientSrc) || [])[1] || ''
  const hostList = (new RegExp('const ' + group + ' = new Set\\(\\[([^\\]]*)\\]\\)').exec(hostSrc) || [])[1] || ''
  const norm = (s) => (s.match(/'[^']+'/g) || []).map((x) => x.replace(/'/g, '').replace(/^\./, '')).join(',')
  ok(group + ' 清单两半一致', norm(clientList) !== '' && norm(clientList) === norm(hostList), { client: norm(clientList), host: norm(hostList) })
}

console.log('\n3) 路径围栏')
const outside = await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent('C:/Windows'))
ok('越界目录返回 403', outside.status === 403, outside.status)
const outsideImage = await fetch(BASE + '/dvp/image?path=' + encodeURIComponent('C:/Windows/win.ini'))
ok('越界取文件返回 404/403', outsideImage.status === 404 || outsideImage.status === 403, outsideImage.status)
const nonImage = await fetch(BASE + '/dvp/image?path=' + encodeURIComponent(path.join(MEDIA, 'videos', 'clip-one.mp4')))
ok('非图片扩展名被拒', nonImage.status === 404, nonImage.status)

console.log('\n4) /dvp/image · 真图片字节')
const imageRes = await fetch(BASE + '/dvp/image?path=' + encodeURIComponent(path.join(MEDIA, 'images', 'shot-a.png')))
const imageBytes = Buffer.from(await imageRes.arrayBuffer())
ok('HTTP 200', imageRes.status === 200, imageRes.status)
ok('Content-Type 是 image/png', imageRes.headers.get('content-type') === 'image/png', imageRes.headers.get('content-type'))
ok('字节是合法 PNG（魔数）', imageBytes.length > 8 && imageBytes[0] === 0x89 && imageBytes.subarray(1, 4).toString() === 'PNG', imageBytes.subarray(0, 8).toString('hex'))
ok('字节数与源文件一致', imageBytes.length === PNG_1x1.length, { got: imageBytes.length, want: PNG_1x1.length })

// ── 5. 文本读取 ─────────────────────────────────────────────────────────────
console.log('\n5) /dvp/file · 文本读取')
const fileRes = await (await fetch(BASE + '/dvp/file?path=' + encodeURIComponent(path.join(MEDIA, 'images', 'notes.md')))).json()
ok('读到内容', fileRes.ok === true && fileRes.text.includes('不是媒体'), fileRes)
const missing = await fetch(BASE + '/dvp/file?path=' + encodeURIComponent(path.join(MEDIA, 'images', 'nope.md')))
ok('不存在的文件 404', missing.status === 404, missing.status)
// 回归：产物目录（runsRoot）里的 md 也必须能读。早先围栏只对着 mediaRoot 解析，
// 「按路径加」加产物目录里的章纲会直接报"越界" —— 用户体感就是"识别不了 md"。
await fsp.writeFile(path.join(RUNS, 'outline-ch01.md'), '# 章纲\n雨夜重逢。\n', 'utf8')
const runsFile = await (await fetch(BASE + '/dvp/file?path=' + encodeURIComponent(path.join(RUNS, 'outline-ch01.md')))).json()
ok('产物目录下的 md 可读（围栏覆盖所有允许根）', runsFile.ok === true && runsFile.text.includes('雨夜重逢'), runsFile)
const outsideFile = await fetch(BASE + '/dvp/file?path=' + encodeURIComponent('C:/Windows/win.ini'))
ok('真正越界的文件仍然 404', outsideFile.status === 404, outsideFile.status)

// ── 6. 逐项状态 ─────────────────────────────────────────────────────────────
console.log('\n6) /dvp/manifest · 逐项状态')
const putManifest = await (await fetch(BASE + '/dvp/manifest', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dir: MEDIA, items: { 'shot-a.png': { status: 'ready', at: 'now' } }, runs: [{ kind: 'dispatch', count: 2 }] }),
})).json()
ok('写入成功', putManifest.ok === true, putManifest)
ok('manifest 文件真的落盘', existsSync(path.join(MEDIA, '.dsh-video-prompt', 'manifest.json')))
const getManifest = await (await fetch(BASE + '/dvp/manifest?dir=' + encodeURIComponent(MEDIA))).json()
ok('读回状态正确', getManifest.items && getManifest.items['shot-a.png'] && getManifest.items['shot-a.png'].status === 'ready', getManifest.items)
ok('runs 也保留了', Array.isArray(getManifest.runs) && getManifest.runs.length === 1, getManifest.runs)
const scanAfter = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(MEDIA))).json()
ok('扫描结果带出已存状态', scanAfter.state && scanAfter.state['shot-a.png'] && scanAfter.state['shot-a.png'].status === 'ready', scanAfter.state)

// ── 7. 运行目录 ─────────────────────────────────────────────────────────────
console.log('\n7) /dvp/run · 产物落盘')
const run = await (await fetch(BASE + '/dvp/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    slug: 'probe-run',
    optimizedPrompt: '# 图片提示词\n门廊按铃。\n',
    videoPrompt: '# 视频提示词\n0:00-0:04 门廊。\n',
    request: '派发请求正文',
  }),
})).json()
ok('返回运行目录', run.ok === true && typeof run.runDir === 'string', run)
ok('落在 runsRoot 下', run.ok && run.runDir.startsWith(RUNS), run.runDir)
ok('运行目录名 = 年-月-日_时分-slug（本地时间、精确到分钟）', /\/process|\\process/.test(run.runDir) === false && /\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?-probe-run$/.test(run.runDir), run.runDir)
ok('写了 3 个文件', run.ok && run.written.length === 3, run.written)
ok('图片提示词可读回', run.ok && (await fsp.readFile(path.join(run.runDir, 'optimized-image-prompt.md'), 'utf8')).includes('门廊按铃'))

// ── 7b. 过程目录 ────────────────────────────────────────────────────────────
console.log('\n7b) /dvp/process · 过程目录（拆帧/爆款分析的家）')
const proc1 = await (await fetch(BASE + '/dvp/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: 'probe batch', mode: 'viral' }),
})).json()
ok('建目录成功', proc1.ok === true && typeof proc1.dir === 'string', proc1)
ok('建在 <runsRoot>/process 下', proc1.ok && proc1.dir.startsWith(path.join(RUNS, 'process')), proc1.dir)
ok('目录名 = 年-月-日_时分-slug', /\d{4}-\d{2}-\d{2}_\d{4}-probe-batch(-\d+)?$/.test(path.basename(proc1.dir || '')), path.basename(proc1.dir || ''))
ok('frames 子目录已建好', proc1.ok && existsSync(proc1.frames) && proc1.frames === path.join(proc1.dir, 'frames'), proc1.frames)
ok('爆款路径预建「爆款元素」分析目录', proc1.ok && existsSync(proc1.analysis) && path.basename(proc1.analysis) === '爆款元素', proc1.analysis)
const proc2 = await (await fetch(BASE + '/dvp/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: 'probe batch', mode: 'prompt' }),
})).json()
ok('同分钟重复派发不覆盖（自动加后缀）', proc2.ok === true && proc2.dir !== proc1.dir, { a: proc1.dir, b: proc2.dir })
ok('prompt 路径不建爆款分析目录', proc2.ok && proc2.analysis === undefined, proc2)
ok('过程目录真的存在于磁盘', existsSync(proc2.dir))
const procGet = await fetch(BASE + '/dvp/process')
ok('GET 拒绝（405）', procGet.status === 405, procGet.status)

// ── 8. Grok 链路 ────────────────────────────────────────────────────────────
console.log('\n8) /dvp/grok/* · 批次与图片保存')
const plan = await (await fetch(BASE + '/dvp/grok/plan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grokUrl: 'https://grok.com/',
    processDir: path.join(RUNS, 'process', '2026-09-11_1705-probe-batch'),
    options: { clarity: '8K电影级+胶片颗粒', aspect: '2:3 竖版', count: '2', evil: '注入' },
    source: { text: '第一章\n\n林晚在雨里按响门铃，门后站着她的前夫。' },
    entries: [
      { index: 1, title: '门廊按铃', slug: 'men-lang', prompt: '一位东亚女性站在深色木门前……', source: 'shot-a.png' },
      { index: 2, title: '荧光药剂', slug: 'ying-guang', prompt: '同一人物举起小瓶，青绿光自下而上……', source: 'shot-b.jpg' },
    ],
  }),
})).json()
ok('批次落盘成功', plan.ok === true && plan.count === 2, plan)
ok('plan.json 存在', plan.ok && existsSync(plan.planFile), plan.planFile)
ok('driver.md 存在', plan.ok && existsSync(plan.driverFile), plan.driverFile)
const driverText = await fsp.readFile(plan.driverFile, 'utf8')
ok('driver.md 含两条提示词', driverText.includes('门廊按铃') && driverText.includes('荧光药剂'))
ok('driver.md 写明落盘文件名', driverText.includes('01-men-lang.png'))
ok('生图要求进 plan.json', plan.options && plan.options.clarity === '8K电影级+胶片颗粒' && plan.options.aspect === '2:3 竖版' && plan.options.count === '2', plan.options)
ok('白名单外的选项被丢掉', plan.options && plan.options.evil === undefined, plan.options)
ok('生图要求进 driver.md（人读得到）', driverText.includes('生图要求') && driverText.includes('8K电影级+胶片颗粒') && driverText.includes('2:3 竖版'))
ok('画幅要求写明要切页面比例按钮', driverText.includes('画幅比例切到 2:3 竖版'))
ok('driver.md 带上过程目录（拆帧/草稿写这里）', driverText.includes('过程目录') && driverText.includes('2026-09-11_1705-probe-batch'), driverText.slice(0, 400))
ok('来源文本落盘（不进 plan.json 正文）', typeof plan.sourceFile === 'string' && existsSync(plan.sourceFile), plan.sourceFile)
ok('来源文本内容可读回', plan.sourceFile && (await fsp.readFile(plan.sourceFile, 'utf8')).includes('林晚在雨里按响门铃'))
ok('driver.md 指向来源文本文件', driverText.includes(plan.sourceFile))
const planOnDisk = JSON.parse(await fsp.readFile(plan.planFile, 'utf8'))
ok('plan.json 里只有来源文件路径、没有正文', typeof planOnDisk.sourceFile === 'string' && planOnDisk.sourceFile !== '' && planOnDisk.source === undefined, Object.keys(planOnDisk))

// ── 8b. 来源文本单独落盘 ────────────────────────────────────────────────────
console.log('\n8b) /dvp/source · 来源文本落盘')
const srcPut = await (await fetch(BASE + '/dvp/source', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '# 章纲\n1. 重逢\n2. 背叛\n', label: 'book-42' }),
})).json()
ok('落盘成功', srcPut.ok === true && existsSync(srcPut.file), srcPut)
ok('落在 runsRoot/source 下', srcPut.ok && srcPut.file.startsWith(path.join(RUNS, 'source')), srcPut.file)
ok('文件名用 label 且是 .md', srcPut.ok && path.basename(srcPut.file) === 'book-42.md', srcPut.file)
ok('内容一致', srcPut.ok && (await fsp.readFile(srcPut.file, 'utf8')).includes('重逢'))
const srcEmpty = await fetch(BASE + '/dvp/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '   ' }) })
ok('空文本被拒 400', srcEmpty.status === 400, srcEmpty.status)

const save1 = await (await fetch(BASE + '/dvp/grok/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ index: 1, slug: 'men-lang', base64: 'data:image/png;base64,' + PNG_1x1.toString('base64'), note: 'probe' }),
})).json()
ok('base64 图片保存成功', save1.ok === true && save1.bytes === PNG_1x1.length, save1)
ok('文件名按序号+slug 命名', save1.ok && path.basename(save1.file) === '01-men-lang.png', save1.file)
ok('落盘字节正确', save1.ok && (await fsp.readFile(save1.file)).equals(PNG_1x1))
const ledger = JSON.parse(await fsp.readFile(path.join(MEDIA, 'grok-output', 'ledger.json'), 'utf8'))
ok('ledger 记账 1 条', ledger.items.length === 1 && ledger.items[0].slug === 'men-lang', ledger.items)

const getPlan = await (await fetch(BASE + '/dvp/grok/plan')).json()
ok('批次可读回', getPlan.plan && getPlan.plan.count === 2, getPlan.plan && getPlan.plan.count)

// ── 9. 状态读写 ─────────────────────────────────────────────────────────────
console.log('\n9) /dvp/state · 配置与技能清单')
const stateGet = await (await fetch(BASE + '/dvp/state')).json()
ok('返回默认目录', stateGet.ok === true && stateGet.defaults.mediaRoot === MEDIA, stateGet.defaults)
ok('返回技能清单', Array.isArray(stateGet.skills) && stateGet.skills.length === 6, stateGet.skills)
const statePut = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS, grokOptions: { clarity: '2K', aspect: '9:16 全竖', count: '4', junk: 'x' } }),
})).json()
ok('改写配置成功', statePut.ok === true, statePut)
ok('生图要求被记住', statePut.ok && statePut.state.grokOptions && statePut.state.grokOptions.clarity === '2K' && statePut.state.grokOptions.aspect === '9:16 全竖', statePut.state && statePut.state.grokOptions)
ok('生图要求里白名单外的键被丢掉', statePut.ok && statePut.state.grokOptions.junk === undefined, statePut.state && statePut.state.grokOptions)
const stateGet2 = await (await fetch(BASE + '/dvp/state')).json()
ok('重新读回还在（面板下次打开就是它）', stateGet2.state.grokOptions && stateGet2.state.grokOptions.count === '4', stateGet2.state.grokOptions)
const statePutBad = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS, grokOptions: { clarity: '不存在档位' } }),
})).json()
ok('非法档位不会覆盖已存值', statePutBad.ok === true && statePutBad.state.grokOptions && statePutBad.state.grokOptions.clarity === '2K', statePutBad.state && statePutBad.state.grokOptions)
// 旧档位名（4K标准 / 8K电影级 / 2K快出）已被新档位替换，写了也不该被采纳
const statePutOld = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS, grokOptions: { clarity: '4K标准' } }),
})).json()
ok('旧档位名不再被采纳（白名单同步过）', statePutOld.ok === true && statePutOld.state.grokOptions.clarity === '2K', statePutOld.state && statePutOld.state.grokOptions)
const statePutLow = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS, grokOptions: { clarity: '720p' } }),
})).json()
ok('新增的省额度档位 720p 被采纳', statePutLow.ok === true && statePutLow.state.grokOptions.clarity === '720p', statePutLow.state && statePutLow.state.grokOptions)
// 流水线路径（prompt / viral）也要能记住，脏值不覆盖
const statePutViral = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pipelineMode: 'viral' }),
})).json()
ok('路径切到 viral 被记住', statePutViral.ok === true && statePutViral.state.pipelineMode === 'viral', statePutViral.state && statePutViral.state.pipelineMode)
const statePutModeBad = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pipelineMode: 'rm -root' }),
})).json()
ok('非法路径值不覆盖已存档', statePutModeBad.ok === true && statePutModeBad.state.pipelineMode === 'viral', statePutModeBad.state && statePutModeBad.state.pipelineMode)

// ── 10. 静态预览 ────────────────────────────────────────────────────────────
console.log('\n10) /dvp/preview · 静态预览页')
const preview = await fetch(BASE + '/dvp/preview/')
ok('预览页 200', preview.status === 200, preview.status)
ok('是 HTML', (preview.headers.get('content-type') || '').includes('text/html'), preview.headers.get('content-type'))
const previewBody = await preview.text()
ok('引用了 client.js 与 React', previewBody.includes('./client.js') && previewBody.includes('./react.production.min.js'))
const previewClient = await fetch(BASE + '/dvp/preview/client.js')
ok('client.js 可取', previewClient.status === 200 && (previewClient.headers.get('content-type') || '').includes('javascript'), previewClient.status)
const escape = await fetch(BASE + '/dvp/preview/../../index.js')
ok('预览路径不能穿越（403/404）', escape.status === 403 || escape.status === 404, escape.status)

// ── 11. 技能注册 ────────────────────────────────────────────────────────────
console.log('\n11) ctx.skills.register · 技能注册内容')
ok('注册了 6 个技能', skillRegistrations.length === 6, skillRegistrations.map((s) => s.name))
const names = skillRegistrations.map((s) => s.name).sort()
ok('技能名齐全', JSON.stringify(names) === JSON.stringify(['oneshot-prompt-generator', 'prompt-videos', 'video-generation', 'video-prompt-pipeline', 'viral-media-copywriter', 'watch']), names)
ok('provider 标记为本插件', skillRegistrations.every((s) => s.provider === 'dsh-video-prompt'))
ok('resourceBase 指向包内真目录', skillRegistrations.every((s) => s.resourceBase && existsSync(s.resourceBase.path)), skillRegistrations.map((s) => s.resourceBase && s.resourceBase.path))
ok('正文非空且不含 frontmatter', skillRegistrations.every((s) => s.content.length > 200 && !s.content.startsWith('---')), skillRegistrations.map((s) => s.content.length))
ok('description 非空', skillRegistrations.every((s) => typeof s.description === 'string' && s.description.length > 10))
ok('watch 的正文提到 ffmpeg（真身而非摘要）', (skillRegistrations.find((s) => s.name === 'watch').content || '').includes('ffmpeg'))
// 2026-09-11 合并回归：三个新包择优进底座后这两条必须成立
const vpp = skillRegistrations.find((s) => s.name === 'video-prompt-pipeline')
ok('video-prompt-pipeline 是「视频复刻」版且含 Phase 3 参考图流程', vpp !== undefined && vpp.description.includes('视频复刻') && vpp.content.includes('Phase 3'), vpp && vpp.description.slice(0, 60))
const vmc = skillRegistrations.find((s) => s.name === 'viral-media-copywriter')
ok('viral-media-copywriter（爆款素材模型）随包注册', vmc !== undefined && vmc.content.includes('原子线索') && vmc.content.includes('inventory_media.py'), vmc && vmc.content.length)
ok('其 references/scripts 相对 resourceBase 是通的', vmc !== undefined && vmc.resourceBase && existsSync(path.join(vmc.resourceBase.path, 'references', 'element-schema.md')) && existsSync(path.join(vmc.resourceBase.path, 'scripts', 'inventory_media.py')))

// ── 12. 技能包热重扫（开机后新增技能免重启）─────────────────────────────────
console.log('\n12) /dvp/skills/reload · 技能包热重扫')
const reloadGet = await fetch(BASE + '/dvp/skills/reload')
ok('GET 拒绝（405）', reloadGet.status === 405, reloadGet.status)
const reloaded = await (await fetch(BASE + '/dvp/skills/reload', { method: 'POST' })).json()
ok('重扫成功', reloaded.ok === true, reloaded)
ok('全部 6 个已在册 → added 为空', Array.isArray(reloaded.added) && reloaded.added.length === 0 && (reloaded.alreadyRegistered || []).length === 6, reloaded)
ok('回包带 first-wins 说明', typeof reloaded.note === 'string' && reloaded.note.includes('重启'), reloaded.note)
// 假技能服务不做 first-wins，重复 register 会多记；真服务里这一步只是 no-op。
ok('重扫确实重新走了一遍注册（假服务计数 ×2）', skillRegistrations.length === 12, skillRegistrations.length)

// ── 收尾 ────────────────────────────────────────────────────────────────────
server.close()
await fsp.rm(TMP, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过：' + checks + ' 项检查' : failures + ' / ' + checks + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
