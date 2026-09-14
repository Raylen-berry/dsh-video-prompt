#!/usr/bin/env node
// tools/run-all.mjs —— 发布前检查总入口：本地与 CI 跑的是同一条命令（npm test）。
//
//   node tools/run-all.mjs          跑全部：每套都跑完再汇总
//   node tools/run-all.mjs --list   只列清单，不执行
//
// 为什么不用 `a.mjs && b.mjs` 串：第一套一失败后面的根本不跑，一次 push 只能暴露一个错误。
// 这里每套都跑、逐套列结果，任一套非 0 退出 ⇒ 本进程退出码 1 ⇒ CI 变红。
//
// 本清单只含**离线套件**：测试执行期间**不联网**（不做真实下载、不调模型）、不读真实媒体盘。
// 需要真实媒体盘的套件写在 EXCLUDED 里（含原因），不参与 CI。
// selfcheck 需要一份 react / react-dom：由 package.json 的 devDependencies 声明、CI 的 npm ci 装出 ——
// 依赖是"装出来"的，不是"测试时下载的"。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

// ---- 仓库配置 -------------------------------------------------------------
const CHECKS = []

const SUITES = [
  'tools/probe-host.mjs',
  'tools/verify-watch-idle.mjs',
  // 图片字节不许进会话文本：raw bytes 直传 /dvp/grok/save + 会话文本 base64=0 的量化断言。
  // 假图自己捏（固定种子伪随机字节，≥1 MiB），不联网、不读真实媒体盘、不用浏览器。
  'tools/verify-grok-bytes.mjs',
  // selfcheck 里的面板渲染要一份真 react / react-dom（createRequire(DSH_APP_DIR/package.json) 解析）。
  // 原来它指向**本机 DSH 安装目录**（DSH_APP_DIR 没设时还会从 process.execPath 反推），
  // 于是"本机全绿、干净机器/CI 全红"。现在由下面的 ENV 把 DSH_APP_DIR 指向**仓库根**，
  // 配合 package.json 的 devDependencies（react + react-dom）就能在干净环境跑通 —— 2026-09 从 EXCLUDED 挪回。
  'tools/selfcheck.mjs',
]

const EXCLUDED = [
  ['tools/probe-live.mjs', '要真实媒体盘里的素材文件才能跑（探针脚本，不是断言式套件）'],
]

// 让套件按**本仓库实际位置**解析插件与 react，不依赖任何人的绝对路径或本机 DSH 安装目录。
// DSH_APP_DIR 指向仓库根：selfcheck.mjs 用它 createRequire('<repo>/package.json')，
// 于是 'react' / 'react-dom' 解析到仓库自己的 node_modules（CI 由 npm ci 装出）。
const ENV = {
  DSH_APP_DIR: REPO,
}

// ---- 登记完备性 + 已知失败 ------------------------------------------------
// tools/ 下每个「看起来是套件」的文件都必须在 SUITES / EXCLUDED / KNOWN_FAILING 里登记，
// 否则本进程直接失败 —— 防止以后新增套件被静默漏掉（同一个不变量原来由 browser-live 的
// verify-manifest.mjs 断言 package.json 里那个长串来保证）。
const DISCOVERY = (n) => /^(verify|test|probe)-.*\.mjs$/.test(n) || n === 'selfcheck.mjs'

// 已知失败：仍然跑、结果照列，但**不**让整体变红（每条都必须写明原因）。
const KNOWN_FAILING = []

// ---- 执行器 ---------------------------------------------------------------
const results = []
const t = (ms) => (ms / 1000).toFixed(1) + 's'

function summarize(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const cand = [...lines].reverse().find((l) => /passed|通过|failed|失败/.test(l))
  if (cand) return cand.trim()
  const n = lines.filter((l) => /^\s*(PASS|✓|✔|OK)\b/.test(l)).length
  return n ? n + ' 项（按 PASS 行计数）' : '（无输出）'
}

function run(kind, file) {
  const args = kind === 'check' ? ['--check', file] : [file]
  const started = Date.now()
  const s = spawnSync(process.execPath, args, {
    cwd: REPO, env: { ...process.env, ...ENV }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const out = (s.stdout || '') + (s.stderr || '')
  const code = s.status === null ? 1 : s.status
  const ok = code === 0
  results.push({ kind, file, ok, code, ms: Date.now() - started, summary: summarize(out) })
  console.log('\n' + '─'.repeat(72))
  console.log((ok ? '✅ ' : '❌ ') + file + '   exit=' + code + '  ' + t(Date.now() - started))
  console.log('─'.repeat(72))
  if (out.trim()) console.log(out.replace(/\s+$/, ''))
  if (s.error) console.log('!! spawn 失败：' + s.error.message)
  return ok
}

function checkRegistry() {
  const reg = new Set([...SUITES, ...EXCLUDED.map((e) => e[0]), ...KNOWN_FAILING.map((e) => e[0])]
    .map((f) => path.basename(String(f).split(' ')[0])))
  const missing = fs.readdirSync(path.join(REPO, 'tools')).filter(DISCOVERY).filter((n) => !reg.has(n))
  if (missing.length) {
    console.error('✗ 有套件没登记到 tools/run-all.mjs（SUITES / EXCLUDED / KNOWN_FAILING 三选一）：' + missing.join(', '))
    process.exit(1)
  }
}

checkRegistry()

if (LIST_ONLY) {
  console.log('语法门禁：' + (CHECKS.length ? CHECKS.join(', ') : '（无）'))
  console.log('测试套件：')
  for (const f of SUITES) console.log('  · ' + f)
  console.log('未纳入 CI：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + ' —— ' + why)
  if (KNOWN_FAILING.length) {
    console.log('已知失败（仍跑、不拦截）：')
    for (const [f, why] of KNOWN_FAILING) console.log('  · ' + f + ' —— ' + why)
  }
  process.exit(0)
}

console.log('dsh-video-prompt 发布前检查（离线）· node ' + process.version)
console.log('仓库：' + REPO)
for (const f of CHECKS) run('check', f)
for (const f of SUITES) run('suite', f)

const checks = results.filter((r) => r.kind === 'check')
const suites = results.filter((r) => r.kind === 'suite')
const knownNames = new Set(KNOWN_FAILING.map((e) => path.basename(e[0])))
const isKnown = (r) => knownNames.has(path.basename(r.file))
const bad = results.filter((r) => !r.ok && !isKnown(r))
const known = results.filter((r) => !r.ok && isKnown(r))

console.log('\n' + '='.repeat(72))
console.log('汇总')
console.log('='.repeat(72))
for (const r of results) console.log((r.ok ? ' ✅ ' : ' ❌ ') + r.file.padEnd(38) + t(r.ms).padStart(6) + '  ' + r.summary)
console.log('-'.repeat(72))
console.log('语法门禁 ' + checks.filter((r) => r.ok).length + '/' + checks.length +
  '　套件 ' + suites.filter((r) => r.ok).length + '/' + suites.length + ' 通过')
if (EXCLUDED.length) {
  console.log('\n未纳入 CI 的套件（原因）：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + '\n      ' + why)
}
if (known.length) {
  console.log('\n⚠ 已知失败（不拦截整体退出码，原因见本文件 KNOWN_FAILING）：')
  for (const r of known) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
if (bad.length) {
  console.log('\n失败套件：')
  for (const r of bad) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
console.log('\n' + (bad.length ? '✗ 有套件失败 —— 整体失败' : '✓ 全部通过'))
process.exit(bad.length ? 1 : 0)
