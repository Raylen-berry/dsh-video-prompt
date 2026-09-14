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

// 另起一个独立宿主实例（自己的 state.json / mediaRoot），用来验"盘上只有旧布局"这类
// 换一个 mediaRoot 才说得清的场景。同一个 index.js 模块被 apply 两次是安全的：
// 根目录在 apply 时按 state/config 解析一次，两次互不影响。
const extraServers = []
async function startExtraHost(mediaDir, runsDir) {
  const stateBackup = process.env.DSH_HOME
  const previous = await fsp.readFile(path.join(TMP, 'dsh-video-prompt', 'state.json'), 'utf8').catch(() => '{}')
  process.env.DSH_HOME = TMP
  await fsp.writeFile(path.join(TMP, 'dsh-video-prompt', 'state.json'), JSON.stringify({ mediaRoot: mediaDir, runsRoot: runsDir }), 'utf8')
  const extraRoutes = []
  const extraCtx = {
    get(key) {
      if (key === 'webServer') {
        return {
          register(route) {
            extraRoutes.push(route)
            return () => {}
          },
          tapIndex() {
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return typeof fn === 'function' ? fn() : undefined
    },
  }
  const extraServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = extraRoutes.find((r) => (r.kind === 'exact' ? r.path === url.pathname : url.pathname.startsWith(r.path)))
    if (route === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '无路由匹配' }))
      return
    }
    await route.handler(req, res)
  })
  await host.apply(extraCtx, { mediaRoot: mediaDir, runsRoot: runsDir, registerSkills: false })
  await new Promise((resolve) => extraServer.listen(0, '127.0.0.1', resolve))
  // 复原走宿主自己的 state.json 通道，避免污染主链路
  await fsp.writeFile(path.join(TMP, 'dsh-video-prompt', 'state.json'), previous, 'utf8')
  process.env.DSH_HOME = stateBackup
  extraServers.push(extraServer)
  return extraServer.address().port
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

// nonce 必须带上（/dvp/grok/save 门②）：建批次时宿主发下来的 saveNonce 就在 plan 响应里。
ok('批次响应带 saveNonce（存图要用的那把钥匙）', typeof plan.saveNonce === 'string' && plan.saveNonce.length >= 32, plan.saveNonce)
const save1 = await (await fetch(BASE + '/dvp/grok/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ index: 1, slug: 'men-lang', base64: 'data:image/png;base64,' + PNG_1x1.toString('base64'), note: 'probe', nonce: plan.saveNonce }),
})).json()
ok('base64 图片保存成功', save1.ok === true && save1.bytes === PNG_1x1.length, save1)
ok('文件名按序号+slug 命名', save1.ok && path.basename(save1.file) === '01-men-lang.png', save1.file)
ok('落盘字节正确', save1.ok && (await fsp.readFile(save1.file)).equals(PNG_1x1))
ok('图片落进批次目录（不是 grok-output 根下）', save1.ok && path.dirname(save1.file) === plan.dir, { file: save1.file, planDir: plan.dir })
ok('save 回带 batchId，与批次一致', save1.batchId === plan.batchId, { save: save1.batchId, plan: plan.batchId })
const ledger = JSON.parse(await fsp.readFile(path.join(plan.dir, 'ledger.json'), 'utf8'))
ok('ledger 记账 1 条', ledger.items.length === 1 && ledger.items[0].slug === 'men-lang', ledger.items)

const getPlan = await (await fetch(BASE + '/dvp/grok/plan')).json()
ok('批次可读回', getPlan.plan && getPlan.plan.count === 2, getPlan.plan && getPlan.plan.count)

// ── 8c. Grok 批次隔离（P1：不同批次曾经共用一个目录，plan.json/成图互相覆盖）────
// 旧写法把 plan.json / driver.md / source-*.md / <序号>-<slug>.<ext> 全写进 grok-output 根下，
// 新批次直接盖掉上一批，而 ledger.json 是**追加**的 —— 账本上两条批次、盘上只剩最后一批。
console.log('\n8c) /dvp/grok/* · 每批一个目录（不互相覆盖）')

