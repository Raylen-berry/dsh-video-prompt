// 把包根 client.js 同步到 servable/client.js（组件预览页读的就是这一份）。
//
//   node tools/sync-servable.mjs
//
// 为什么需要它：预览页（/dvp/preview/）由宿主按包内白名单目录 servable/ 提供静态文件，
// 它引用的 ./client.js 是**独立副本**。改完包根 client.js 忘了同步，预览页就会继续演旧版，
// 于是"预览页看得见、DSH 里看不见"或反过来的假象都会出现（2026-09-11 实测踩过一次）。
// selfcheck 里有一条断言盯着两份文件的 sha256 是否一致。

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PKG = path.resolve(HERE, '..')
const SRC = path.join(PKG, 'client.js')
const DST = path.join(PKG, 'servable', 'client.js')

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

if (!existsSync(SRC)) {
  console.error('找不到源文件：' + SRC)
  process.exit(1)
}

const source = readFileSync(SRC)
const before = existsSync(DST) ? readFileSync(DST) : null
if (before !== null && sha(before) === sha(source)) {
  console.log('已同步，无需改动：servable/client.js 与 client.js 一致（sha256 ' + sha(source).slice(0, 12) + '）')
  process.exit(0)
}

writeFileSync(DST, source)
const after = readFileSync(DST)
console.log('已同步 servable/client.js')
console.log('  源：' + SRC + '（' + source.length + ' 字节）')
console.log('  目标：' + DST + '（' + after.length + ' 字节）')
console.log('  sha256：' + sha(after))
if (before !== null) console.log('  覆盖前大小：' + before.length + ' 字节')
