// 离线断言：Grok 成图的**字节**是否真的不进模型上下文。
//
//   node tools/verify-grok-bytes.mjs
//
// 验的是这一条缺陷：旧版取图链路的兜底是"宿主不可用就把图 base64 按每 20k 字符分块交回会话，
// 再在会话里拼回去写盘"。1 MiB 的图 ≈ 140 万字符 base64 —— 既爆上下文，
// 又会被工具结果上限在分块搬运时截坏（截到的 base64 落盘就是坏图，且**账上记成功**）。
//
// 量化口径（本文件第 1 节打的就是这个账）：
//   * 旧路径：图字节必须先变成 base64 才可能出现在会话文本里 ⇒ 会话文本里的 base64 字符数
//     = ceil(bytes/3)*4（1 MiB ⇒ 1,398,104 字符），另有 JSON 包装 30 字符。
//   * 新路径：图字节走 browser page → 宿主 /dvp/grok/save 的 **raw bytes** 请求体直传，
//     请求体里 0 个 base64 字符；会话只收 { path, bytes, sha256, width, height, status } 元信息。
//
// 全程离线：假图由本文件自己捏（固定种子的伪随机字节，不联网、不用真图），
// 宿主用真 node:http 承托但只监听 127.0.0.1 的随机端口，所有落盘都在 tools/.verify-tmp/ 下，
// 跑完删掉 —— 不碰真实媒体盘、不碰 %APPDATA%、不需要浏览器。

import { createServer } from 'node:http'
import { promises as fsp, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const TMP = path.join(HERE, '.verify-tmp', 'grok-bytes')
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

/** 连续 240+ 个 base64 字符 —— 只有"整段图片内容"才可能命中，不会误伤正常文本。 */
const BASE64_RUN = /[A-Za-z0-9+/]{240,}={0,2}/
const b64Chars = (text) => {
  const found = BASE64_RUN.exec(String(text))
  return found === null ? 0 : found[0].length
}
const b64Total = (text) => (String(text).match(/[A-Za-z0-9+/]{240,}={0,2}/g) || []).reduce((n, s) => n + s.length, 0)
// 反向验证时（把本文件指向改动前的实现）响应里没有 file 字段 —— 一律先转成字符串，
// 免得断言脚本自己 path.dirname(undefined) 抛错，把"失败数"变成"崩溃"。
const toPath = (v) => (typeof v === 'string' ? v : '')

// ── 0. 造字节（本文件自己捏，不联网、不下真图） ──────────────────────────────
// 固定种子 xorshift32：逐次运行字节与 sha256 完全一致，反向验证才能比数字。
function pseudoBytes(n, seed) {
  const out = Buffer.allocUnsafe(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i += 1) {
    x ^= (x << 13) >>> 0
    x = x >>> 0
    x ^= x >>> 17
    x ^= (x << 5) >>> 0
    x = x >>> 0
    out[i] = x & 0xff
  }
  return out
}

/** 真 PNG：IHDR 里写死宽高，IDAT 是自造字节的 deflate 流 —— 宽高可解、体积可控。 */
function fakePng(width, height, byteLength, seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 真彩色
  const payload = pseudoBytes(Math.max(1024, byteLength - 128), seed)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(payload, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 真 JPEG 头：SOI + SOF0（写死宽高）+ 一段 FF00 转义后的自造字节 + EOI。 */
function fakeJpeg(width, height, byteLength, seed) {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2) // 段长
  sof[4] = 8 // 精度
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3 // 分量数
  sof[10] = 1; sof[11] = 0x11; sof[12] = 0
  sof[13] = 2; sof[14] = 0x11; sof[15] = 0
  sof[16] = 3; sof[17] = 0x11; sof[18] = 0
  const src = pseudoBytes(Math.max(1024, byteLength - 64), seed)
  const esc = []
  for (const b of src) {
    esc.push(b)
    if (b === 0xff) esc.push(0x00) // 段内 ff 必须转义，否则解析提前收尾
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from(esc), Buffer.from([0xff, 0xd9])])
}

// CRC32（PNG 用）：查表一次，够快。
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

await fsp.rm(TMP, { recursive: true, force: true })
await fsp.mkdir(path.join(MEDIA, 'images'), { recursive: true })
await fsp.mkdir(RUNS, { recursive: true })

const BIG = fakePng(1024, 1024, 1048576, 0x5eed1234) // ≥1 MiB 的假图（1024×1024，PNG 头可解）
const SMALL = fakeJpeg(784, 1168, 4096, 0x0badf00d) // 小图：验 JPEG 分支与哈希
const BIG_SHA = createHash('sha256').update(BIG).digest('hex')
const SMALL_SHA = createHash('sha256').update(SMALL).digest('hex')

console.log('\n0) 假图自证（不联网、不用真图）')
ok('大假图 ≥ 1 MiB', BIG.length >= 1048576, BIG.length)
ok('大假图是合法 PNG 头（8 字节签名 + IHDR）', BIG.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && BIG.toString('ascii', 12, 16) === 'IHDR', BIG.subarray(0, 16).toString('hex'))
ok('大假图宽高写在 IHDR 里（1024×1024）', BIG.readUInt32BE(16) === 1024 && BIG.readUInt32BE(20) === 1024)
ok('小假图是合法 JPEG 头（SOI + SOF0）', SMALL[0] === 0xff && SMALL[1] === 0xd8 && SMALL.readUInt16BE(2) === 0xffc0)
ok('大假图 ≥ 1 MiB（' + BIG.length + ' 字节）且 sha256 已算出', BIG.length >= 1048576 && BIG_SHA.length === 64, BIG.length)
ok('假图字节每次运行一致（固定种子 → 同一 sha256）', BIG_SHA === createHash('sha256').update(fakePng(1024, 1024, 1048576, 0x5eed1234)).digest('hex'), BIG_SHA.slice(0, 16))
ok('两张假图内容不同（哈希不会串）', BIG_SHA !== SMALL_SHA)

// ── 1. 量化：同一张 1 MiB 图，旧路径要往会话里搬多少 base64 字符 ─────────────
console.log('\n1) 量化对比：1 MiB 图的 base64 字符数（旧 vs 新）')
const inlineBase64 = 'data:image/png;base64,' + BIG.toString('base64')
const legacySessionText = JSON.stringify({ batchId: 'b', index: 1, slug: 'x', ext: '.png', base64: inlineBase64 })
const newSessionText = JSON.stringify({
  ok: true, status: 'saved', batchId: 'b', index: 1, slug: 'x',
  path: '<batchDir>/01-x.png', bytes: BIG.length, sha256: BIG_SHA, width: 1024, height: 1024,
})
const legacyB64 = b64Total(legacySessionText)
const newB64 = b64Total(newSessionText)
const jsonOverhead = Buffer.byteLength(JSON.stringify({ batchId: 'b', index: 1, slug: 'x', ext: '.png', base64: '' }))

ok('旧路径会话文本里出现 ≥ 1 MiB 级 base64（' + legacyB64 + ' 字符）', legacyB64 >= 1000000, legacyB64)
ok('旧路径 base64 字符数 = ceil(bytes/3)*4（' + Math.ceil(BIG.length / 3) * 4 + '）', legacyB64 === Math.ceil(BIG.length / 3) * 4, { legacyB64, expect: Math.ceil(BIG.length / 3) * 4 })
ok('新路径元信息文本里 base64 字符数 = 0', newB64 === 0, newB64)
ok('旧路径的 JSON 包装本身还有 ' + jsonOverhead + ' 字符开销（分块搬运会重复付）', jsonOverhead > 0 && Buffer.byteLength(legacySessionText) > legacyB64, { jsonOverhead, legacy: Buffer.byteLength(legacySessionText) })
ok('新路径文本体积不到旧路径的 0.05%（压掉 99.95% 以上）', Buffer.byteLength(newSessionText) / Buffer.byteLength(legacySessionText) < 0.0005, { new: Buffer.byteLength(newSessionText), legacy: Buffer.byteLength(legacySessionText) })
console.log('  · 旧路径会话文本=' + Buffer.byteLength(legacySessionText) + ' 字符（其中 base64 ' + legacyB64 + '）'
  + ' / 新路径元信息文本=' + Buffer.byteLength(newSessionText) + ' 字符（其中 base64 ' + newB64 + '）'
  + ' / 压掉 ' + (100 * (1 - Buffer.byteLength(newSessionText) / Buffer.byteLength(legacySessionText))).toFixed(4) + '%')

// ── 2. 宿主：真 HTTP 服务承托 /dvp/grok/save ────────────────────────────────
const routes = []
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
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = 'http://127.0.0.1:' + server.address().port

const fakeCtx = {
  get(key) {
    if (key === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {
            const i = routes.indexOf(route)
            if (i >= 0) routes.splice(i, 1)
          }
        },
        tapIndex() {
          return () => {}
        },
      }
    }
    if (key === 'skills') return { register() { return () => {} }, async list() { return [] } }
    return undefined
  },
  effect(fn) {
    return typeof fn === 'function' ? fn() : undefined
  },
}

// 允许根指向本次临时目录：DSH_HOME 指到 TMP 并预写 state.json，脚本自己的 .verify-tmp 也在树里。
process.env.DSH_HOME = TMP
await fsp.mkdir(path.join(TMP, 'dsh-video-prompt'), { recursive: true })
await fsp.writeFile(
  path.join(TMP, 'dsh-video-prompt', 'state.json'),
  JSON.stringify({ mediaRoot: MEDIA, runsRoot: RUNS }),
  'utf8',
)

const host = await import(pathToFileURL(path.join(PKG, 'index.js')).href)
const shot = await import(pathToFileURL(path.join(PKG, 'tools', 'grok-shot.mjs')).href)

console.log('\n2) 宿主路由：raw bytes 直传 /dvp/grok/save')
await host.apply(fakeCtx, { mediaRoot: MEDIA, runsRoot: RUNS, registerSkills: false })
const saveRoute = routes.find((r) => r.path === '/dvp/grok/save')
ok('/dvp/grok/save 路由已注册', saveRoute !== undefined, routes.map((r) => r.path))
ok('index.js 导出 imageSize（会话侧与宿主侧同一口径）', typeof host.imageSize === 'function')

async function createBatch(slug) {
  const started = await fetch(BASE + '/dvp/grok/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grokUrl: 'https://grok.com/', slug, entries: [{ title: '门廊按铃', prompt: '雨夜门廊，暖光，竖版' }] }),
  })
  return { status: started.status, body: await started.json() }
}

const batch = await createBatch('verify-grok-bytes')
ok('批次建立成功（405/404 说明路由没挂上）', batch.status === 200 && batch.body.ok === true, batch)
const batchId = batch.body.batchId
// 门②：建批次时宿主发下来的 nonce（存图必须带上它）。本节后面的正常路径全用它。
const SAVE_NONCE = typeof batch.body.saveNonce === 'string' ? batch.body.saveNonce : ''
ok('批次响应带 saveNonce（存图那把钥匙，长度 ≥ 32）', SAVE_NONCE.length >= 32, SAVE_NONCE.length)

// 2a. 新路径：请求体就是图字节本身
const postRaw = (bytes, qs, contentType = 'image/png', headers = {}) => fetch(BASE + '/dvp/grok/save?' + qs, {
  method: 'POST',
  headers: { 'Content-Type': contentType, ...headers },
  body: bytes,
})
/** 正常路径的请求串：raw bytes 的一切标识都走 URL 参数，nonce 也走这里（页面内 fetch 最省事）。 */
const withNonce = (qs, nonce = SAVE_NONCE) => qs + '&nonce=' + encodeURIComponent(nonce)