const batchBody = (title, sourceText) => ({  grokUrl: 'https://grok.com/',
  // 故意同名 slug：旧布局下两批会写进同一个 plan.json / 同一个目录
  slug: 'same-name',
  entries: [{ index: 1, title, slug: 'same-slug', prompt: '提示词 ' + title }],
  source: { text: sourceText, file: 'same-source.txt' },
})
const post = (body) => fetch(BASE + '/dvp/grok/plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())
const put = (body) => fetch(BASE + '/dvp/grok/plan', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json())

// ① 两个同名批次先后写入 ⇒ 各自 plan.json 独立、互不覆盖
const batchA = await post(batchBody('第一批', '第一批正文'))
const batchB = await post(batchBody('第二批', '第二批正文'))
ok('① 同名批次分到两个目录', batchA.ok && batchB.ok && batchA.dir !== batchB.dir, { a: batchA.dir, b: batchB.dir })
ok('① batchId 带本地时间戳 + slug', /^\d{4}-\d{2}-\d{2}_\d{4}-same-name(-\d+)?$/.test(batchA.batchId || ''), batchA.batchId)
ok('① 两个批次目录都真的建好了', existsSync(batchA.dir) && existsSync(batchB.dir))
ok('① 两个批次都在 grok-output 的子目录里', batchA.dir.startsWith(path.join(MEDIA, 'grok-output') + path.sep) && batchB.dir.startsWith(path.join(MEDIA, 'grok-output') + path.sep))
const planA = JSON.parse(await fsp.readFile(path.join(batchA.dir, 'plan.json'), 'utf8'))
const planB = JSON.parse(await fsp.readFile(path.join(batchB.dir, 'plan.json'), 'utf8'))
ok('① 各自 plan.json 内容正确（互不覆盖）', planA.entries[0].title === '第一批' && planB.entries[0].title === '第二批', [planA.entries[0].title, planB.entries[0].title])
ok('① plan.json 里记着自己的 batchId', planA.batchId === batchA.batchId && planB.batchId === batchB.batchId)
ok('① 同名来源文件各自独立（不互相盖）', planA.sourceFile === path.join(batchA.dir, 'source-same-source.md') && planB.sourceFile === path.join(batchB.dir, 'source-same-source.md')
  && (await fsp.readFile(planA.sourceFile, 'utf8')) === '第一批正文' && (await fsp.readFile(planB.sourceFile, 'utf8')) === '第二批正文')
ok('① driver.md 也在各自目录里', existsSync(path.join(batchA.dir, 'driver.md')) && existsSync(path.join(batchB.dir, 'driver.md')))
ok('① 老位置不再被写（grok-output 根下没有 plan.json）', !existsSync(path.join(MEDIA, 'grok-output', 'plan.json')))
// 两批各存一张**同 slug 的真图**（门③要求确实是图片字节；PNG 尾部塞一段私有 tEXt 让两批字节可区分）。
const pngWithText = (text) => {
  const body = Buffer.from('tEXt' + text, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length - 4, 0)
  return Buffer.concat([PNG_1x1, len, body, Buffer.alloc(4)])
}
const imgBytesA = pngWithText('first-batch')
const imgBytesB = pngWithText('second-batch')
const saveA = await (await fetch(BASE + '/dvp/grok/save', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchId: batchA.batchId, index: 1, slug: 'same-slug', ext: '.png', base64: 'data:image/png;base64,' + imgBytesA.toString('base64'), nonce: batchA.saveNonce }),
})).json()
const saveB = await (await fetch(BASE + '/dvp/grok/save', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchId: batchB.batchId, index: 1, slug: 'same-slug', ext: '.png', base64: 'data:image/png;base64,' + imgBytesB.toString('base64'), nonce: batchB.saveNonce }),
})).json()
ok('① 同名 slug 的图分别落在各自批次目录', saveA.ok && saveB.ok && saveA.file !== saveB.file
  && path.dirname(saveA.file) === batchA.dir && path.dirname(saveB.file) === batchB.dir, { a: saveA.file, b: saveB.file })
