// 离线断言：watch-downloads 的**空闲退出**判据。
//
//   node tools/verify-watch-idle.mjs
//
// 验的是这一条缺陷：脚本原来用 `idleRounds` 计"连续空闲轮数"，但**收到图之后不重置**，
// 于是第 5 轮（received > 0 且 idleRounds >= 4）必定退出 —— 边投提示词边出图的长批次
// 会被半路掐断，用户看到的就是"还有图在出，守护却收工了"。
//
// 这里用假时钟 + 假 sleep 把时间快进，所以整个文件跑完只花几百毫秒，不碰真实下载目录：
// 素材与账本全部写在 <包>/tools/.verify-tmp/ 下，跑完删掉。

import { promises as fsp, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PKG = path.resolve(HERE, '..')
const TMP = path.join(HERE, '.verify-tmp', 'watch-idle')

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

const { watchDownloads } = await import(pathToFileURL(path.join(PKG, 'tools', 'watch-downloads.mjs')).href)

const MIN_BYTES = 1024
const ROUND_MS = 5000
const IDLE_MS = 20 * 1000

/** 造一个假世界：假时钟 + 假 sleep + 一个下载目录；`plan(round)` 决定下一轮放不放图。 */
async function scenario(name, { minutes, plan, idleExitMs = IDLE_MS }) {
  const dir = path.join(TMP, name)
  const srcDir = path.join(dir, 'src')
  const outDir = path.join(dir, 'out')
  await fsp.mkdir(srcDir, { recursive: true })
  await fsp.mkdir(outDir, { recursive: true })
  const state = { now: 0, round: 0 }
  let planCalls = 0
  // 每次内容都不同 → sha256 不同，不会被"已处理过"跳过
  async function addImage(round) {
    const file = path.join(srcDir, 'shot-' + round + '.png')
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(MIN_BYTES + round, round & 0xff)]))
    return file
  }
  // sleep 被调用的时刻 = 这一轮扫完、下一轮开始之前，所以在这里投下一轮的图
  const sleep = async (ms) => {
    state.now += ms
    state.round += 1
    planCalls += 1
    if (plan(state.round)) await addImage(state.round)
  }
  const result = await watchDownloads({
    outDir,
    srcDir,
    entries: [],
    minBytes: MIN_BYTES,
    minutes,
    idleExitMs,
    roundMs: ROUND_MS,
    clock: () => state.now,
    sleep,
    quiet: true,
  })
  return { world: { state, srcDir, outDir }, result, diag: () => ({ planCalls, rounds: state.round, now: state.now }) }
}

await fsp.rm(TMP, { recursive: true, force: true })

console.log('\n1) 边投边出图：收到图之后的空闲计时必须归零（旧实现必挂）')
{
  // 每轮都有新图（一直投到时限结束，6 分钟 = 72 轮）：只要"收到图不重置计时"，
  // 旧实现就会在第 5 轮（约 25 秒）break。上限 6 分钟 ⇒ 唯一可能的收工理由是"等满时限"。
  const { world, result, diag } = await scenario('always-new', {
    minutes: 6,
    plan: () => 'new',
  })
  ok('一直有图时不因"连续空闲"退出（reason=deadline）', result.reason === 'deadline', result.reason)
  ok('收到远多于 5 张（旧实现第 5 轮就停）', result.received >= 30, result.received)
  ok('账本条数与收到张数一致', result.ledger.items.length === result.received, { items: result.ledger.items.length, received: result.received })
  ok('每张都真的落盘了', result.ledger.items.every((i) => existsSync(i.file)))
  ok('跑满 6 分钟才收工（假钟 360000ms）', world.state.now >= 6 * 60 * 1000, world.state.now)
  console.log('  · 诊断：' + JSON.stringify(diag()) + ' received=' + result.received + ' idleMs=' + result.idleMs)
}

console.log('\n2) 收图收到时限结束（长批次）：仍按"等满时限"收工，不提前掐断')
{
  // 30 分钟上限 vs 20 秒空闲阈值：只要收到图就重置计时，就不可能触发空闲退出
  const { result, diag } = await scenario('long-batch', { minutes: 30, plan: () => 'new' })
  ok('长批次等到时限才收工（reason=deadline）', result.reason === 'deadline', result.reason)
  ok('跑了整整 30 分钟（假钟）', diag().now >= 30 * 60 * 1000, diag())
  ok('收下的张数 ≈ 每分钟 12 张 × 30 分钟', result.received >= 300, result.received)
  ok('空闲间隔只有一轮（说明计时一直在被重置）', result.idleMs <= ROUND_MS, result.idleMs)
}

console.log('\n3) 出完图真正空闲：超时才退出')
{
  // 第 1..3 轮各投一张，然后停手：落定后空转 4 轮（20 秒）才允许收工
  const { world, result } = await scenario('then-idle', {
    // 时限给足，让"空闲退出"成为先触发的那个条件（否则验不出提前退出）
    minutes: 12,
    plan: (round) => (round <= 3 ? 'new' : null),
  })
  ok('原因是空闲退出（reason=idle）', result.reason === 'idle', result.reason)
  ok('收到了全部 3 张', result.received === 3, result.received)
  ok('空闲计时从最后一次收图算起，达到 20 秒才收工', result.idleMs >= IDLE_MS, result.idleMs)
  ok('没跑满 12 分钟（确实提前退出）', world.state.now < 12 * 60 * 1000, world.state.now)
  ok('确实是空转了几轮才收工（不是收完立刻退）', world.state.round - result.received >= 4, { round: world.state.round, received: result.received })
}

console.log('\n4) 一张都没有：不因空闲退出，等满时限')
{
  const { result } = await scenario('nothing', { minutes: 2, plan: () => null })
  ok('没有图时不提前退出（等满时限）', result.reason === 'deadline', result.reason)
  ok('收到 0 张', result.received === 0, result.received)
}

console.log('\n5) 收图后空闲一段又来了新图：不退出（计时必须重置）')
{
  // 第 1 轮投一张 → 空 3 轮（15 秒，还没到 20 秒）→ 第 5 轮再投一张 → 再空到时限
  const { result } = await scenario('gap-then-more', {
    minutes: 6,
    plan: (round) => (round === 1 || round === 5 ? 'new' : null),
  })
  ok('第二次来图没有被"空闲"掐掉', result.received === 2, result.received)
  ok('最终还是能正常收工', result.reason === 'deadline' || result.reason === 'idle', result.reason)
}

await fsp.rm(TMP, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? '全部通过：' + checks + ' 项检查' : failures + ' / ' + checks + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
