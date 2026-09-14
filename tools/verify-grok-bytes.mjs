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

// 收尾：先掐断 keep-alive 连接再关服务、清临时区（Windows 上文件句柄没放干净 rm 会 EBUSY）。
if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
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