ok('① 两张图字节各自正确（没被覆盖）', (await fsp.readFile(saveA.file)).equals(imgBytesA) && (await fsp.readFile(saveB.file)).equals(imgBytesB))
const ledgerA = JSON.parse(await fsp.readFile(path.join(batchA.dir, 'ledger.json'), 'utf8'))
const ledgerB = JSON.parse(await fsp.readFile(path.join(batchB.dir, 'ledger.json'), 'utf8'))
ok('① 账本按批分开，且条目都指向本批产物', ledgerA.items.length === 1 && ledgerB.items.length === 1
  && ledgerA.items[0].file === saveA.file && ledgerB.items[0].file === saveB.file
  && ledgerA.batchId === batchA.batchId && ledgerB.batchId === batchB.batchId)

// ② 传 batchId 重试 ⇒ 写回同一目录，不新建
const dirsBefore = (await fsp.readdir(path.join(MEDIA, 'grok-output'), { withFileTypes: true })).filter((e) => e.isDirectory()).length
const retryA = await put({ ...batchBody('第一批重试', '第一批正文v2'), batchId: batchA.batchId })
const dirsAfter = (await fsp.readdir(path.join(MEDIA, 'grok-output'), { withFileTypes: true })).filter((e) => e.isDirectory()).length
ok('② 重试写回同一目录', retryA.ok === true && retryA.dir === batchA.dir && retryA.batchId === batchA.batchId, { before: batchA.dir, after: retryA.dir })
ok('② 没有新建目录', dirsAfter === dirsBefore, { before: dirsBefore, after: dirsAfter })
ok('② 重试后的 plan.json 是新的（原地更新）', JSON.parse(await fsp.readFile(path.join(batchA.dir, 'plan.json'), 'utf8')).entries[0].title === '第一批重试')
ok('② 重试没碰另一批', JSON.parse(await fsp.readFile(path.join(batchB.dir, 'plan.json'), 'utf8')).entries[0].title === '第二批')
ok('② 传 dir（旧调用方口径）也认得出批次', (await put({ ...batchBody('按dir重试', 'x'), dir: batchB.dir })).dir === batchB.dir)

// ③ 最新一批：在②之后新建（最新 = 最后写的那一批，不依赖同一秒内的 mtime 赛跑）
const batchC = await post(batchBody('第三批', '第三批正文'))
ok('③ 新建批次拿到新目录', batchC.ok === true && batchC.dir !== batchA.dir && batchC.dir !== batchB.dir)
const latest = await (await fetch(BASE + '/dvp/grok/plan')).json()
ok('③ 不传参拿到最新批次', latest.plan !== null && latest.batchId === batchC.batchId, { got: latest.batchId, want: batchC.batchId })
ok('③ 响应保留 dir / plan 字段名', typeof latest.dir === 'string' && latest.plan !== null && latest.plan.batchId === latest.batchId)
ok('③ 最新批次的 plan 是第三批（不是被覆盖的旧批）', latest.plan.entries[0].title === '第三批', latest.plan.entries[0].title)
const picked = await (await fetch(BASE + '/dvp/grok/plan?batch=' + encodeURIComponent(batchB.batchId))).json()
ok('③ ?batch= 读到指定批次（正是那一批的内容）', picked.batchId === batchB.batchId && picked.plan.entries[0].title === '按dir重试', { got: picked.batchId, title: picked.plan && picked.plan.entries[0].title })
const pickedA = await (await fetch(BASE + '/dvp/grok/plan?batch=' + encodeURIComponent(batchA.batchId))).json()
ok('③ ?batch= 读得到被重试过的那批（重试后的内容）', pickedA.batchId === batchA.batchId && pickedA.plan.entries[0].title === '第一批重试', pickedA.plan && pickedA.plan.entries[0].title)
ok('③ 响应带批次清单便于对齐账本', Array.isArray(latest.batches) && [batchA, batchB, batchC].every((b) => latest.batches.includes(b.batchId)), latest.batches)