const rawRes = await postRaw(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=1&slug=demo-png'))
const rawText = await rawRes.text()
const rawMeta = JSON.parse(rawText)
ok('raw 模式 HTTP 200', rawRes.status === 200, rawRes.status)
ok('响应 status="saved"', rawMeta.status === 'saved', rawMeta.status)
ok('响应只回元信息（file/bytes/sha256/width/height/status）', ['ok', 'status', 'file', 'bytes', 'sha256', 'width', 'height'].every((k) => k in rawMeta), Object.keys(rawMeta))
ok('响应体里 base64 字符数 = 0（图字节没被回吐）', b64Total(rawText) === 0, b64Total(rawText))
ok('响应体不含任何 ≥240 字符的编码串', BASE64_RUN.exec(rawText) === null)
ok('响应报的字节数 = 图字节数（' + BIG.length + '）', rawMeta.bytes === BIG.length, rawMeta.bytes)
ok('响应报的 sha256 与本文件独立算的一致', rawMeta.sha256 === BIG_SHA, { got: rawMeta.sha256, want: BIG_SHA })
ok('响应报的宽高正确（1024×1024）', rawMeta.width === 1024 && rawMeta.height === 1024, { w: rawMeta.width, h: rawMeta.height })
ok('落盘文件真的存在', toPath(rawMeta.file) !== '' && existsSync(toPath(rawMeta.file)), rawMeta.file)
ok('落盘路径在 <batchId>/ 批次目录里（不退平铺 grok-output 根）',
  toPath(rawMeta.file) !== '' && path.basename(path.dirname(toPath(rawMeta.file))) === batchId, { dir: toPath(rawMeta.file), batchId })
const diskBytes = existsSync(toPath(rawMeta.file)) ? await fsp.readFile(toPath(rawMeta.file)) : Buffer.alloc(0)
ok('盘上字节与源字节逐字节相同', diskBytes.length === BIG.length && createHash('sha256').update(diskBytes).digest('hex') === BIG_SHA, diskBytes.length)
ok('落盘文件名 = <序号>-<slug>.png', path.basename(toPath(rawMeta.file)) === '01-demo-png.png', path.basename(toPath(rawMeta.file)))

// 2b. 第二张图：JPEG 分支 + 序号/slug 各自独立
const rawJpegRes = await postRaw(SMALL, withNonce('batch=' + encodeURIComponent(batchId) + '&index=2&slug=demo-jpg&ext=.jpg'), 'image/jpeg')
const rawJpegMeta = await rawJpegRes.json()
ok('JPEG 也走 raw 直传落盘', rawJpegRes.status === 200 && rawJpegMeta.status === 'saved', rawJpegMeta)
ok('JPEG 宽高正确（784×1168）', rawJpegMeta.width === 784 && rawJpegMeta.height === 1168, { w: rawJpegMeta.width, h: rawJpegMeta.height })
ok('JPEG 扩展名跟随 ext 参数', path.basename(toPath(rawJpegMeta.file)) === '02-demo-jpg.jpg', path.basename(toPath(rawJpegMeta.file)))
ok('JPEG 哈希正确', rawJpegMeta.sha256 === SMALL_SHA, { got: rawJpegMeta.sha256, want: SMALL_SHA })

// 2c. 旧路径（JSON base64）仍可用：它只能被宿主侧工具用，绝不该是会话里的路
const jsonRes = await fetch(BASE + '/dvp/grok/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ batchId, index: 3, slug: 'demo-json', base64: SMALL.toString('base64'), nonce: SAVE_NONCE }),
})
const jsonMeta = await jsonRes.json()
ok('JSON base64 兼容路径仍能落盘（别的图源与旧调用方）', jsonRes.status === 200 && jsonMeta.bytes === SMALL.length, jsonMeta)
ok('JSON 路径的响应体同样 0 字符 base64', b64Total(JSON.stringify(jsonMeta)) === 0)

// 2d. 空体 / 错批次：错误响应也必须只回文字，不回吐字节
const emptyRes = await postRaw(Buffer.alloc(0), withNonce('batch=' + encodeURIComponent(batchId) + '&index=4&slug=empty'))
const emptyBody = await emptyRes.text()
ok('0 字节请求体被拒（400）而不是写一个空文件', emptyRes.status === 400, emptyRes.status)
ok('拒绝理由是可读文字（提示占位图 0 字节）', emptyBody.includes('0 字节') || emptyBody.includes('为空'), emptyBody.slice(0, 120))
const badRes = await postRaw(BIG, withNonce('batch=../evil&index=5&slug=escape'))
ok('批次越界（..）被拒（400/403）', badRes.status === 400 || badRes.status === 403, badRes.status)

// 2e. 账本：只记元信息，不记字节
const ledgerFile = path.join(MEDIA, 'grok-output', batchId, 'ledger.json')
const ledger = existsSync(ledgerFile) ? JSON.parse(await fsp.readFile(ledgerFile, 'utf8')) : { items: [] }
const ledgerItem = ledger.items.find((i) => i.file === rawMeta.file)
ok('ledger 里记了 sha256', ledgerItem !== undefined && ledgerItem.sha256 === BIG_SHA, ledgerItem && ledgerItem.sha256)
ok('ledger 记的 source 是 raw-bytes（说明走的直传通道）', ledgerItem !== undefined && ledgerItem.source === 'raw-bytes', ledgerItem && ledgerItem.source)
ok('ledger 全文 0 字符 base64', b64Total(JSON.stringify(ledger)) === 0)
ok('本批目录里没有把 base64 落成中间文件', !(await fsp.readdir(path.join(MEDIA, 'grok-output', batchId))).some((n) => /b64|base64/i.test(n)))

// ── 2f. 三道门：CORS 白名单回显 · batch nonce · 图片魔术字节 ──────────────────
//
// 打的是 2026-09 那一轮留下的口子：`Access-Control-Allow-Origin: *` + 无鉴权 ⇒ **任何被访问过的
// 网页**都能 POST 到这个本机端点（写入虽被批次目录围栏限制，仍等于"任意网页可写/可读元信息"）。
// 三条防线各验正反两面；**最后一条（正常路径仍然通）最重要** —— 硬化不许把功能关掉。
console.log('\n2f) /dvp/grok/save 三道门：CORS 白名单 / nonce / 魔术字节')

const GROK_ORIGIN = 'https://grok.com'
const EVIL_ORIGIN = 'https://evil.example'

/** 带 Origin 的 raw POST（浏览器跨源那条路的样子），把状态与响应头一起拿回来。 */
async function postRawOrigin(bytes, qs, origin, contentType = 'image/png') {
  const response = await fetch(BASE + '/dvp/grok/save?' + qs, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Origin: origin },
    body: bytes,
  })
  return { status: response.status, acao: response.headers.get('access-control-allow-origin'), vary: response.headers.get('vary'), text: await response.text() }
}

// ⓪ 白名单判别是纯函数，先离线把口径钉住（连服务都不用）。
// 反向验证时（把本文件指向改动前的 index.js）这些出口**根本不存在** —— 所以下面全部走
// `typeof === 'function' ? call : undefined`：断言照常失败并把 undefined 打出来，
// 不让脚本自己抛 TypeError 把"失败数"变成"崩溃"（崩溃会让后面的断言一条都不跑）。
const has = (name, kind) => typeof host[name] === kind
const call = (name, ...args) => (has(name, 'function') ? host[name](...args) : undefined)
const allows = (origin, env) => String(call('isAllowedGrokSaveOrigin', origin, env)) === 'true'
const corsOf = (origin) => {
  const value = call('grokSaveCorsHeaders', origin)
  return value === null || typeof value !== 'object' ? {} : value
}
const sigOf = (bytes) => {
  const value = call('imageFileSignature', bytes)
  return typeof value === 'string' ? value : 'undefined'
}
const allowedTable = Array.isArray(host.GROK_SAVE_ALLOWED_ORIGINS) ? host.GROK_SAVE_ALLOWED_ORIGINS : []
ok('出口：白名单常量导出且**不含通配符**', allowedTable.length > 0 && !allowedTable.includes('*'), allowedTable)
ok('出口：判别器/构造函数/nonce 工具都是函数', ['isAllowedGrokSaveOrigin', 'grokSaveCorsHeaders', 'imageFileSignature', 'grokSaveNonceEquals', 'grokSaveNonceRequired']
  .every((k) => has(k, 'function')), ['isAllowedGrokSaveOrigin', 'grokSaveCorsHeaders', 'imageFileSignature', 'grokSaveNonceEquals', 'grokSaveNonceRequired'].filter((k) => !has(k, 'function')))
ok('白名单内：grok.com / www.grok.com / assets.grok.com / x.ai',
  ['https://grok.com', 'https://www.grok.com', 'https://assets.grok.com', 'https://grok.com:443', 'https://x.ai', 'https://accounts.x.ai']
    .every((o) => allows(o) === true),
  ['https://grok.com', 'https://www.grok.com', 'https://assets.grok.com', 'https://grok.com:443', 'https://x.ai', 'https://accounts.x.ai'].map((o) => [o, call('isAllowedGrokSaveOrigin', o)]))
ok('白名单外：协议降级/伪装域/端口/本机地址一律不认',
  ['http://grok.com', 'https://grok.com.evil.example', 'https://evil-grok.com', 'https://notgrok.com', 'https://127.0.0.1:8080', 'https://localhost:3000', 'null']
    .every((o) => allows(o) === false),
  ['http://grok.com', 'https://grok.com.evil.example', 'https://evil-grok.com', 'https://notgrok.com', 'https://127.0.0.1:8080', 'https://localhost:3000', 'null'].map((o) => [o, call('isAllowedGrokSaveOrigin', o)]))
ok('大小写不敏感（Origin 规范上是小写的，放宽这层不吃亏）', allows('https://GROK.COM') === true)
ok('没有 Origin 头 ⇒ 放行（同源面板调用与非浏览器调用方走这条路）', allows(undefined) === true && allows('') === true)
ok('CORS 头是**回显请求自己的 Origin**，不是 *', corsOf(GROK_ORIGIN)['Access-Control-Allow-Origin'] === GROK_ORIGIN
  && corsOf('https://www.grok.com')['Access-Control-Allow-Origin'] === 'https://www.grok.com', [corsOf(GROK_ORIGIN), corsOf('https://www.grok.com')])
ok('CORS 头带 Vary: Origin（响应随 Origin 变，别被缓存串源）', corsOf(GROK_ORIGIN).Vary === 'Origin', corsOf(GROK_ORIGIN))
ok('白名单外的源 ⇒ 一个 CORS 头都不给', Object.keys(corsOf(EVIL_ORIGIN)).length === 0, corsOf(EVIL_ORIGIN))
ok('运维口：DVP_GROK_SAVE_ORIGINS 能临时加源（只按 origin 精确匹配）',
  allows('https://my.proxy.example') === false
  && allows('https://my.proxy.example', { DVP_GROK_SAVE_ORIGINS: 'https://my.proxy.example' }) === true
  && allows('https://other.example', { DVP_GROK_SAVE_ORIGINS: 'https://my.proxy.example' }) === false)