// ④ 旧布局兼容：预先放在 grok-output 根下的 plan.json 仍读得到（算一个历史批次）
// 把它的 mtime 显式压到一年前：这样"最新一批"的判定不会被"测试刚好刚写了这个文件"干扰，
// 也能真的验到"索引缺失时回退 mtime"这条路径（旧布局天然比新批次旧，不该被当成最新）。
const legacyRoot = path.join(MEDIA, 'grok-output')
const legacyPlan = { createdAt: '2026-09-10T00:00:00.000Z', dir: legacyRoot, count: 1, entries: [{ index: 1, title: '旧批次', slug: 'old', prompt: '旧提示词' }] }
await fsp.writeFile(path.join(legacyRoot, 'plan.json'), JSON.stringify(legacyPlan, null, 2), 'utf8')
const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
await fsp.utimes(path.join(legacyRoot, 'plan.json'), longAgo, longAgo)
const legacyRead = await (await fetch(BASE + '/dvp/grok/plan?batch=legacy')).json()
ok('④ 混合布局下 ?batch=legacy 读得到旧布局', legacyRead.plan !== null && legacyRead.plan.entries[0].title === '旧批次', legacyRead)
ok('④ 旧布局标为 legacy，dir 仍是原来那个目录', legacyRead.legacy === true && legacyRead.dir === legacyRoot, { legacy: legacyRead.legacy, dir: legacyRead.dir })
const legacyWrite = await fetch(BASE + '/dvp/grok/plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...batchBody('x', 'y'), batchId: 'legacy' }),
})
ok('④ legacy 别名拒绝写入（400）', legacyWrite.status === 400, legacyWrite.status)
// 更干净的一条链路：盘上**只有**旧布局（没有任何批次子目录）时，不传参的 GET 必须还能读到它
const LEGACY_MEDIA = path.join(TMP, 'media-legacy')
const LEGACY_RUNS = path.join(TMP, 'runs-legacy')
await fsp.mkdir(path.join(LEGACY_MEDIA, 'grok-output'), { recursive: true })
await fsp.mkdir(LEGACY_RUNS, { recursive: true })
await fsp.writeFile(path.join(LEGACY_MEDIA, 'grok-output', 'plan.json'), JSON.stringify({ ...legacyPlan, dir: path.join(LEGACY_MEDIA, 'grok-output') }, null, 2), 'utf8')
const legacyPort = await startExtraHost(LEGACY_MEDIA, LEGACY_RUNS)
const legacyBase = 'http://127.0.0.1:' + legacyPort
const onlyLegacy = await (await fetch(legacyBase + '/dvp/grok/plan')).json()
ok('④ 只有旧布局时，不传参仍读到 plan（老数据不丢）', onlyLegacy.plan !== null && onlyLegacy.plan.entries[0].title === '旧批次', onlyLegacy)
ok('④ 它被标成 legacy 且 dir 指向原位置', onlyLegacy.legacy === true && onlyLegacy.dir === path.join(LEGACY_MEDIA, 'grok-output'))
const legacyNew = await (await fetch(legacyBase + '/dvp/grok/plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batchBody('新批次不写老位置', 'x')),
})).json()
ok('④ 新批次写进子目录，不覆盖旧布局', legacyNew.ok === true && legacyNew.dir !== path.join(LEGACY_MEDIA, 'grok-output')
  && legacyNew.dir.startsWith(path.join(LEGACY_MEDIA, 'grok-output') + path.sep))
ok('④ 旧布局 plan.json 内容没被动过', JSON.parse(await fsp.readFile(path.join(LEGACY_MEDIA, 'grok-output', 'plan.json'), 'utf8')).entries[0].title === '旧批次')
const legacyStill = await (await fetch(legacyBase + '/dvp/grok/plan?batch=legacy')).json()
ok('④ 写完新批次后旧布局仍读得到（?batch=legacy）', legacyStill.plan !== null && legacyStill.plan.entries[0].title === '旧批次')

// ⑤ 路径越界仍被拒（沿用既有 allowAny 口径）
for (const bad of ['../evil', '..\\evil', 'a/b', '/etc/passwd', 'C:\\Windows\\Temp', '..']) {
  const response = await fetch(BASE + '/dvp/grok/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...batchBody('x', 'y'), batchId: bad }),
  })
  ok('⑤ 越界 batchId 被拒：' + bad, response.status === 400, response.status)
}
const badGet = await fetch(BASE + '/dvp/grok/plan?batch=' + encodeURIComponent('../evil'))
ok('⑤ GET 越界 batch 被拒 400', badGet.status === 400, badGet.status)
const badSave = await fetch(BASE + '/dvp/grok/save', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchId: '../evil', index: 1, slug: 'x', base64: 'data:image/png;base64,' + PNG_1x1.toString('base64'), nonce: plan.saveNonce }),
})
ok('⑤ save 越界 batchId 被拒 400', badSave.status === 400, badSave.status)
ok('⑤ 越界没有在 grok-output 之外留下任何东西', !existsSync(path.join(TMP, 'evil')) && !existsSync(path.join(MEDIA, 'evil')))

// 索引：轻量、可缺失、可损坏，坏了不影响读批次（fetch 不传参仍要拿得到最新一批）
const indexFile = path.join(MEDIA, 'grok-output', 'index.json')
ok('索引写出了最新批次', existsSync(indexFile) && JSON.parse(await fsp.readFile(indexFile, 'utf8')).latest === batchC.batchId)
await fsp.writeFile(indexFile, '{ 坏掉的 json', 'utf8')
const afterBroken = await (await fetch(BASE + '/dvp/grok/plan')).json()
ok('索引损坏后仍能读回最新批次', afterBroken.plan !== null && afterBroken.batchId === batchC.batchId, afterBroken.batchId)
await fsp.rm(indexFile, { force: true })
const afterMissing = await (await fetch(BASE + '/dvp/grok/plan')).json()
ok('索引缺失后仍能读回最新批次（回退到目录 mtime）', afterMissing.plan !== null && afterMissing.batchId !== '', afterMissing.batchId)
const newAfterIndexLoss = await post({ ...batchBody('索引丢失后新建', 'z') })
ok('索引缺失时新建批次照常', newAfterIndexLoss.ok === true && existsSync(path.join(newAfterIndexLoss.dir, 'plan.json')))

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

// ── 13. 局部保存设置不能丢掉未提交字段（P2：只改流水线模式就把两个根清空）──────
console.log('\n13) /dvp/state · 只提交一个字段不覆盖别的字段')
const stateBefore = JSON.parse(await fsp.readFile(path.join(TMP, 'dsh-video-prompt', 'state.json'), 'utf8'))
ok('前置：state.json 里两个根都在', typeof stateBefore.mediaRoot === 'string' && typeof stateBefore.runsRoot === 'string', stateBefore)
await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS, pipelineMode: 'prompt' }),
})
// 面板切「路径」下拉时**只提交一个字段**（client.js: onChange → PUT {pipelineMode}）
const onlyMode = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pipelineMode: 'viral' }),
})).json()
ok('只提交 pipelineMode：返回态里两个根没被 undefined 覆盖',
  typeof onlyMode.state.mediaRoot === 'string' && typeof onlyMode.state.runsRoot === 'string', onlyMode.state)