// ① 白名单内的 Origin ⇒ 回显该 Origin（而不是 *）
const allowedRes = await postRawOrigin(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=9&slug=origin-ok'), GROK_ORIGIN)
const allowedMeta = JSON.parse(allowedRes.text)
ok('① 白名单内 Origin：正常落盘 200', allowedRes.status === 200 && allowedMeta.sha256 === BIG_SHA, { status: allowedRes.status, meta: allowedMeta.status })
ok('① 响应回显请求的 Origin（不是 *）', allowedRes.acao === GROK_ORIGIN, allowedRes.acao)
ok('① 响应带 Vary: Origin', /(^|,)\s*Origin\s*($|,)/i.test(String(allowedRes.vary)), allowedRes.vary)
ok('① 白名单内子域也回显它自己（assets.grok.com）',
  (await postRawOrigin(SMALL, withNonce('batch=' + encodeURIComponent(batchId) + '&index=10&slug=subdomain'), 'https://assets.grok.com', 'image/jpeg')).acao === 'https://assets.grok.com')

// ② 白名单外的 Origin ⇒ 不回 ACAO，且请求被拒（403）
const evilRes = await postRawOrigin(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=11&slug=evil-origin'), EVIL_ORIGIN)
ok('② 白名单外 Origin：被拒 403', evilRes.status === 403, evilRes.status)
ok('② 白名单外 Origin：**没有** Access-Control-Allow-Origin 响应头', evilRes.acao === null, evilRes.acao)
ok('② 白名单外 Origin：错误文案不泄露本机细节之外的路径', evilRes.text.includes('来源未被允许'), evilRes.text.slice(0, 80))
const evilFile = path.join(MEDIA, 'grok-output', batchId, '11-evil-origin.png')
ok('② 白名单外 Origin：盘上确实没写任何文件', !existsSync(evilFile))
const evilPreflight = await fetch(BASE + '/dvp/grok/save', { method: 'OPTIONS', headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'POST' } })
ok('② 白名单外 Origin 的预检也不放行（无 ACAO）', evilPreflight.headers.get('access-control-allow-origin') === null, evilPreflight.headers.get('access-control-allow-origin'))
const okPreflight = await fetch(BASE + '/dvp/grok/save', { method: 'OPTIONS', headers: { Origin: GROK_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-dvp-nonce' } })
ok('① 白名单内 Origin 的预检回 ACAO + Allow-Headers 含 X-DVP-Nonce',
  okPreflight.status === 204 && okPreflight.headers.get('access-control-allow-origin') === GROK_ORIGIN
  && /x-dvp-nonce/i.test(String(okPreflight.headers.get('access-control-allow-headers'))),
  { status: okPreflight.status, acao: okPreflight.headers.get('access-control-allow-origin'), allow: okPreflight.headers.get('access-control-allow-headers') })

// ③ nonce 错误 / 缺失 ⇒ 403（且不落盘、不留目录）
const wrongNonceRes = await postRawOrigin(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=12&slug=wrong-nonce', 'f'.repeat(64)), GROK_ORIGIN)
const missingNonceRes = await postRawOrigin(BIG, 'batch=' + encodeURIComponent(batchId) + '&index=13&slug=no-nonce', GROK_ORIGIN)
const emptyNonceRes = await postRawOrigin(BIG, 'batch=' + encodeURIComponent(batchId) + '&index=14&slug=empty-nonce&nonce=', GROK_ORIGIN)
const prefixNonceRes = await postRawOrigin(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=15&slug=prefix-nonce', SAVE_NONCE.slice(0, 32)), GROK_ORIGIN)
ok('③ nonce 错误 ⇒ 403', wrongNonceRes.status === 403, wrongNonceRes.status)
ok('③ nonce 缺失 ⇒ 403', missingNonceRes.status === 403, missingNonceRes.status)
ok('③ nonce 空串 ⇒ 403（空值不许当"跳过校验"）', emptyNonceRes.status === 403, emptyNonceRes.status)
ok('③ nonce 前缀（正确 nonce 的截断）⇒ 403', prefixNonceRes.status === 403, prefixNonceRes.status)
ok('③ 403 文案能让人照着做（缺 nonce 时点明 saveNonce 在哪；错了时点明要重新建批次）',
  /saveNonce/.test(missingNonceRes.text) && /重新建批次|不正确/.test(wrongNonceRes.text), [missingNonceRes.text.slice(0, 70), wrongNonceRes.text.slice(0, 70)])
ok('③ 被拒的请求在盘上不留痕迹（没有 12~15 号文件）',
  ['12-wrong-nonce.png', '13-no-nonce.png', '14-empty-nonce.png', '15-prefix-nonce.png']
    .every((n) => !existsSync(path.join(MEDIA, 'grok-output', batchId, n))))
ok('③ nonce 定长比较：相等 true / 不等 false / 长度差也不抛（timingSafeEqual 会抛长度不一致）',
  call('grokSaveNonceEquals', 'a'.repeat(64), 'a'.repeat(64)) === true
  && call('grokSaveNonceEquals', 'a'.repeat(64), 'b'.repeat(64)) === false
  && call('grokSaveNonceEquals', 'a'.repeat(64), 'a'.repeat(63)) === false
  && call('grokSaveNonceEquals', '', '') === false && call('grokSaveNonceEquals', 'x', undefined) === false,
  [call('grokSaveNonceEquals', 'a'.repeat(64), 'a'.repeat(64)), call('grokSaveNonceEquals', 'a'.repeat(64), 'b'.repeat(64)), call('grokSaveNonceEquals', 'a'.repeat(64), 'a'.repeat(63))])
// nonce 走请求头（X-DVP-Nonce）也要认：页面里 fetch 用 header 更不容易被 URL 日志记下。
// nonce 走请求头（X-DVP-Nonce）也要认：页面里 fetch 用 header 更不容易被 URL 日志记下。
// 对照组是"同一个请求、只把 nonce 拿掉" ⇒ 必须 403，否则这条断言自己就是假的。
const headerQ = 'batch=' + encodeURIComponent(batchId) + '&index=17&slug=header-nonce'
const headerNonceRes = await postRawOrigin(BIG, headerQ, GROK_ORIGIN)
const headerNonce = await fetch(BASE + '/dvp/grok/save?' + headerQ, {
  method: 'POST', headers: { 'Content-Type': 'image/png', Origin: GROK_ORIGIN, 'X-DVP-Nonce': SAVE_NONCE }, body: BIG,
})
ok('③ nonce 走请求头 X-DVP-Nonce 也认（页面里更不容易被 URL 记下来）', headerNonce.status === 200, headerNonce.status)
ok('③ 对照组：同一请求去掉 nonce 头 ⇒ 403（说明上一行确实是 nonce 起的作用）', headerNonceRes.status === 403, headerNonceRes.status)
// ④ 非图片字节 ⇒ 拒绝（只看魔数，不看扩展名与 content-type）
const NOT_IMAGE = [
  ['纯文本', Buffer.from('这不是图片，只是一段文字。'.repeat(20), 'utf8'), 'text/plain'],
  ['HTML', Buffer.from('<!doctype html><html><body>hello</body></html>'.repeat(10), 'utf8'), 'text/html'],
  ['ZIP（PK\\x03\\x04）', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 9)]), 'application/zip'],
  ['PNG 签名被改掉一位', Buffer.from(BIG).fill(0x00, 1, 2), 'image/png'],
  ['只有 3 个字节', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
]
const notImageResults = []
for (const [label, bytes, type] of NOT_IMAGE) {
  const response = await postRawOrigin(bytes, withNonce('batch=' + encodeURIComponent(batchId) + '&index=30&slug=not-image'), GROK_ORIGIN, type)
  notImageResults.push({ label, status: response.status, text: response.text })
}
ok('④ 非图片字节一律 415（连声明 image/png 也不认）', notImageResults.every((r) => r.status === 415), notImageResults.map((r) => [r.label, r.status]))
ok('④ 拒绝理由写清"按魔数判断"并回带前 16 字节，便于现场对账', notImageResults.every((r) => r.text.includes('魔数')), notImageResults[0].text.slice(0, 100))
ok('④ 盘上没有 30 号文件（被拒的载荷没被写成 .png）', !existsSync(path.join(MEDIA, 'grok-output', batchId, '30-not-image.png')))
ok('④ 魔数判别器本身：PNG/JPEG/GIF/WebP 认，别的认不出',
  sigOf(BIG) === '.png' && sigOf(SMALL) === '.jpg'
  && sigOf(Buffer.from('GIF89a' + 'x'.repeat(10))) === '.gif'
  && sigOf(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])) === '.webp'
  && sigOf(Buffer.from('随便一段不是图片的字节')) === '' && sigOf(undefined) === '',
  [sigOf(BIG), sigOf(SMALL), sigOf(Buffer.from('随便一段不是图片的字节'))])
ok('④ ledger 里记下魔数认出的真实封装（.png/.jpg）',
  ['origin-ok', 'subdomain'].every((slug) => {
    const entry = (ledger.items || []).find((i) => i.slug === slug)
    return entry === undefined || entry.signature === '.png' || entry.signature === '.jpg'
  }))

// ⑤ 正常路径仍然通：白名单 Origin + 正确 nonce + 真图片字节 ⇒ 200 且落盘字节/哈希正确
//    —— 这条最重要：三道门不许把功能关掉。
const happyBytes = fakePng(512, 768, 8192, 0x11c0ffee)
const happySha = createHash('sha256').update(happyBytes).digest('hex')
const happyRes = await postRawOrigin(happyBytes, withNonce('batch=' + encodeURIComponent(batchId) + '&index=20&slug=happy-path'), GROK_ORIGIN)
const happyMeta = JSON.parse(happyRes.text)
const happyFile = toPath(happyMeta.file)
ok('⑤ 正常路径：白名单 Origin + 正确 nonce + 真图 ⇒ 200', happyRes.status === 200 && happyMeta.status === 'saved', { status: happyRes.status, meta: happyMeta.status })
ok('⑤ 正常路径：回显 Origin + Vary（跨源页面能读到元信息）', happyRes.acao === GROK_ORIGIN && /Origin/i.test(String(happyRes.vary)))
ok('⑤ 正常路径：落盘字节逐字节相同 + sha256 一致', existsSync(happyFile)
  && createHash('sha256').update(await fsp.readFile(happyFile)).digest('hex') === happySha && happyMeta.sha256 === happySha, { file: happyFile, sha256: happyMeta.sha256 })
ok('⑤ 正常路径：宽高从图里解出来了（512×768）', happyMeta.width === 512 && happyMeta.height === 768, { w: happyMeta.width, h: happyMeta.height })
ok('⑤ 正常路径：响应体里仍然 0 字符 base64（硬化没把字节回吐）', b64Total(happyRes.text) === 0, b64Total(happyRes.text))
// 不带 Origin 的宿主侧调用（同源面板 / 脚本）也仍然通 —— 老路径不许被顺手关掉。
const hostSideRes = await postRaw(happyBytes, withNonce('batch=' + encodeURIComponent(batchId) + '&index=21&slug=host-side'))
ok('⑤ 不带 Origin 的宿主侧调用仍然通（同源面板/脚本那条路）', hostSideRes.status === 200 && (await hostSideRes.json()).sha256 === happySha, hostSideRes.status)
// DVP_GROK_SAVE_ALLOW_ANON=1 是显式逃生口：本机无浏览器调用方能不带 nonce 存图。
ok('⑤ 逃生口默认关着（grokSaveNonceRequired 默认 true）', call('grokSaveNonceRequired', {}) === true && call('grokSaveNonceRequired', { DVP_GROK_SAVE_ALLOW_ANON: '1' }) === false,
  [call('grokSaveNonceRequired', {}), call('grokSaveNonceRequired', { DVP_GROK_SAVE_ALLOW_ANON: '1' })])

// ⑥ 重新建同一批 ⇒ 换新 nonce，旧的那把立刻作废（"重试这一批"不能留一把永久钥匙）。
//    这一段必须放在最后：它把 SAVE_NONCE 打废，前面用 SAVE_NONCE 的正常路径断言不能受影响。
const reissued = await (await fetch(BASE + '/dvp/grok/plan', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchId, entries: [{ index: 1, slug: 'reissue', prompt: '重发同一批' }] }),
})).json()
const newNonce = typeof reissued.saveNonce === 'string' ? reissued.saveNonce : ''
ok('⑥ 重发同一批换新 nonce（旧的不复用）', newNonce.length >= 32 && newNonce !== SAVE_NONCE)
ok('⑥ 旧 nonce 立刻作废（403）', (await postRawOrigin(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=18&slug=stale-nonce', SAVE_NONCE), GROK_ORIGIN)).status === 403)
ok('⑥ 新 nonce 可用（200）', (await postRawOrigin(BIG, withNonce('batch=' + encodeURIComponent(batchId) + '&index=19&slug=fresh-nonce', newNonce), GROK_ORIGIN)).status === 200)
ok('⑥ 只读端点 GET /dvp/grok/plan 不回吐 nonce（跨源读得到的端点不许带钥匙）',
  (await (await fetch(BASE + '/dvp/grok/plan?batch=' + encodeURIComponent(batchId))).text()).includes(newNonce) === false)


console.log('\n3) 会话文本（配方/驱动清单/面板提示）里没有 base64 搬运通道')
// 注意 grok-shot 的 MIN_PROMPT_CHARS = 40：两条样例正文都必须**超过 40 字**，
// 否则会被"太短的不是提示词"这条过滤规则剔掉（第一版样例只写了 38 字，解析出 1 条）。
const entries = shot.splitPrompts(
  '## 01 门廊按铃\n雨夜门廊，暖黄门灯，竖版构图，人物侧身回望，湿漉漉的青石板路反光，35mm 质感，浅景深。\n\n'
  + '## 02 巷口回头\n雨巷霓虹倒影，窄巷纵深感，人物回头半身，冷调蓝紫，浅景深，电影感颗粒，雨丝斜切画面。\n',
)
ok('配方解析出 2 条提示词', entries.length === 2, entries.length)
const batchDirForRecipe = path.join(MEDIA, 'grok-output', batchId)
const recipe = shot.grokRecipe(entries, path.join(MEDIA, 'grok-output'), batchId)
const saveHits = (recipe.match(/\/dvp\/grok\/save/g) || []).length
// "分块"只允许出现在**禁止性措辞**里（"不许退回…把 base64 分块交回会话"）。
// 判定口径：每处"分块"附近 ±120 字符内必须有一个禁止标记，否则算旧通道复活。
const chunkHits = [...recipe.matchAll(/分块/g)].map((m) => m.index)
const forbidden = chunkHits.filter((i) => !/(不许|不得|❌|已删除|禁止|必爆上下文)/.test(recipe.slice(Math.max(0, i - 120), i + 120)))
const twentyK = [...recipe.matchAll(/20k/g)].map((m) => m.index)
const twentyKForbidden = twentyK.filter((i) => !/(不许|不得|❌|已删除|禁止)/.test(recipe.slice(Math.max(0, i - 120), i + 120)))

ok('recipe 里 base64 字符数 = 0', b64Total(recipe) === 0, b64Total(recipe))
ok('recipe 里"分块"只作为禁止性措辞出现（无旧兜底指令）', forbidden.length === 0, { chunkHits: chunkHits.length, forbidden: forbidden.length })
ok('recipe 里"20k"只作为禁止性措辞出现', twentyKForbidden.length === 0, { hits: twentyK.length, forbidden: twentyKForbidden.length })
ok('recipe 明确写死"图片内容不得出现在 browser_eval 返回值"', /不得出现在 browser_eval 的返回值/.test(recipe))
ok('recipe 每条提示词都有一步取图指向 /dvp/grok/save', saveHits >= entries.length, { saveHits, entries: entries.length })
ok('recipe 取图步骤指定 application/octet-stream（raw 直传）', (recipe.match(/application\/octet-stream/g) || []).length >= entries.length)
ok('recipe 要求把批次带进落盘请求（&batch=）', recipe.includes('&batch=' + batchId))
// 门②在"配方"这条路上的要求：建批次时宿主发下的 nonce 必须原样传给页面脚本，否则页面里必吃 403。
const recipeWithNonce = shot.grokRecipe(entries, path.join(MEDIA, 'grok-output'), batchId, SAVE_NONCE)
ok('recipe 把 nonce 带进取图命令（&nonce=<本批 nonce>）', recipeWithNonce.includes('&nonce=' + SAVE_NONCE), recipeWithNonce.slice(0, 200))
ok('recipe 不给 nonce 时不凭空编一个（老批次/老调用方照旧）', !recipe.includes('&nonce='))
const norm = (p) => String(p).replace(/\\/g, '/')
ok('recipe 的路径指向本批目录（每批一个）', norm(recipe).includes(norm(batchDirForRecipe)), { want: norm(batchDirForRecipe) })
ok('recipe 的路径不含平铺 grok-output 根（批次隔离没退回）', !/grok-output`|\/grok-output\s|\/grok-output\\?\s/.test(norm(recipe).replace(norm(batchDirForRecipe), '')))
ok('recipe 只剩盘到盘兜底（scan-cache / watch-downloads）', recipe.includes('scan-cache.mjs') && recipe.includes('watch-downloads.mjs'))
ok('recipe 每张图都要求回报 sha256', (recipe.match(/sha256/g) || []).length >= entries.length, (recipe.match(/sha256/g) || []).length)
console.log('  · recipe：' + Buffer.byteLength(recipe) + ' 字符 · /dvp/grok/save ×' + saveHits + ' · batchDir 命中=' + norm(recipe).includes(norm(batchDirForRecipe)) + ' · base64=' + b64Total(recipe))

// 反向验证时（改动前的 index.js 没导出 driverDoc）这里拿到 undefined —— 不抛错，只让断言失败。
const driverDoc = typeof host.driverDoc === 'function'
  ? host.driverDoc({ dir: batchDirForRecipe, batchId, saveNonce: SAVE_NONCE, entries, grokUrl: 'https://grok.com/', createdAt: '2026-09-15T00:00:00.000Z', count: entries.length, options: { clarity: '1080p', aspect: '3:4' } })
  : null
ok('driverDoc 从 index.js 导出且可离线生成（供断言用）', typeof driverDoc === 'string' && driverDoc.length > 0, typeof driverDoc)
if (typeof driverDoc === 'string' && driverDoc !== '') {
  ok('driverDoc 里 base64 字符数 = 0', b64Total(driverDoc) === 0, b64Total(driverDoc))
  ok('driverDoc 指向 raw bytes 直传 /dvp/grok/save', driverDoc.includes('/dvp/grok/save'))
  ok('driverDoc 要求带上 batch（图才会进本批目录）', driverDoc.includes('&batch=' + batchId))
  ok('driverDoc 把本批 nonce 交给会话（存图时带上，否则 403）', driverDoc.includes('&nonce=' + SAVE_NONCE))
  ok('driverDoc 写明图片内容/base64 不进会话文本', /一律不进会话文本/.test(driverDoc))
  ok('driverDoc 不含旧版"base64 或图片 URL + index/slug"措辞', !/base64 或图片 URL/.test(driverDoc))
}

const planDoc = (await import(pathToFileURL(path.join(PKG, 'tools', 'backfill-plan.mjs')).href)).renderDriverDoc({
  dir: batchDirForRecipe,
  batchId,
  saveNonce: SAVE_NONCE,
  entries,
  grokUrl: 'https://grok.com/',
})
ok('backfill-plan 的驱动清单里 base64 字符数 = 0', b64Total(planDoc) === 0, b64Total(planDoc))
ok('backfill-plan 指明 raw bytes 直传 + 盘到盘兜底', planDoc.includes('/dvp/grok/save') && planDoc.includes('scan-cache.mjs'))
ok('backfill-plan 把 nonce 带进取图命令（缺了/错了 403）', planDoc.includes('&nonce=' + SAVE_NONCE) && planDoc.includes('403'))
ok('backfill-plan 不含旧版"点 Download"作为唯一兜底的措辞', !/拿不到字节时：请用户在真实浏览器里点一次 Download/.test(planDoc))

const clientSrc = await fsp.readFile(path.join(PKG, 'client.js'), 'utf8')
const briefAnchor = clientSrc.indexOf('落盘路由：POST /dvp/grok/save')
ok('client.js 里存在派发提示的落盘路由行', briefAnchor > 0, briefAnchor)
const panelBrief = briefAnchor > 0 ? clientSrc.slice(briefAnchor - 400, briefAnchor + 900) : ''
ok('面板派发提示里没有 ≥240 字符的 base64 串', !BASE64_RUN.test(panelBrief), b64Chars(panelBrief))
ok('面板派发提示指向 raw bytes 直传', panelBrief.includes('raw bytes'), panelBrief.slice(0, 80))
ok('面板派发提示写明字节/base64 不进会话文本', /一律不进会话文本/.test(panelBrief))

// ── 4. saveImage（脚本侧落盘）返回的也是元信息 ──────────────────────────────
console.log('\n4) tools/grok-shot.mjs 的 saveImage 只回元信息')
const saved = await shot.saveImage(path.join(TMP, 'shot-out'), { index: 7, slug: 'meta-check' }, BIG)
ok('saveImage 回 status="saved"', saved.status === 'saved', saved.status)
ok('saveImage 回 sha256 正确', saved.sha256 === BIG_SHA, saved.sha256)
ok('saveImage 回宽高正确', saved.width === 1024 && saved.height === 1024, { w: saved.width, h: saved.height })
ok('saveImage 的返回值里没有字节/base64 字段', !('base64' in saved) && !('data' in saved) && !('bytes_raw' in saved), Object.keys(saved))
ok('saveImage 的返回值 JSON 里 0 字符 base64', b64Total(JSON.stringify(saved)) === 0)
ok('saveImage 返回值也带路径与字节数', typeof saved.file === 'string' && saved.bytes === BIG.length, { file: saved.file, bytes: saved.bytes })

// ── 5. 统一任务记录（run.json）：一条记录 = 一个批次 ─────────────────────────
//
// 一条记录要回答四件事（状态 / 当前步骤 / 失败原因 / 产物位置），并支撑三个动作（续跑 / 仅重试失败项 /
// 取消）。这一节逐条钉住六件事：
//   ① 一次成功批次 ⇒ status=succeeded、产物齐全（路径/字节/sha256/尺寸都在）
//   ② 部分缺图 ⇒ partial、失败项清单与 reason 正确、产物位置正确
//   ③ 续跑 / 仅重试失败项 ⇒ 清单只含该重跑的那几项，重跑走**既有 batch= 机制**且不新建批次
//   ④ 取消 ⇒ 只记语义（谁/何时/为什么），不动产物、不杀进程
//   ⑤ 只读查询路由**不写盘**：对整个 grok-output 树做 sha256 前后比对
//   ⑥ 旧批次（没有 run.json、账本条目是旧字段）仍能读，且读它也不会"补"出一份 run.json
//
// 与第 2 节同一套离线口径：假图自己捏、临时 DSH_HOME、真 HTTP 承托、不联网、不碰真实媒体盘。
// 反向验证时（把本文件指向改动前的实现）这些路由根本不注册 ⇒ 断言照常失败、脚本不崩：
// 所有响应字段都经 runCounts()/failuresOf() 之类的兜底取值，路径也一律先判类型再用。
console.log('\n5) /dvp/grok/run · 统一任务记录：状态 / 当前步骤 / 失败原因 / 产物位置')

const fsp5 = fsp // 本节沿用同一份 fs.promises（别名只为让本节读起来自洽）

const RUN_ROOT = path.join(MEDIA, 'grok-output')
const runUrl = (qs) => BASE + '/dvp/grok/run?' + qs
const runsUrl = (qs) => BASE + '/dvp/grok/runs' + (qs === undefined ? '' : '?' + qs)
const planUrl = (qs) => BASE + '/dvp/grok/plan' + (qs === undefined ? '' : '?' + qs)
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function getJson(url) {
  try {
    const response = await fetch(url)
    let body = {}
    try {
      const parsed = await response.json()
      if (parsed !== null && typeof parsed === 'object') body = parsed
    } catch { /* 非 JSON（反向验证时可能是 404 文本）一律当空对象 */ }
    return { status: response.status, body }
  } catch (err) {
    return { status: 0, body: {}, error: String((err && err.message) || err) }
  }
}

async function postJson(url, payload) {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload),
    })
    let body = {}
    try {
      const parsed = await response.json()
      if (parsed !== null && typeof parsed === 'object') body = parsed
    } catch { /* 同上 */ }
    return { status: response.status, body }
  } catch (err) {
    return { status: 0, body: {}, error: String((err && err.message) || err) }
  }
}

/** 裸字节存图（raw bytes 直传，与第 2 节同一条通道）。 */
async function saveRaw(bytes, qs) {
  try {
    const response = await fetch(BASE + '/dvp/grok/save?' + qs, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    })
    let body = {}
    try {
      const parsed = await response.json()
      if (parsed !== null && typeof parsed === 'object') body = parsed
    } catch { /* 同上 */ }
    return { status: response.status, body }
  } catch (err) {
    return { status: 0, body: {}, error: String((err && err.message) || err) }
  }
}

// 记录字段的兜底取值：反向验证时响应里没有这些字段（路由根本没注册），一律退到"空值容器"，
// 让断言**失败**而不是抛 TypeError —— 崩溃会让后面的断言一条都不跑，"失败数"就没意义了。
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asList = (v) => (Array.isArray(v) ? v : [])
/** 取列表第 i 个元素，取不到给一个空对象（这样 `at(list, 0).file` 永远不炸）。 */
const at = (list, index) => (isObj(asList(list)[index]) ? asList(list)[index] : {})
const runCounts = (b) => (isObj(b) && isObj(b.counts) ? b.counts : {})
const runStepId = (b) => (isObj(b) && isObj(b.step) ? String(b.step.id || '') : '')
const runStepLabel = (b) => (isObj(b) && isObj(b.step) ? String(b.step.label || '') : '')
const runFailures = (b) => (isObj(b) ? asList(b.failures) : [])
const runArtifacts = (b) => (isObj(b) ? asList(b.artifacts) : [])
const runWarnings = (b) => (isObj(b) ? asList(b.warnings) : [])
const runControl = (b) => (isObj(b) && isObj(b.control) ? b.control : {})
const runHistory = (b) => asList(runControl(b).history)
const runMark = (b, which) => (isObj(runControl(b)[which]) ? runControl(b)[which] : {})
const runBatches = (b) => (isObj(b) ? asList(b.batches) : [])
const reasonOf = (failure) => (isObj(failure) ? String(failure.reason || '') : '')
const hasAction = (historyList, action) => asList(historyList).some((h) => isObj(h) && h.action === action)

/** 整棵树的内容快照（相对路径 : 字节数 : sha256）——只读路由"不写盘"的判据就是这个前后相等。 */
async function treeSnapshot(dir) {
  const out = []
  async function walk(current) {
    let entries
    try {
      entries = await fsp5.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      try {
        const bytes = await fsp5.readFile(full)
        out.push(path.relative(dir, full).split(path.sep).join('/') + ':' + bytes.length + ':' + sha256Of(bytes))
      } catch (err) {
        out.push(path.relative(dir, full).split(path.sep).join('/') + ':unreadable:' + String((err && err.message) || err))
      }
    }
  }
  await walk(dir)
  return out.sort()
}

// ── 5a. 纯函数：状态判定 / 计数 / 当前步骤 / 失败判据（离线，不碰盘）────────────
console.log('\n5a) 纯函数：状态判定 / 计数 / 当前步骤 / 失败判据（离线）')
const FAKE_DIR = 'D:/grok-output/rec'
const FAKE_NOW = Date.parse('2026-09-15T00:05:00.000Z')
const ledItem = (index, slug, bytes, sha) => ({
  at: '2026-09-15T00:01:00.000Z',
  index,
  slug,
  file: path.join(FAKE_DIR, String(index).padStart(2, '0') + '-' + slug + '.png'),
  bytes,
  sha256: sha,
  signature: '.png',
})
const entries3 = [{ index: 1, slug: 'one', title: '其一', prompt: 'p1' }, { index: 2, slug: 'two', title: '其二', prompt: 'p2' }, { index: 3, slug: 'three', title: '其三', prompt: 'p3' }]
// 故意塞一把 saveNonce：记录里**不许**出现它（nonce 只沿"派发"那条线走）。
const plan3 = { batchId: 'rec', createdAt: '2026-09-15T00:00:00.000Z', count: 3, entries: entries3, saveNonce: 'f'.repeat(64) }
const led3 = { batchId: 'rec', dir: FAKE_DIR, items: [ledItem(1, 'one', 10, 'h1'), ledItem(2, 'two', 20, 'h2'), ledItem(3, 'three', 30, 'h3')], updatedAt: '2026-09-15T00:02:00.000Z' }
/** 由账本条目造盘上事实；overrides 按序号覆盖（exists/bytes/sha256）。 */
const diskOf = (ledger, overrides) => {
  const map = new Map()
  for (const item of Array.isArray(ledger && ledger.items) ? ledger.items : []) {
    const patch = (overrides || {})[item.index] || {}
    map.set(item.file, {
      exists: patch.exists === undefined ? true : patch.exists,
      bytes: patch.bytes === undefined ? item.bytes : patch.bytes,
      sha256: patch.sha256 === undefined ? item.sha256 : patch.sha256,
    })
  }
  return map
}
const pure = (input) => {
  const value = call('buildGrokRunRecord', input)
  return isObj(value) ? value : {}
}
const pureBase = { plan: plan3, ledger: led3, verify: 'sha256', batchId: 'rec', dir: FAKE_DIR, now: FAKE_NOW }

ok('出口：buildGrokRunRecord / applyRunControl / normalizeRunControl / runRetryDriverDoc 都是函数',
  ['buildGrokRunRecord', 'applyRunControl', 'normalizeRunControl', 'runRetryDriverDoc'].every((k) => has(k, 'function')),
  ['buildGrokRunRecord', 'applyRunControl', 'normalizeRunControl', 'runRetryDriverDoc'].filter((k) => !has(k, 'function')))

const rOk = pure({ ...pureBase, disk: diskOf(led3) })
ok('① 全部项都有可校验产物 ⇒ status=succeeded', rOk.status === 'succeeded', rOk.status)
ok('① 计数 = 总 3 / 成功 3 / 失败 0 / 未跑 0', runCounts(rOk).total === 3 && runCounts(rOk).succeeded === 3 && runCounts(rOk).failed === 0 && runCounts(rOk).missing === 0, runCounts(rOk))
ok('① 一条记录 = 一个批次：runId 就是 batchId，且标明 kind', rOk.runId === 'rec' && rOk.batchId === 'rec' && rOk.kind === 'grok-batch', [rOk.runId, rOk.kind])
ok('① 当前步骤 done', runStepId(rOk) === 'done', rOk.step)
ok('① 产物位置逐项带回（路径/字节/sha256/序号/slug）',
  runArtifacts(rOk).length === 3 && at(runArtifacts(rOk), 0).file === ledItem(1, 'one', 10, 'h1').file
  && at(runArtifacts(rOk), 0).bytes === 10 && at(runArtifacts(rOk), 0).sha256 === 'h1' && at(runArtifacts(rOk), 0).index === 1
  && at(runArtifacts(rOk), 2).slug === 'three' && at(runArtifacts(rOk), 0).relFile === '01-one.png',
  at(runArtifacts(rOk), 0))
ok('① failures 为空、warnings 为空（没东西可重跑、也没什么可解释的）', runFailures(rOk).length === 0 && runWarnings(rOk).length === 0, runWarnings(rOk))
ok('① 记录里不含 nonce（记录不是钥匙的运输通道）', JSON.stringify(rOk).includes('saveNonce') === false && JSON.stringify(rOk).includes('f'.repeat(64)) === false)
ok('① 开始/更新时间取自事实（plan.createdAt → 最后一条产物时间）', rOk.startedAt === plan3.createdAt && rOk.updatedAt === led3.updatedAt, [rOk.startedAt, rOk.updatedAt])
ok('① 记录里写明三份文件的位置（plan/ledger/run）',
  rOk.planFile === path.join(FAKE_DIR, 'plan.json') && rOk.ledgerFile === path.join(FAKE_DIR, 'ledger.json') && rOk.runFile === path.join(FAKE_DIR, 'run.json'), [rOk.planFile, rOk.runFile])

const ledPart = { ...led3, items: [ledItem(1, 'one', 10, 'h1'), ledItem(2, 'two', 20, 'h2')] }
const rPart = pure({ ...pureBase, ledger: ledPart, disk: diskOf(ledPart, { 2: { exists: false } }) })
ok('② 一成一坏一未跑 ⇒ status=partial', rPart.status === 'partial', rPart.status)
ok('② 计数 = 总 3 / 成功 1 / 失败 1 / 未跑 1（恒等式 成功+失败+未跑=总数）',
  runCounts(rPart).total === 3 && runCounts(rPart).succeeded === 1 && runCounts(rPart).failed === 1 && runCounts(rPart).missing === 1
  && runCounts(rPart).succeeded + runCounts(rPart).failed + runCounts(rPart).missing === runCounts(rPart).total, runCounts(rPart))
ok('② 失败项清单按序号排、判据分开：坏的那项 file-missing、没跑的那项 never-run',
  runFailures(rPart).length === 2 && at(runFailures(rPart), 0).index === 2 && reasonOf(at(runFailures(rPart), 0)) === 'file-missing'
  && at(runFailures(rPart), 1).index === 3 && reasonOf(at(runFailures(rPart), 1)) === 'never-run',
  runFailures(rPart).map((f) => [f.index, f.reason]))
ok('② 失败原因带一句人话（不只是个枚举名）',
  runFailures(rPart).every((f) => typeof f.detail === 'string' && f.detail.length > 8), runFailures(rPart).map((f) => f.detail))
ok('② 没跑那项的"该落在哪"按 driver.md 的命名规矩推（03-three.png）',
  at(runFailures(rPart), 1).expectedFile === path.join(FAKE_DIR, '03-three.png'), at(runFailures(rPart), 1).expectedFile)
ok('② 坏掉那项的产物位置 = 账本记的路径（位置本来就是对的，是文件没了）',
  at(runFailures(rPart), 0).file === ledItem(2, 'two', 20, 'h2').file && at(runFailures(rPart), 0).expectedFile === ledItem(2, 'two', 20, 'h2').file,
  at(runFailures(rPart), 0))
ok('② 当前步骤 collect：收图中，已落 1 / 共 3（还差 2 项）',
  runStepId(rPart) === 'collect' && /已落 1 \/ 3/.test(runStepLabel(rPart)) && /还差 2 项/.test(runStepLabel(rPart)), runStepLabel(rPart))

const rBytes = pure({ ...pureBase, disk: diskOf(led3, { 2: { bytes: 999 } }) })
ok('② 字节数不符 ⇒ 失败项 reason=bytes-mismatch（stat 档也抓得到）',
  rBytes.status === 'partial' && reasonOf(runFailures(rBytes).find((f) => isObj(f) && f.index === 2)) === 'bytes-mismatch',
  runFailures(rBytes).map((f) => [f.index, f.reason]))
const rSha = pure({ ...pureBase, disk: diskOf(led3, { 3: { sha256: 'deadbeef' } }) })
ok('② 哈希不符 ⇒ 失败项 reason=sha256-mismatch（sha256 档才查得出）',
  rSha.status === 'partial' && reasonOf(runFailures(rSha).find((f) => isObj(f) && f.index === 3)) === 'sha256-mismatch',
  runFailures(rSha).map((f) => [f.index, f.reason]))
const rShaStat = pure({ ...pureBase, verify: 'stat', disk: diskOf(led3, { 3: { sha256: 'deadbeef' } }) })
ok('② 同一盘上事实在 stat 档看不出来（两档的差别是真的，不是文案差别）', rShaStat.status === 'succeeded', rShaStat.status)

const singleLed = { ...led3, items: [ledItem(1, 'one', 10, 'h1')] }
const rFail = pure({ ...pureBase, ledger: singleLed, disk: diskOf(singleLed, { 1: { exists: false } }) })
ok('② 一项都没成且有真失败 ⇒ status=failed、步骤 verify',
  rFail.status === 'failed' && runStepId(rFail) === 'verify' && runCounts(rFail).failed === 1 && runCounts(rFail).missing === 2,
  { status: rFail.status, counts: runCounts(rFail), step: runStepId(rFail) })
const rPending = pure({ ...pureBase, ledger: { items: [], updatedAt: '' }, disk: new Map() })
ok('② 一项都没跑 ⇒ status=pending、步骤 plan（批次已建立、待派发）',
  rPending.status === 'pending' && runStepId(rPending) === 'plan' && runCounts(rPending).missing === 3, { status: rPending.status, step: runStepId(rPending) })

const cancelControl = { running: null, cancelled: { at: '2026-09-15T00:04:00.000Z', by: 'probe', reason: '用户叫停' }, history: [{ action: 'cancel', at: '2026-09-15T00:04:00.000Z', by: 'probe', reason: '用户叫停' }] }
const rCancel = pure({ ...pureBase, ledger: ledPart, disk: diskOf(ledPart, { 2: { exists: false } }), control: cancelControl })
ok('④ 有取消标记 ⇒ status=cancelled（哪怕已经落了一半图）', rCancel.status === 'cancelled', rCancel.status)
ok('④ 取消的"谁/何时/为什么"进记录，且写进当前步骤那句话里',
  runMark(rCancel, 'cancelled').by === 'probe' && runMark(rCancel, 'cancelled').at === '2026-09-15T00:04:00.000Z'
  && runStepId(rCancel) === 'cancelled' && /probe/.test(runStepLabel(rCancel)) && /用户叫停/.test(runStepLabel(rCancel)),
  { cancelled: runMark(rCancel, 'cancelled'), step: rCancel.step })
ok('④ 取消不动计数（取消是状态标记，不是"把没跑的当成功"）', runCounts(rCancel).total === 3 && runCounts(rCancel).succeeded === 1 && runCounts(rCancel).missing === 1, runCounts(rCancel))
const runControlRunning = { running: { at: '2026-09-15T00:04:00.000Z', by: 'session', reason: '' }, cancelled: null, history: [] }
const rRunning = pure({ ...pureBase, ledger: ledPart, disk: diskOf(ledPart, { 2: { exists: false } }), control: runControlRunning })
ok('④ 登记过 begin ⇒ status=running、步骤 dispatch（宿主看不到那个浏览器会话，所以只认显式登记）',
  rRunning.status === 'running' && runStepId(rRunning) === 'dispatch' && /session/.test(runStepLabel(rRunning)), rRunning.step)
const rStale = pure({ ...pureBase, ledger: ledPart, disk: diskOf(ledPart, { 2: { exists: false } }), control: runControlRunning, now: Date.parse('2026-09-15T05:00:00.000Z') })
ok('④ begin 过期（默认 2 小时）就不再算运行中，退回由事实推导的状态，并留一句警告',
  rStale.status === 'partial' && runWarnings(rStale).some((w) => /不再算运行中/.test(w)), { status: rStale.status, warnings: runWarnings(rStale) })

const ledOrphan = { ...led3, items: [...led3.items, ledItem(9, 'manual', 40, 'h9')] }
const rOrphan = pure({ ...pureBase, ledger: ledOrphan, disk: diskOf(ledOrphan) })
ok('② 账上有、计划里没有的产物 ⇒ 记进 orphans 并留警告，**不**污染成功/失败计数',
  runCounts(rOrphan).total === 3 && runCounts(rOrphan).succeeded === 3 && runCounts(rOrphan).orphan === 1
  && runWarnings(rOrphan).some((w) => /不在本批计划里/.test(w)), { counts: runCounts(rOrphan), warnings: runWarnings(rOrphan) })
const ledDup = { ...led3, items: [ledItem(2, 'two', 20, 'h2'), ledItem(2, 'two', 20, 'h2')] }
const rDup = pure({ ...pureBase, ledger: ledDup, disk: diskOf(ledDup) })
ok('② 同一序号重存多次时以账本**最后一条**为准（前面的已被覆盖，不算重复成功）',
  runCounts(rDup).succeeded === 1 && runArtifacts(rDup).length === 1 && at(runArtifacts(rDup), 0).index === 2, runCounts(rDup))

// 三个动作的语义（纯函数）
const applyRun = (raw, action, opts) => {
  const value = call('applyRunControl', raw, action, opts)
  return isObj(value) ? value : {}
}
const begin1 = applyRun(null, 'begin', { at: '2026-09-15T01:00:00.000Z', by: 'session' })
const cancel1 = applyRun(begin1.control, 'cancel', { at: '2026-09-15T01:05:00.000Z', by: 'user', reason: '先停一下' })
const resume1 = applyRun(cancel1.control, 'begin', { at: '2026-09-15T01:10:00.000Z', by: 'plan-reissue', reason: '续跑' })
const clear1 = applyRun(cancel1.control, 'clear', { at: '2026-09-15T01:20:00.000Z', by: 'session' })
ok('④ 动作出口：begin 登记 running、cancel 登记 cancelled 并清掉 running',
  isObj(begin1.control) && isObj(begin1.control.running) && isObj(cancel1.control)
  && cancel1.control.cancelled !== null && cancel1.control.running === null,
  { begin: begin1.control && begin1.control.running, cancel: cancel1.control && cancel1.control.cancelled })
ok('④ begin 会解掉取消标记并留一条 resume（取消过不该永远不能再跑）',
  isObj(resume1.control) && resume1.control.cancelled === null && resume1.control.running.by === 'plan-reissue'
  && hasAction(resume1.control.history, 'resume') && resume1.control.history.filter((h) => h.action === 'begin').length === 2,
  asList(resume1.control && resume1.control.history).map((h) => h.action))
ok('④ clear 把两个标记都清掉（误标一次不至于让这一批废掉）',
  isObj(clear1.control) && clear1.control.running === null && clear1.control.cancelled === null && hasAction(clear1.control.history, 'clear'))
ok('④ 历史里每一次"谁/何时/做了什么"都留着（by/reason 都记）',
  isObj(cancel1.control) && asList(cancel1.control.history).some((h) => isObj(h) && h.action === 'cancel' && h.by === 'user' && h.reason === '先停一下' && h.at === '2026-09-15T01:05:00.000Z'),
  cancel1.control && cancel1.control.history)
ok('④ 不认识的 action 报错而不是静默当成 clear', typeof applyRun(null, 'nuke').error === 'string' && typeof applyRun(null, '').error === 'string',
  applyRun(null, 'nuke').error)

// ── 5b. 端到端：一次成功批次 ────────────────────────────────────────────────
console.log('\n5b) 端到端：一次成功批次 ⇒ succeeded 且产物齐全')
const planOkBody = {
  slug: 'rec-ok',
  grokUrl: 'https://grok.com/',
  entries: [{ index: 1, slug: 'one', title: '其一', prompt: '雨夜门廊，暖黄门灯，竖版构图。' }, { index: 2, slug: 'two', title: '其二', prompt: '巷口回头，冷调蓝紫，浅景深。' }],
}
const madeOk = await postJson(planUrl(), planOkBody)
const okDir = typeof madeOk.body.dir === 'string' ? madeOk.body.dir : ''
const okId = typeof madeOk.body.batchId === 'string' ? madeOk.body.batchId : ''
const okNonce = typeof madeOk.body.saveNonce === 'string' ? madeOk.body.saveNonce : ''
ok('① 建批次响应带 runFile 与 record（此刻还没图 ⇒ pending / 待派发）',
  madeOk.status === 200 && madeOk.body.ok === true && typeof madeOk.body.runFile === 'string'
  && isObj(madeOk.body.record) && madeOk.body.record.status === 'pending' && runStepId(madeOk.body.record) === 'plan',
  { status: madeOk.status, runFile: madeOk.body.runFile, record: madeOk.body.record && madeOk.body.record.status })
const imgOk1 = fakePng(320, 480, 2048, 0x5a5a0001)
const imgOk2 = fakeJpeg(640, 360, 3072, 0x5a5a0002)
const okSha1 = sha256Of(imgOk1)
const savedOk1 = await saveRaw(imgOk1, 'batch=' + encodeURIComponent(okId) + '&index=1&slug=one&nonce=' + encodeURIComponent(okNonce))
ok('① 存图响应带上记录侧进度（run/runStatus/remaining），老字段一个没动',
  savedOk1.status === 200 && savedOk1.body.status === 'saved' && savedOk1.body.bytes === imgOk1.length
  && typeof savedOk1.body.run === 'string' && savedOk1.body.runStatus === 'partial' && savedOk1.body.remaining === 1,
  { status: savedOk1.status, runStatus: savedOk1.body.runStatus, remaining: savedOk1.body.remaining })
await saveRaw(imgOk2, 'batch=' + encodeURIComponent(okId) + '&index=2&slug=two&ext=.jpg&nonce=' + encodeURIComponent(okNonce))
const recOk = await getJson(runUrl('batch=' + encodeURIComponent(okId)))
ok('① status=succeeded、计数 2/2/0/0', recOk.status === 200 && recOk.body.status === 'succeeded'
  && runCounts(recOk.body).total === 2 && runCounts(recOk.body).succeeded === 2 && runCounts(recOk.body).failed === 0 && runCounts(recOk.body).missing === 0,
  { status: recOk.status, body: recOk.body.status, counts: runCounts(recOk.body) })
ok('① 产物位置 + 字节 + sha256 + 尺寸逐项对得上（sha256 档是**重算**出来的）',
  runArtifacts(recOk.body).length === 2 && at(runArtifacts(recOk.body), 0).bytes === imgOk1.length
  && at(runArtifacts(recOk.body), 0).sha256 === okSha1 && at(runArtifacts(recOk.body), 0).verified === 'sha256'
  && at(runArtifacts(recOk.body), 1).sha256 === sha256Of(imgOk2) && recOk.body.verify === 'sha256',
  runArtifacts(recOk.body).map((a) => [a.index, a.bytes, String(a.sha256).slice(0, 8)]))
ok('① 产物位置就是本批目录里的那两张（每批一个目录的语义没被绕开）',
  runArtifacts(recOk.body).every((a) => path.dirname(a.file) === okDir) && at(runArtifacts(recOk.body), 0).relFile === '01-one.png'
  && at(runArtifacts(recOk.body), 1).relFile === '02-two.jpg', runArtifacts(recOk.body).map((a) => a.relFile))
ok('① failures 为空、当前步骤 done', runFailures(recOk.body).length === 0 && runStepId(recOk.body) === 'done', { failures: runFailures(recOk.body).length, step: runStepId(recOk.body) })
ok('① 只读查询不吐 nonce（门②那件事不许被新路由绕开）',
  JSON.stringify(recOk.body).includes(okNonce) === false && okNonce.length >= 32, okNonce.length)
const runFileOnDisk = path.join(okDir, 'run.json')
const diskRecord = existsSync(runFileOnDisk) ? JSON.parse(await fsp5.readFile(runFileOnDisk, 'utf8')) : {}
ok('① run.json 真的落盘了，且与查询口径一致（落盘与查询同一份推导）',
  isObj(diskRecord) && diskRecord.status === 'succeeded' && diskRecord.batchId === okId
  && isObj(diskRecord.counts) && diskRecord.counts.succeeded === 2, diskRecord && diskRecord.status)
ok('① 落盘的 run.json 里也没有 nonce', JSON.stringify(diskRecord).includes(okNonce) === false)
const viaPlan = await getJson(planUrl('batch=' + encodeURIComponent(okId)))
ok('① 既有只读路由 GET /dvp/grok/plan 顺带带回同一份 record（不用打两次）',
  viaPlan.status === 200 && isObj(viaPlan.body.record) && viaPlan.body.record.status === 'succeeded'
  && viaPlan.body.record.batchId === okId && JSON.stringify(viaPlan.body.record).includes(okNonce) === false,
  viaPlan.body.record && viaPlan.body.record.status)

// ── 5c. 端到端：部分缺图 ⇒ partial + 失败项清单 + 续跑/仅重试失败项 ───────────
console.log('\n5c) 端到端：部分缺图 ⇒ partial；续跑与"仅重试失败项"')
const entriesPart = [
  { index: 1, slug: 'one', title: '其一', prompt: '雨夜门廊，暖黄门灯，竖版构图。' },
  { index: 2, slug: 'two', title: '其二', prompt: '巷口回头，冷调蓝紫，浅景深。' },
  { index: 3, slug: 'three', title: '其三', prompt: '荧光药剂，青绿光自下而上。' },
]
const madePart = await postJson(planUrl(), { slug: 'rec-partial', grokUrl: 'https://grok.com/', entries: entriesPart })
const partDir = typeof madePart.body.dir === 'string' ? madePart.body.dir : ''
const partId = typeof madePart.body.batchId === 'string' ? madePart.body.batchId : ''
const partNonce = typeof madePart.body.saveNonce === 'string' ? madePart.body.saveNonce : ''
const imgPart1 = fakePng(200, 300, 1536, 0x6b6b0001)
const imgPart2 = fakePng(200, 300, 1536, 0x6b6b0002)
const imgPart3 = fakePng(200, 300, 1536, 0x6b6b0003)
const savedPart1 = await saveRaw(imgPart1, 'batch=' + encodeURIComponent(partId) + '&index=1&slug=one&nonce=' + encodeURIComponent(partNonce))
const savedPart2 = await saveRaw(imgPart2, 'batch=' + encodeURIComponent(partId) + '&index=2&slug=two&nonce=' + encodeURIComponent(partNonce))
const partFile1 = typeof savedPart1.body.file === 'string' ? savedPart1.body.file : ''
const partFile2 = typeof savedPart2.body.file === 'string' ? savedPart2.body.file : ''
ok('② 两项落图成功（其中一项马上会被我们删掉，模拟产物丢失）',
  savedPart1.status === 200 && savedPart2.status === 200 && partFile1 !== '' && partFile2 !== '', [savedPart1.status, savedPart2.status])
const partSha1 = sha256Of(imgPart1)
const mtimePart1Before = partFile1 !== '' && existsSync(partFile1) ? (await fsp5.stat(partFile1)).mtimeMs : 0
if (partFile2 !== '') await fsp5.rm(partFile2, { force: true })
const recPart = await getJson(runUrl('batch=' + encodeURIComponent(partId)))
ok('② status=partial，计数 3/1/1/1',
  recPart.status === 200 && recPart.body.status === 'partial' && runCounts(recPart.body).total === 3
  && runCounts(recPart.body).succeeded === 1 && runCounts(recPart.body).failed === 1 && runCounts(recPart.body).missing === 1,
  { status: recPart.body && recPart.body.status, counts: runCounts(recPart.body) })
ok('② 失败项清单 = [2 file-missing, 3 never-run]（清单就是"仅重试失败项"的输入）',
  runFailures(recPart.body).length === 2 && at(runFailures(recPart.body), 0).index === 2 && reasonOf(at(runFailures(recPart.body), 0)) === 'file-missing'
  && at(runFailures(recPart.body), 1).index === 3 && reasonOf(at(runFailures(recPart.body), 1)) === 'never-run',
  runFailures(recPart.body).map((f) => [f.index, f.reason]))
ok('② 产物位置正确：成功的那项指回本批目录里的真文件，坏的那项指回账本记的路径',
  runArtifacts(recPart.body).length === 1 && at(runArtifacts(recPart.body), 0).file === partFile1
  && at(runArtifacts(recPart.body), 0).sha256 === partSha1 && at(runFailures(recPart.body), 0).file === partFile2,
  { artifacts: runArtifacts(recPart.body).map((a) => a.relFile), lost: at(runFailures(recPart.body), 0).file })
ok('② 当前步骤 collect（已落 1 / 共 3，还差 2）', runStepId(recPart.body) === 'collect' && /已落 1 \/ 3/.test(runStepLabel(recPart.body)), runStepLabel(recPart.body))

const recPartDriver = await getJson(runUrl('batch=' + encodeURIComponent(partId) + '&driver=1'))
const driverText = typeof recPartDriver.body.retryDriver === 'string' ? recPartDriver.body.retryDriver : ''
ok('③ driver=1 给出"仅重试失败项"清单（默认响应里没有这段，按需才带）',
  recPartDriver.status === 200 && driverText.length > 0 && typeof recPart.body.retryDriver === 'undefined', driverText.slice(0, 60))
ok('③ 清单只含该重跑的两项（02 / 03），**不含**已成功的那项（01）',
  driverText.includes('02. 其二') && driverText.includes('03. 其三') && !driverText.includes('01. 其一'),
  driverText.split('\n').filter((l) => l.startsWith('### ')))
ok('③ 清单写明"只重跑 2 项、已成功的 1 项不再投、不新建批次"',
  /只重跑下面 2 项/.test(driverText) && /不新建批次/.test(driverText) && /已成功的那 1 项/.test(driverText))
ok('③ 重跑命令复用既有 batch= 机制（同一批、同一目录），并逐项带上序号/slug',
  driverText.includes('batch=' + partId + '&index=2&slug=two') && driverText.includes('batch=' + partId + '&index=3&slug=three')
  && driverText.includes('/dvp/grok/save'))
ok('③ 清单里没有 nonce 本身（只指向本批 plan.json 去读），也没有把 base64 搬回会话的写法',
  driverText.includes(partNonce) === false && driverText.includes(path.join(partDir, 'plan.json')) && b64Total(driverText) === 0)
ok('③ 清单带上每一项的提示词正文（重跑时不用再翻别的地方）',
  driverText.includes('巷口回头，冷调蓝紫，浅景深。') && driverText.includes('荧光药剂，青绿光自下而上。')
  && !driverText.includes('雨夜门廊，暖黄门灯，竖版构图。'))

// 续跑：对**同一个批次**重发 plan（既有机制）⇒ 写回同一目录、不新建、并登记 begin（续跑这件事本身）
const dirsBeforeResume = (await fsp5.readdir(RUN_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory()).length
const resumed = await postJson(planUrl(), { batchId: partId, slug: 'rec-partial', grokUrl: 'https://grok.com/', entries: entriesPart })
const dirsAfterResume = (await fsp5.readdir(RUN_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory()).length
const resumeNonce = typeof resumed.body.saveNonce === 'string' ? resumed.body.saveNonce : ''
ok('③ 续跑 = 对同一批次重发 plan：写回同一目录、不新建目录、总数不变',
  resumed.status === 200 && resumed.body.dir === partDir && resumed.body.batchId === partId
  && resumed.body.count === 3 && dirsAfterResume === dirsBeforeResume, { dir: resumed.body.dir, before: dirsBeforeResume, after: dirsAfterResume })
const recResumed = await getJson(runUrl('batch=' + encodeURIComponent(partId) + '&verify=stat'))
ok('③ 续跑被登记成 running（谁登记的、何时开始，记录里都有）',
  recResumed.status === 200 && recResumed.body.status === 'running' && runMark(recResumed.body, 'running').by === 'plan-reissue'
  && hasAction(runHistory(recResumed.body), 'begin'),
  { status: recResumed.body && recResumed.body.status, running: runMark(recResumed.body, 'running'), history: runHistory(recResumed.body).map((h) => h.action) })
ok('③ 续跑不动已成功的那项：它还在产物清单里，sha256 与刚才一致',
  runArtifacts(recResumed.body).length === 1 && at(runArtifacts(recResumed.body), 0).sha256 === partSha1 && runCounts(recResumed.body).succeeded === 1,
  runArtifacts(recResumed.body).map((a) => a.relFile))
// 只补失败的那两项（用新 nonce，走同一批）
await saveRaw(imgPart2, 'batch=' + encodeURIComponent(partId) + '&index=2&slug=two&nonce=' + encodeURIComponent(resumeNonce))
const finalSave = await saveRaw(imgPart3, 'batch=' + encodeURIComponent(partId) + '&index=3&slug=three&nonce=' + encodeURIComponent(resumeNonce))
const recDone = await getJson(runUrl('batch=' + encodeURIComponent(partId)))
ok('③ 只重跑那两项之后 status=succeeded、计数 3/3/0/0、failures 空（续跑真的把批补齐了）',
  recDone.status === 200 && recDone.body.status === 'succeeded' && runCounts(recDone.body).succeeded === 3
  && runCounts(recDone.body).failed === 0 && runCounts(recDone.body).missing === 0 && runFailures(recDone.body).length === 0,
  { status: recDone.body && recDone.body.status, counts: runCounts(recDone.body) })
ok('③ 补的那两张都落在本批目录（没另起目录、没盖掉第一张）',
  runArtifacts(recDone.body).length === 3 && runArtifacts(recDone.body).every((a) => path.dirname(a.file) === partDir)
  && at(runArtifacts(recDone.body), 0).sha256 === partSha1 && at(runArtifacts(recDone.body), 1).sha256 === sha256Of(imgPart2)
  && at(runArtifacts(recDone.body), 2).file === finalSave.body.file,
  runArtifacts(recDone.body).map((a) => a.relFile))
const mtimePart1After = partFile1 !== '' && existsSync(partFile1) ? (await fsp5.stat(partFile1)).mtimeMs : 0
ok('③ 续跑/补图全程没重写已成功的那张图（mtime 都没变）',
  mtimePart1Before > 0 && mtimePart1After === mtimePart1Before, { before: mtimePart1Before, after: mtimePart1After })

// ── 5d. 取消：只记语义（谁 / 何时 / 为什么），不动产物 ────────────────────────
console.log('\n5d) 取消：显式记录 cancelled 语义（没有真中断机制，也不新造杀进程逻辑）')
const entriesCancel = [
  { index: 1, slug: 'one', title: '其一', prompt: '雨夜门廊，暖黄门灯。' },
  { index: 2, slug: 'two', title: '其二', prompt: '巷口回头，冷调蓝紫。' },
]
const madeCancel = await postJson(planUrl(), { slug: 'rec-cancel', grokUrl: 'https://grok.com/', entries: entriesCancel })
const cancelDir = typeof madeCancel.body.dir === 'string' ? madeCancel.body.dir : ''
const cancelId = typeof madeCancel.body.batchId === 'string' ? madeCancel.body.batchId : ''
const cancelNonce = typeof madeCancel.body.saveNonce === 'string' ? madeCancel.body.saveNonce : ''
const imgCancel = fakePng(128, 128, 1024, 0x7c7c0001)
const savedCancel = await saveRaw(imgCancel, 'batch=' + encodeURIComponent(cancelId) + '&index=1&slug=one&nonce=' + encodeURIComponent(cancelNonce))
const cancelFile = typeof savedCancel.body.file === 'string' ? savedCancel.body.file : ''
const cancelShaBefore = cancelFile !== '' && existsSync(cancelFile) ? sha256Of(await fsp5.readFile(cancelFile)) : ''
const cancelMtimeBefore = cancelFile !== '' && existsSync(cancelFile) ? (await fsp5.stat(cancelFile)).mtimeMs : 0
const cancelled = await postJson(runUrl(), { batchId: cancelId, action: 'cancel', by: 'probe', reason: '用户叫停' })
ok('④ 登记取消返回 status=cancelled，并写明谁/何时/为什么',
  cancelled.status === 200 && cancelled.body.status === 'cancelled'
  && runMark(cancelled.body, 'cancelled').by === 'probe'
  && String(runMark(cancelled.body, 'cancelled').reason) === '用户叫停'
  && Number.isFinite(Date.parse(String(runMark(cancelled.body, 'cancelled').at))),
  { status: cancelled.body && cancelled.body.status, cancelled: runMark(cancelled.body, 'cancelled') })
ok('④ 当前步骤那句话就是"已取消（谁 于 何时：为什么）"',
  runStepId(cancelled.body) === 'cancelled' && /probe/.test(runStepLabel(cancelled.body)) && /用户叫停/.test(runStepLabel(cancelled.body)), runStepLabel(cancelled.body))
ok('④ 历史里留下这一条（谁做的、何时、做了什么）',
  runHistory(cancelled.body).some((h) => isObj(h) && h.action === 'cancel' && h.by === 'probe' && h.reason === '用户叫停'),
  runHistory(cancelled.body))
ok('④ 取消**不动产物**：那张图还在、字节与 sha256 一个字没变，计数也照旧',
  cancelFile !== '' && existsSync(cancelFile) && sha256Of(await fsp5.readFile(cancelFile)) === cancelShaBefore
  && (await fsp5.stat(cancelFile)).mtimeMs === cancelMtimeBefore
  && runCounts(cancelled.body).total === 2 && runCounts(cancelled.body).succeeded === 1 && runCounts(cancelled.body).missing === 1,
  { file: cancelFile, sha: String(cancelShaBefore).slice(0, 8), counts: runCounts(cancelled.body) })
const cancelDisk = cancelDir !== '' && existsSync(path.join(cancelDir, 'run.json'))
  ? JSON.parse(await fsp5.readFile(path.join(cancelDir, 'run.json'), 'utf8'))
  : {}
ok('④ 取消落到盘上（run.json 里就是 cancelled + 那条 control）',
  isObj(cancelDisk) && cancelDisk.status === 'cancelled' && isObj(cancelDisk.control) && isObj(cancelDisk.control.cancelled)
  && cancelDisk.control.cancelled.by === 'probe', cancelDisk && cancelDisk.status)
const cleared = await postJson(runUrl(), { batchId: cancelId, action: 'clear', by: 'probe', reason: '误标' })
ok('④ clear 之后退回按事实推导的状态（partial：1 成一未跑）',
  cleared.status === 200 && cleared.body.status === 'partial' && runControl(cleared.body).cancelled === null, { status: cleared.body && cleared.body.status })
const cancelled2 = await postJson(runUrl(), { batchId: cancelId, action: 'cancel', by: 'probe' })
const resumedAfterCancel = await postJson(planUrl(), { batchId: cancelId, slug: 'rec-cancel', grokUrl: 'https://grok.com/', entries: entriesCancel })
const afterCancelResume = await getJson(runUrl('batch=' + encodeURIComponent(cancelId)))
ok('④ 取消之后重发 plan = 续跑：取消标记被解掉，历史里留一条 resume（"取消过就永远不能再跑"不成立）',
  cancelled2.body.status === 'cancelled' && resumedAfterCancel.status === 200
  && afterCancelResume.body.status === 'running' && runControl(afterCancelResume.body).cancelled === null
  && hasAction(runHistory(afterCancelResume.body), 'resume'),
  { status: afterCancelResume.body && afterCancelResume.body.status, history: runHistory(afterCancelResume.body).map((h) => h.action) })
const badAction = await postJson(runUrl(), { batchId: cancelId, action: 'nuke' })
const noBatch = await postJson(runUrl(), { action: 'cancel' })
const unknownBatch = await postJson(runUrl(), { batchId: 'no-such-batch-here', action: 'cancel' })
const legacyControl = await postJson(runUrl(), { batchId: 'legacy', action: 'cancel' })
ok('④ 坏输入都有明确拒绝：未知动作 400 / 没给批次 400 / 批次不存在 404 / legacy 只读别名 400',
  badAction.status === 400 && noBatch.status === 400 && unknownBatch.status === 404 && legacyControl.status === 400,
  { badAction: badAction.status, noBatch: noBatch.status, unknownBatch: unknownBatch.status, legacy: legacyControl.status })
ok('④ 被拒的登记没有在盘上留下任何东西（那个批次目录根本没被建出来）',
  !existsSync(path.join(RUN_ROOT, 'no-such-batch-here')) && /不存在/.test(String(unknownBatch.body.error || '')),
  unknownBatch.body.error)

// ── 5e. 向后兼容：旧批次（没有 run.json、账本条目是旧字段）仍能读 ─────────────
console.log('\n5e) 向后兼容：旧批次没有 run.json 也读得出来，且读它不会"补"出一份 run.json')
const oldDir = path.join(RUN_ROOT, '2026-09-01_0000-old-shape')
await fsp5.mkdir(oldDir, { recursive: true })
// 旧形状的 plan.json（没有 batchId/saveNonce 之外的新字段）与旧形状的账本（条目里没有 signature）
const oldPlan = {
  createdAt: '2026-09-01T00:00:00.000Z',
  dir: oldDir,
  count: 2,
  entries: [{ index: 1, slug: 'old-one', title: '旧其一', prompt: '旧提示词一' }, { index: 2, slug: 'old-two', title: '旧其二', prompt: '旧提示词二' }],
}
const oldBytes = fakePng(64, 64, 1024, 0x8d8d0001)
const oldFile = path.join(oldDir, '01-old-one.png')
await fsp5.writeFile(oldFile, oldBytes)
await fsp5.writeFile(path.join(oldDir, 'plan.json'), JSON.stringify(oldPlan, null, 2), 'utf8')
await fsp5.writeFile(path.join(oldDir, 'ledger.json'), JSON.stringify({
  items: [{ at: '2026-09-01T00:01:00.000Z', index: 1, slug: 'old-one', file: oldFile, bytes: oldBytes.length, sha256: sha256Of(oldBytes) }],
  updatedAt: '2026-09-01T00:01:00.000Z',
}, null, 2), 'utf8')
const oldId = '2026-09-01_0000-old-shape'
const recOld = await getJson(runUrl('batch=' + encodeURIComponent(oldId)))
ok('⑥ 旧批次读得出记录：status=partial、计数 2/1/0/1（按 plan + 旧账本推导）',
  recOld.status === 200 && recOld.body.status === 'partial' && runCounts(recOld.body).total === 2
  && runCounts(recOld.body).succeeded === 1 && runCounts(recOld.body).missing === 1, { status: recOld.body && recOld.body.status, counts: runCounts(recOld.body) })
ok('⑥ 旧账本条目（没有 signature 等新字段）照样计入产物，位置/字节/sha256 都对得上',
  runArtifacts(recOld.body).length === 1 && runArtifacts(recOld.body)[0].file === oldFile
  && runArtifacts(recOld.body)[0].sha256 === sha256Of(oldBytes) && runArtifacts(recOld.body)[0].bytes === oldBytes.length,
  runArtifacts(recOld.body))
ok('⑥ 它标成 derived（盘上本来就没有 run.json 这一份），当前步骤 collect（已落 1 / 共 2）',
  recOld.body.source === 'derived' && runStepId(recOld.body) === 'collect' && /已落 1 \/ 2/.test(runStepLabel(recOld.body)),
  { source: recOld.body.source, step: runStepLabel(recOld.body) })
ok('⑥ 读旧批次**不会**给它凭空补一份 run.json（只读就是不写）', !existsSync(path.join(oldDir, 'run.json')))
ok('⑥ 旧批次的 plan.json / ledger.json 一个字节没被动过（哈希与刚写的相同）',
  sha256Of(await fsp5.readFile(path.join(oldDir, 'plan.json'))) === sha256Of(Buffer.from(JSON.stringify(oldPlan, null, 2), 'utf8'))
  && JSON.parse(await fsp5.readFile(path.join(oldDir, 'ledger.json'), 'utf8')).items.length === 1)
const oldPlanRead = await getJson(planUrl('batch=' + encodeURIComponent(oldId)))
ok('⑥ 既有路由也仍然读得回这一批（老字段口径没变）',
  oldPlanRead.status === 200 && isObj(oldPlanRead.body.plan) && oldPlanRead.body.plan.count === 2
  && oldPlanRead.body.plan.entries[0].title === '旧其一', oldPlanRead.body.plan && oldPlanRead.body.plan.count)

// ── 5f. 列表路由：最近若干批 ────────────────────────────────────────────────
console.log('\n5f) /dvp/grok/runs · 最近若干批（只读，stat 档）')
const listAll = await getJson(runsUrl())
const listBatches = runBatches(listAll.body)
const listIds = listBatches.map((b) => b.batchId)
ok('列表读出最近若干批，含我们刚建的这几批（含旧形状那批）',
  listAll.status === 200 && listAll.body.ok === true && [okId, partId, cancelId, oldId].every((id) => listIds.includes(id)), listIds.slice(0, 8))
ok('每一批都带状态/当前步骤/计数/待重跑条数',
  listBatches.length > 0 && listBatches.every((b) => typeof b.status === 'string'
    && isObj(b.step) && typeof b.step.id === 'string' && isObj(b.counts) && typeof b.retryCount === 'number'), listBatches[0])
ok('状态只可能是那六个之一（不出现自造状态）',
  listBatches.length > 0 && listBatches.every((b) => ['pending', 'running', 'partial', 'succeeded', 'failed', 'cancelled'].includes(b.status)),
  listBatches.map((b) => b.status))
ok('列表的 stat 档与明细的 sha256 档结论一致（两档只是校验强度不同，不是口径不同）',
  (listBatches.find((b) => b.batchId === okId) || {}).status === 'succeeded'
  && (listBatches.find((b) => b.batchId === cancelId) || {}).status === afterCancelResume.body.status,
  { ok: (listBatches.find((b) => b.batchId === okId) || {}).status, cancel: (listBatches.find((b) => b.batchId === cancelId) || {}).status })
const listTwo = await getJson(runsUrl('limit=2'))
ok('limit 生效（limit=2 ⇒ 最多 2 条）', listTwo.status === 200 && runBatches(listTwo.body).length <= 2 && runBatches(listTwo.body).length > 0,
  runBatches(listTwo.body).length)
ok('列表里的 retryCount 与明细里 failures 条数一致（"要重跑几项"两个口径对得上）',
  (() => {
    const hit = listBatches.find((b) => b.batchId === cancelId)
    return hit === undefined ? false : hit.retryCount === runFailures(afterCancelResume.body).length
  })(), listBatches.find((b) => b.batchId === cancelId))

// ── 5g. 只读审计：查询路由不写盘（整树 sha256 前后比对）────────────────────────
console.log('\n5g) 只读审计：打一遍所有只读查询，整个 grok-output 树逐字节不变')
const idxBeforeRead = existsSync(path.join(RUN_ROOT, 'index.json'))
const beforeRead = await treeSnapshot(RUN_ROOT)
const readOnlyHits = []
readOnlyHits.push(await getJson(runUrl('batch=' + encodeURIComponent(okId))))
readOnlyHits.push(await getJson(runUrl('batch=' + encodeURIComponent(okId) + '&driver=1')))
readOnlyHits.push(await getJson(runUrl('batch=' + encodeURIComponent(partId) + '&verify=stat')))
readOnlyHits.push(await getJson(runUrl('batch=' + encodeURIComponent(oldId))))
readOnlyHits.push(await getJson(runsUrl('limit=50')))
readOnlyHits.push(await getJson(planUrl('batch=' + encodeURIComponent(partId))))
readOnlyHits.push(await getJson(planUrl()))
readOnlyHits.push(await getJson(runUrl('batch=does-not-exist-zzz')))
readOnlyHits.push(await getJson(runUrl()))
const afterRead = await treeSnapshot(RUN_ROOT)
ok('⑤ 只读查询全部 200/404（没有一条把状态码打成 5xx：查询不许因为读不到东西而炸）',
  readOnlyHits.every((hit) => hit.status === 200 || hit.status === 404), readOnlyHits.map((h) => h.status))
ok('⑤ 打完整整一轮只读查询后，整个 grok-output 树逐字节不变（' + beforeRead.length + ' 个文件：相对路径+字节数+sha256）',
  beforeRead.length > 0 && JSON.stringify(beforeRead) === JSON.stringify(afterRead),
  { before: beforeRead.length, after: afterRead.length, diff: beforeRead.filter((x, i) => x !== afterRead[i]).slice(0, 3) })
ok('⑤ 查询没有偷偷新建文件（含 index.json / run.json 都不许被"顺手刷一下"）',
  beforeRead.length === afterRead.length, { before: beforeRead.length, after: afterRead.length })
ok('⑤ 索引文件的存在性也没被查询改变（只有写操作才动它）', idxBeforeRead === existsSync(path.join(RUN_ROOT, 'index.json')))


// 收尾：先掐断 keep-alive 连接再关服务、清临时区（Windows 上文件句柄没放干净 rm 会 EBUSY）。
await new Promise((resolve) => server.close(resolve))
try {
  await fsp.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
} catch (err) {
  console.log('  · 临时区未能删净（不影响结论）：' + String((err && err.message) || err))
}

const summary = failures === 0 ? '全部通过：' + checks + ' 项检查' : failures + ' / ' + checks + ' 项失败'
console.log('\n' + summary)
// 不用 process.exit()：Windows 上 libuv 偶发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// （退出时异步句柄正在关）。置 exitCode 让事件循环自然收尾，退出码一样准。
process.exitCode = failures === 0 ? 0 : 1