const stateAfter = JSON.parse(await fsp.readFile(path.join(TMP, 'dsh-video-prompt', 'state.json'), 'utf8'))
ok('盘上的 state.json 也没被覆盖（写盘才是真证据）',
  typeof stateAfter.mediaRoot === 'string' && typeof stateAfter.runsRoot === 'string', stateAfter)
ok('提交的字段确实生效了', onlyMode.state.pipelineMode === 'viral' && stateAfter.pipelineMode === 'viral')
// 反过来：只提交目录，已存的流水线模式不能被吞掉
const onlyFolders = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS }),
})).json()
ok('只提交目录：已存的 pipelineMode 不被吞掉', onlyFolders.state.pipelineMode === 'viral', onlyFolders.state)
// 明确清空（null）不能写成字面 null，要真的回落到"配置里的根"
const cleared = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runsRoot: null }),
})).json()
ok('null 是"明确清空"，不是字面量写进 state', cleared.state.runsRoot === undefined, cleared.state)
ok('清空后运行期回落到 config 给的根（不是字面 null、也不动另一个根）',
  cleared.effective !== undefined && cleared.effective.runsRoot === RUNS && cleared.effective.mediaRoot === MEDIA, cleared.effective)
const restored = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS }),
})).json()
ok('重新写回目录成功（后续段落继续用临时目录）',
  restored.effective !== undefined && restored.effective.mediaRoot === MEDIA && restored.effective.runsRoot === RUNS, restored.effective)

// ── 14. 保存新目录后，后续保存真的落新目录 ──────────────────────────────────
// 运行时路径原来只在 apply() 里解析一次，于是"保存新产物目录"成功后，写盘的每条路由
// 仍然打旧目录 —— 用户换个盘，产物却还落在老地方。
console.log('\n14) /dvp/state · 保存新目录后同步刷新运行配置')
const NEW_RUNS = path.join(TMP, 'runs-moved')
const NEW_MEDIA = path.join(TMP, 'media-moved')
await fsp.mkdir(NEW_RUNS, { recursive: true })
await fsp.mkdir(NEW_MEDIA, { recursive: true })
const moved = await (await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaRoot: NEW_MEDIA, runsRoot: NEW_RUNS }),
})).json()
ok('保存返回当前实际生效路径', moved.ok === true && moved.effective && moved.effective.mediaRoot === NEW_MEDIA && moved.effective.runsRoot === NEW_RUNS, moved.effective)
// 落点判断一律走这个助手：字段缺失时要判失败，不是抛错（断言脚本自己崩了就没法归因）
const under = (value, root) => typeof value === 'string' && value.startsWith(root + path.sep)
const movedSource = await (await fetch(BASE + '/dvp/source', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '# 新目录章纲\n1. 换盘\n', label: 'moved-book' }),
})).json()
ok('保存新目录后，来源文本落进新目录（不是旧目录）',
  movedSource.ok === true && under(movedSource.file, NEW_RUNS) && existsSync(String(movedSource.file)),
  { file: movedSource.file, want: NEW_RUNS })
const movedProc = await (await fetch(BASE + '/dvp/process', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'moved', mode: 'prompt' }),
})).json()
ok('过程目录也落新目录', movedProc.ok === true && under(movedProc.dir, NEW_RUNS), movedProc.dir)
const movedRun = await (await fetch(BASE + '/dvp/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'moved', optimizedPrompt: '# 新目录\n' }),
})).json()
ok('运行目录也落新目录', movedRun.ok === true && under(movedRun.runDir, NEW_RUNS), movedRun.runDir)
const movedScan = await (await fetch(BASE + '/dvp/scan?path=' + encodeURIComponent(NEW_MEDIA))).json()
ok('新媒体目录立即可用（围栏跟着刷新）', movedScan.ok === true, movedScan)
const movedGrok = await (await fetch(BASE + '/dvp/grok/plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: 'moved-batch', entries: [{ index: 1, title: 'x', slug: 'x', prompt: 'y' }] }),
})).json()
ok('Grok 批次也落新媒体目录', movedGrok.ok === true && under(movedGrok.dir, path.join(NEW_MEDIA, 'grok-output')), movedGrok.dir)
// 收尾：把运行配置还原到主链路用的临时目录（后面 12 段的热重扫还在用）
await fetch(BASE + '/dvp/state', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS }),
})

// ── 15. 派发历史：追加去重、保留最近 N 条 ───────────────────────────────────
// 面板每次只提交最新一条 run，宿主直接覆盖会让历史里只剩最后一次派发。
console.log('\n15) /dvp/manifest · 派发历史追加与去重')
const HIST_DIR = path.join(TMP, 'media-hist')
await fsp.mkdir(HIST_DIR, { recursive: true })
const putRun = (run) => fetch(BASE + '/dvp/manifest', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: HIST_DIR, items: {}, runs: run ? [run] : undefined }),
}).then((r) => r.json()).then(async (json) => ({ ...json, read: await (await fetch(BASE + '/dvp/manifest?dir=' + encodeURIComponent(HIST_DIR))).json() }))
const runA = { id: 'run-A', at: '2026-09-14T10:00:00.000Z', kind: 'dispatch', count: 2, processDir: path.join(RUNS, 'process', 'a') }
const runB = { id: 'run-B', at: '2026-09-14T10:05:00.000Z', kind: 'dispatch', count: 3, processDir: path.join(RUNS, 'process', 'b') }
await putRun(runA)
const histB = await putRun(runB)
const runsOf = (payload) => (Array.isArray(payload.runs) ? payload.runs : [])
ok('A 之后提交 B：两条都在', runsOf(histB.read).length === 2, histB.read.runs)
ok('顺序正确（先 A 后 B）', runsOf(histB.read).length === 2 && runsOf(histB.read)[0].id === 'run-A' && runsOf(histB.read)[1].id === 'run-B', runsOf(histB.read).map((r) => r.id))
ok('响应里带回条数便于核对', histB.runCount === 2, histB.runCount)
const histAgain = await putRun(runB)
ok('重复提交同 ID 不产生第二条', runsOf(histAgain.read).length === 2 && runsOf(histAgain.read)[1].id === 'run-B', runsOf(histAgain.read).map((r) => r.id))
// 旧调用方（没有 id）：退到 at|kind|processDir 指纹去重
const legacyRun = { at: '2026-09-14T10:10:00.000Z', kind: 'dispatch', count: 1, processDir: path.join(RUNS, 'process', 'c') }
await putRun(legacyRun)
const histLegacy = await putRun(legacyRun)
ok('没有 id 的旧记录按指纹去重', runsOf(histLegacy.read).length === 3, runsOf(histLegacy.read).map((r) => r.id || r.at))
// 上限：并发写会互相盖，所以这里串行提交 34 条
for (let i = 0; i < 34; i += 1) {
  await putRun({ id: 'run-N' + i, at: '2026-09-14T11:00:00.000Z', kind: 'dispatch', count: i, processDir: path.join(RUNS, 'process', 'n' + i) })
}
const histBig = await (await fetch(BASE + '/dvp/manifest?dir=' + encodeURIComponent(HIST_DIR))).json()
const bigRuns = runsOf(histBig)
ok('历史有上限（30 条）', bigRuns.length === 30, bigRuns.length)
ok('保留的是最近若干条（最后一条是新提交的）', bigRuns.length > 0 && bigRuns[bigRuns.length - 1].id === 'run-N33', bigRuns[bigRuns.length - 1])
ok('最早的那条按上限被挤掉', !bigRuns.some((r) => r.id === 'run-A'), bigRuns.map((r) => r.id).slice(0, 3))

// ── 收尾 ────────────────────────────────────────────────────────────────────
server.close()
for (const extra of extraServers) extra.close()
await fsp.rm(TMP, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过：' + checks + ' 项检查' : failures + ' / ' + checks + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
