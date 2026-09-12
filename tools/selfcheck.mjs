// 自检：不启动 DSH，离线验证 dsh-video-prompt 的两半。
//
//   node tools/selfcheck.mjs
//
// 验的东西：
//   1. client.js 语法可解析、__ModuleLoader__ 契约成立（返回 module.exports）
//   2. apply() 真的往 conversation.hero.modeActions / conversation.input.right 两个槽注册
//   3. buildDispatchRequest 生成的派发文案包含图片/视频分流、逐项清单、产物路径
//   4. index.js 可 import，导出 name/inject/apply，且 apply 在缺 webServer 时不炸
//   5. 宿主纯函数行为：语法层面用源码断言（未导出部分做静态检查）
//
// React 从 DSH 安装目录解析，与页面里跑的是同一份。

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PKG = path.resolve(HERE, '..')
// DSH 安装目录：优先 DSH_APP_DIR；否则从当前 node 可执行文件反推
// （<app>/node_modules/node/bin/node.exe ⇒ 上三级就是 <app>）。不写死任何人的安装路径。
const APP = process.env.DSH_APP_DIR || path.resolve(path.dirname(process.execPath), '..', '..', '..')
// 真实产物回归用的样本根：按本机环境变量给，没配就退到相对目录，对应回归自动跳过。
const SAMPLE_MEDIA = path.resolve(process.env.DVP_MEDIA_ROOT || 'media')
const SAMPLE_RUNS = path.resolve(process.env.DVP_RUNS_ROOT || 'runs')
const require2 = createRequire(path.join(APP, 'package.json'))

let failures = 0
let checks = 0

function ok(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log('  ✓ ' + label)
  } else {
    failures += 1
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

function section(title) {
  console.log('\n' + title)
}

// ── 1. 客户端 bundle ────────────────────────────────────────────────────────
section('1) client.js · module loader 契约')

const source = readFileSync(path.join(PKG, 'client.js'), 'utf8')
const React = require2('react')

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) {
        loaded = record
      },
    },
  },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(v) { this._t = v }, get textContent() { return this._t } }),
    head: { appendChild() {} },
  },
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

ok('window.__ModuleLoader__.load 被调用', loaded !== null)
ok('id 为 dsh-video-prompt', loaded && loaded.id === 'dsh-video-prompt')

const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: React.Fragment }
  throw new Error('未预料的模块请求: ' + name)
}

const exportsObj = loaded.factory(requireStub)
ok('factory 返回 module.exports 对象', exportsObj && typeof exportsObj === 'object')
ok('导出 apply 函数', typeof exportsObj.apply === 'function')
ok('导出 inject 数组且含 slots', Array.isArray(exportsObj.inject) && exportsObj.inject.includes('slots'))

// ── 2. 槽注册 ──────────────────────────────────────────────────────────────
section('2) apply() 的槽注册')

const registrations = []
const registrars = []
const fakeCtx = {
  get: (key) => (key === 'slots' ? fakeSlots : undefined),
  effect: (fn) => {
    const dispose = typeof fn === 'function' ? fn() : undefined
    return dispose
  },
}
const fakeSlots = {
  inject(name, fn) {
    registrations.push(name)
    if (typeof fn === 'function') fn()
    return () => {}
  },
  register(entry, component) {
    registrars.push({ entry, component })
    return () => {}
  },
}

exportsObj.apply(fakeCtx)
ok('注册了 conversation.hero.modeActions', registrations.includes('conversation.hero.modeActions'))
ok('注册了 conversation.input.right', registrations.includes('conversation.input.right'))
ok('注册了 settings.section（验收入口）', registrations.includes('settings.section'))
ok('三次 register 都带 id=video-prompt', registrars.length === 3 && registrars.every((r) => r.entry.id === 'video-prompt'),
  JSON.stringify(registrars.map((r) => r.entry)))
ok('组件均为函数组件', registrars.every((r) => typeof r.component === 'function'))

// ── 3. 派发文案 ────────────────────────────────────────────────────────────
section('3) 派发请求文案')

const items = [
  { name: 'a.png', path: 'D:/media/images/a.png', kind: 'image', bytes: 204800 },
  { name: 'b.jpg', path: 'D:/media/images/b.jpg', kind: 'image', bytes: 1048576 },
  { name: 'c.mp4', path: 'D:/media/videos/c.mp4', kind: 'video', bytes: 6291456 },
]
const text = exportsObj.internals.buildDispatchRequest(items, 'D:/media', 'D:/runs')

ok('引用了 video-prompt-pipeline 技能', text.includes('video-prompt-pipeline'))
ok('写明素材目录', text.includes('D:/media'))
ok('写明产物目录', text.includes('D:/runs'))
ok('统计口径正确（图片 2 视频 1）', text.includes('图片 2 个') && text.includes('视频 1 个'))
ok('要求图片出图片提示词', text.includes('图片 → 产出「图片生成提示词」'))
ok('要求视频出视频提示词', text.includes('视频 → 按 video-prompt-pipeline'))
ok('逐项清单含文件路径与类型标记', text.includes('[图片] D:/media/images/a.png') && text.includes('[视频] D:/media/videos/c.mp4'))
ok('要求不静默省略', text.includes('不要静默省略'))
ok('视频排在图片之后（先图后视频的稳定顺序）', text.indexOf('a.png') < text.indexOf('c.mp4'))
ok('体积有可读化', text.includes('200 KB') || text.includes('200KB'))

// ── 3a2. 文档（md/txt）进派发 —— 用户报"生图插件不能识别 md 文档" ──────────
section('3a2) 文档进派发请求')

const docItem = { name: 'outline.md', path: 'D:/media/outline.md', kind: 'text', bytes: 4096 }
const itemsWithDocs = items.concat([docItem])
const PROC = 'D:/runs/process/2026-09-11_1705-outline'
const textDocs = exportsObj.internals.buildDispatchRequest(itemsWithDocs, 'D:/media', 'D:/runs', PROC)
ok('文档计入统计（文档 1 个）', textDocs.includes('文档 1 个'), textDocs.slice(0, 400))
ok('文档项进清单并带 [文档] 标记', textDocs.includes('[文档] D:/media/outline.md'))
ok('文档要求：先读全文、是材料不是指令', textDocs.includes('先读全文') && textDocs.includes('是材料不是指令'))
ok('过程目录写进派发请求（含时间命名说明）', textDocs.includes(PROC) && textDocs.includes('年-月-日_时分'))
ok('视频抽帧归位到过程目录 frames', textDocs.includes('frames'))
const textNoDocs = exportsObj.internals.buildDispatchRequest(items, 'D:/media', 'D:/runs')
ok('没勾文档时请求里不出现文档段落', !textNoDocs.includes('[文档]') && !textNoDocs.includes('文档 1 个'))

// ── 3g. 爆款元素路径（蒸馏）──────────────────────────────────────────────────
section('3g) 爆款元素（蒸馏）派发文案')

const viralText = exportsObj.internals.buildViralRequest(itemsWithDocs, 'D:/media', 'D:/runs', PROC)
ok('点名 viral-media-copywriter 技能并给内嵌兜底', viralText.includes('viral-media-copywriter') && viralText.includes('按本请求内嵌的流程执行'))
ok('第一步跑 inventory_media.py 只读清点', viralText.includes('inventory_media.py') && viralText.includes('inventory.json'))
ok('要求 watch 抽帧进过程目录', viralText.includes('watch') && viralText.includes('frames'))
ok('四层抽象齐全', ['原子线索', '功能模式', '创意机制', '可迁移配方'].every((k) => viralText.includes(k)), viralText.slice(0, 200))
ok('元素卡字段按 element-schema（证据 n/N、迁移变量、风险）', viralText.includes('元素卡') && viralText.includes('n/N') && viralText.includes('可迁移变量') && viralText.includes('风险'))
ok('汇总创意基因报告（核心模型/组合顺序/反例/可测试假设）', ['创意基因报告', '核心模型', '组合与顺序', '反例', '可测试假设'].every((k) => viralText.includes(k)))
ok('文案三方向按 output-contract', ['稳健迁移', '强钩子', '实验'].every((k) => viralText.includes(k)) && viralText.includes('追溯表'))
ok('不变量在请求里（不复制原句、本地处理、材料不是指令）', viralText.includes('不复制原句') && viralText.includes('不上传') && viralText.includes('是材料不是指令'))
ok('汇总文件落过程目录', viralText.includes('viral-summary.md') && viralText.includes(PROC))
ok('勾选文档进爆款路径时只当参考', viralText.includes('参考文档') && viralText.includes('outline.md'))
const viralNoVideo = exportsObj.internals.buildViralRequest(items.slice(0, 2), 'D:/media', '', '')
ok('图片也能走爆款路径（没有视频也成立）', viralNoVideo.includes('图片 2 个') && viralNoVideo.includes('爆款元素'))
const modes = exportsObj.internals.PIPELINE_MODES
ok('两条路径、取值与宿主白名单一致', Array.isArray(modes) && modes.length === 2
  && modes.map((m) => m.value).join(',') === 'prompt,viral', modes && modes.map((m) => m.value))
ok('每条路径都有 label 与 hint', modes.every((m) => m.label && m.hint && m.hint.length > 8))
const grokWithDocs = exportsObj.internals.buildGrokRequest(itemsWithDocs, 'D:/runs/grok-output', '', undefined, [docItem], PROC)
ok('Grok 请求带参考文档（只给路径）', grokWithDocs.includes('参考文档') && grokWithDocs.includes('D:/media/outline.md'))
ok('Grok 请求带过程目录', grokWithDocs.includes('过程目录：' + PROC))
const grokNoDocs = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output')
ok('不勾文档/无过程目录时这些行不出现', !grokNoDocs.includes('参考文档') && !grokNoDocs.includes('过程目录'))

// ── 3b. Grok 出图派发文案 ──────────────────────────────────────────────────
section('3b) Grok 出图派发文案')

const grokText = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output')
ok('只要图片（视频不进批次）', grokText.includes('待出图：2 张') && !grokText.includes('c.mp4'))
ok('写明批次目录', grokText.includes('D:/runs/grok-output'))
ok('写明落盘路由 /dvp/grok/save', grokText.includes('/dvp/grok/save'))
ok('要求用 Edge 登录态', grokText.includes('use:"edge"') && grokText.includes('grok.com'))
ok('明确要求登录/人机验证时停下来叫人', grokText.includes('人机验证') && grokText.includes('不要尝试绕过'))
ok('要求逐条超时与失败继续', grokText.includes('120 秒'))
ok('要求最后对账', grokText.includes('对账') && grokText.includes('图片实际路径'))
ok('清单里含图片路径', grokText.includes('a.png') && grokText.includes('b.jpg'))

// ── 3c. 生图要求（可选项）──────────────────────────────────────────────────
section('3c) 生图要求（可选项）')

const opts = { clarity: '8K电影级+胶片颗粒', aspect: '9:16 全竖', count: '2' }
const grokOptText = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output', '', opts)
ok('生图要求出现在请求里', grokOptText.includes('生图要求') && grokOptText.includes('清晰度：8K电影级+胶片颗粒'), grokOptText)
ok('画幅写进请求', grokOptText.includes('画幅：9:16 全竖'))
ok('张数写进请求', grokOptText.includes('每个提示词张数：2 张'))
ok('画幅要求写明切页面比例按钮', grokOptText.includes('比例按钮'))
ok('说明风格不在这里另加', grokOptText.includes('不在这里另加风格'))
// 省额度：清晰度档位决定"提示词里准不准写画质词"
ok('高档才允许写满画质修饰词', grokOptText.includes('Portra 400 颗粒'))
const lowText = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output', '', { clarity: '720p' })
ok('720p 档明确禁止写超清/8K 修饰词', lowText.includes('不写任何画质、模型、分辨率') && lowText.includes('超清/8K'), lowText)
const midText = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output', '', { clarity: '2K' })
ok('2K 档允许质感描述但禁止分辨率数字', midText.includes('不加分辨率数字'), midText)
ok('请求里写明越高越耗额度', midText.includes('更耗额度'))
const grokDefaults = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output')
ok('不传选项时默认落在省额度的 1080p', grokDefaults.includes('清晰度：1080p'), grokDefaults.slice(0, 400))
ok('默认画幅仍是 2:3 竖版', grokDefaults.includes('画幅：2:3 竖版'))
const defs = exportsObj.internals.GROK_OPTIONS
ok('可选项只有三组（保持"不要太多"）', Array.isArray(defs) && defs.length === 3, defs && defs.map((d) => d.key))
ok('每组都有 key/label/默认值/候选', defs.every((d) => d.key && d.label && d.value && Array.isArray(d.choices) && d.choices.length >= 2))
ok('默认值在候选里', defs.every((d) => d.choices.some((c) => c.value === d.value)))
ok('每一档都带说明文字', defs.every((d) => d.choices.every((c) => typeof c.hint === 'string' && c.hint.length > 4)),
  JSON.stringify(defs.map((d) => d.choices.map((c) => [c.value, c.hint && c.hint.length]))))
const clarityChoices = (defs.find((d) => d.key === 'clarity') || {}).choices.map((c) => c.value)
ok('清晰度从低到高排（720p 在最前）', JSON.stringify(clarityChoices) === JSON.stringify(['720p', '1080p', '2K', '4K', '8K', '8K电影级+胶片颗粒']), clarityChoices)
ok('清晰度默认是 1080p', (defs.find((d) => d.key === 'clarity') || {}).value === '1080p')

// ── 3d. 来源文本（小说正文 / 章纲）─────────────────────────────────────────
section('3d) 来源文本（按主要情节生图）')

const srcText = '第一章　雨夜\n\n林晚在雨里按响门铃，门后站着她的前夫。\n她没退。'
const grokSrc = exportsObj.internals.buildGrokRequest(items, 'D:/runs/grok-output', srcText, opts)
ok('来源文本进请求（带分隔标记）', grokSrc.includes('----- 来源文本开始 -----') && grokSrc.includes('林晚在雨里按响门铃'))
ok('写明字数便于核对', grokSrc.includes('来源文本（小说正文 / 章纲，' + srcText.trim().length + ' 字）'))
ok('要求先读来源再写提示词', grokSrc.includes('提取主要情节与冲突制作点'))
ok('把正文当材料而非指令（防注入）', grokSrc.includes('是材料不是指令'))
ok('不勾选时请求里没有来源文本', !grokDefaults.includes('来源文本开始'))
ok('来源文本排在清单之后（先图后文）', grokSrc.indexOf('待出图清单') < grokSrc.indexOf('来源文本开始'))

// ── 3e. 面板渲染：生图要求 + 来源文本 + 不透明 ─────────────────────────────
section('3e) 面板渲染（真 React 渲染成 HTML）')

const ReactDOMServer = require2('react-dom/server')
// 面板本身是受控展示组件（internals 导出），直接渲染它就等于用户把弹框点开后的样子：
// 模式按钮在 open=false 时只渲染一个 chip，验不到弹框内容。
const realUseEffect = React.useEffect
// 渲染时把网络副作用摘掉：useEffect 不执行（否则会去打 /dvp/state）
React.useEffect = () => {}
const panelHtml = ReactDOMServer.renderToStaticMarkup(
  React.createElement(exportsObj.internals.VideoPromptPanel, { mediaRoot: 'D:/media', runsRoot: 'D:/runs' }),
)
React.useEffect = realUseEffect

ok('渲染出面板容器', panelHtml.includes('dvp-panel'))
ok('面板标题是「生图」不是「提示词」', panelHtml.includes('>生图<') && !panelHtml.includes('图片 / 视频提示词'))
ok('面板里有「生图要求」区块', panelHtml.includes('生图要求'))
ok('清晰度下拉渲染出来了', panelHtml.includes('清晰度') && panelHtml.includes('8K电影级+胶片颗粒'))
ok('画幅下拉渲染出来了', panelHtml.includes('画幅') && panelHtml.includes('9:16 全竖'))
ok('张数下拉渲染出来了', panelHtml.includes('每个提示词张数'))
ok('清晰度档位按低到高渲染', panelHtml.indexOf('720p') < panelHtml.indexOf('1080p') && panelHtml.indexOf('1080p') < panelHtml.indexOf('2K'))
// 三个生图要求 + 一个层数 + 一个路径 = 5 个 select
ok('下拉都是 select 元素（原生控件，主题无关）', (panelHtml.match(/<select/g) || []).length === 5, panelHtml.match(/<select/g))
ok('每个选项都渲染成 option', (panelHtml.match(/<option/g) || []).length >= 17, (panelHtml.match(/<option/g) || []).length)
ok('有扫描层数下拉（默认 4 层）', panelHtml.includes('层数') && panelHtml.includes('只看这一层') && panelHtml.includes('8 层'))
// 路径二选一（默认落在主线 prompt 上）
ok('有「路径」下拉且默认是主线', panelHtml.includes('路径') && panelHtml.includes('素材 → 提示词 → 生图') && panelHtml.includes('爆款元素'))
ok('默认态主按钮是「派发到会话」', panelHtml.includes('派发到会话') && !panelHtml.includes('生成爆款元素'))
// 素材分流三列：视频 / 图片 / 文档（用户报"识别不了 md"）
ok('素材列表是视频/图片/文档三列', panelHtml.includes('dvp-cols') && (panelHtml.match(/dvp-col"/g) || []).length === 3, (panelHtml.match(/dvp-col"/g) || []).length)
ok('文档列有独立的空态说明', panelHtml.includes('md / txt / srt'))
ok('CSS 网格是 3 列', source.includes('.dvp-cols{display:grid;grid-template-columns:1fr 1fr 1fr'), '')
ok('面板里有「来源文本」区块', panelHtml.includes('来源文本'))
// 正文框默认收起（展开要占 64px+，窄屏会把底部按钮挤出面板），所以断言收起态的样子
ok('来源文本默认收起（给展开按钮，不给正文框）', panelHtml.includes('展开正文') && !panelHtml.includes('<textarea'))
ok('收起态说明正文放没放', panelHtml.includes('还没放正文'))
ok('有「按来源文本生图」开关', panelHtml.includes('按来源文本生图') && panelHtml.includes('type="checkbox"'))
ok('有落盘为文件按钮', panelHtml.includes('落盘为文件'))
ok('有清空按钮', panelHtml.includes('清空'))
// 文本文件可加入
ok('有「加文本文件」按钮', panelHtml.includes('加文本文件'))
ok('有「按路径加」按钮与路径输入框', panelHtml.includes('按路径加') && panelHtml.includes('dvp-pathInput'))
ok('路径输入框给的是多路径提示', panelHtml.includes('多个用 ; 或换行分隔'))
// 2026-09-11 修：File System Access API 在 DSH 桌面端（Electron）选得到、读不出
// （handle.getFile() 被平台拒绝）——本地挑文件一律走原生 <input type="file">
ok('不再调用 File System Access API', !source.includes('window.showOpenFilePicker(') && !source.includes('window.showDirectoryPicker(') && !source.includes('handle.values()') && !source.includes('entry.getFile()'))
ok('本地挑文件走原生 input 助手', source.includes('function pickFiles(options)') && source.includes("input.type = 'file'"))
ok('本地挑文件夹带 webkitdirectory（含子目录）', source.includes("setAttribute('webkitdirectory', '')"))
ok('读文本有 FileReader 兜底', source.includes('function readTextFile(file)') && source.includes('readAsText'))
ok('注释里留了 Electron 拒绝的原始报错，避免回退', source.includes('The request is not allowed by the user agent'))
ok('取消选择不会把 Promise 挂死（cancel 事件）', source.includes("addEventListener('cancel'"))
// 背后的 skill 逻辑大纲
ok('有「背后的逻辑」区块', panelHtml.includes('背后的逻辑'))
ok('大纲默认收起（只给「看大纲」按钮）', panelHtml.includes('看大纲'))
// 大纲正文默认收起，渲染结果里看不到正文 —— 所以三条输入从源码断言
ok('大纲覆盖图片/视频/文章三条输入', source.includes('拿到图片') && source.includes('拿到视频') && source.includes('拿到文章/正文'))
ok('大纲写了七段式与情节抽取规则', source.includes('七段式') && source.includes('主要情节') && source.includes('冲突'))
ok('大纲新增爆款路径与过程目录两节', source.includes('爆款元素卡') && source.includes('viral-summary.md') && source.includes('过程目录'))

// 弹框透明度：面板背景必须是实色，且带一层实色 background-image 兜底
const cssBlock = /var CSS = \[([\s\S]*?)\]\.join\('\\n'\)/.exec(source)
const CSS_FROM_SOURCE = cssBlock ? cssBlock[1] : ''
ok('从源码取到样式表', CSS_FROM_SOURCE.length > 500, CSS_FROM_SOURCE.length)
const panelCss = CSS_FROM_SOURCE
const panelRule = /\.dvp-panel\{([^}]*)\}/.exec(panelCss)
ok('找得到 .dvp-panel 规则', panelRule !== null)
const panelDecl = panelRule ? panelRule[1] : ''
ok('面板背景是实色（不带透明回退）', /background:var\(--dsw-alias-bg-module-platform,#[0-9a-fA-F]{3,6}\)/.test(panelDecl), panelDecl)
ok('没有再回退到可能透明的 --dsw-alias-bg-base', !panelDecl.includes('--dsw-alias-bg-base'), panelDecl)
ok('额外压一层实色 background-image', /background-image:linear-gradient\(var\(--dsw-alias-bg-module-platform,#[0-9a-fA-F]{3,6}\),var\(--dsw-alias-bg-module-platform,#[0-9a-fA-F]{3,6}\)\)/.test(panelDecl), panelDecl)
ok('面板有 isolation:isolate（避免被父级混合模式穿透）', panelDecl.includes('isolation:isolate'))
const selectRule = /\.dvp-select\{([^}]*)\}/.exec(panelCss)
ok('下拉自带实色背景', selectRule !== null && /background:var\(--dsw-alias-bg-module-platform/.test(selectRule[1]), selectRule && selectRule[1])
ok('有向上翻的样式规则', /\.dvp-panel\[data-drop=up\]\{[^}]*bottom:calc\(100% \+ 8px\)/.test(panelCss), panelCss.slice(0, 200))
ok('底部按钮行不换行（避免把按钮挤到面板外）', /\.dvp-btns\{[^}]*flex-wrap:nowrap/.test(panelCss), panelCss.slice(0, 200))
ok('面板里的直接子节点不伸缩（高度由 JS 分配）', /\.dvp-panel>\*\{flex:0 0 auto/.test(panelCss))
// 素材列表：高度由 layoutPanel 写进 --dvp-list-h（用户报"四个文件时滑块看不见/滚不动"）——
// 列头 + 列表恒等于中段实测高，列表底缘不再被 .dvp-col 裁掉。
ok('列表高度由 --dvp-list-h 驱动（回退 min(30vh,280px)）', /\.dvp-list\{[^}]*height:var\(--dvp-list-h,min\(30vh,280px\)\)/.test(panelCss), panelCss.slice(0, 200))
ok('列表最小高度 64（压缩态也看得见一条）', /\.dvp-list\{[^}]*min-height:64px/.test(panelCss))
ok('layoutPanel 会写 --dvp-list-h', source.includes("setProperty('--dvp-list-h'"))
ok('列表自然高度按条目数估算（不再读固定 DOM 高度）', source.includes('maxItems * (rowH + 2) + 12'))
ok('素材列表纵向可滚、横向不滚', /\.dvp-list\{[^}]*overflow-y:auto/.test(panelCss) && /\.dvp-list\{[^}]*overflow-x:hidden/.test(panelCss))
ok('素材列表滑块加粗可见（webkit 滚动条样式）', /\.dvp-list::-webkit-scrollbar\{width:9px\}/.test(panelCss))
ok('大纲正文区自己可滚', /\.dvp-howtoBody\{[^}]*overflow:auto/.test(panelCss))
ok('中段下限抬到 220（列表 min-height 132 才装得下）', /PANEL_BODY_MIN = 220/.test(source))

// 真实缺陷回归：面板贴在输入区底部时，往下展开会整块落到视口外（实测 y 744→1329 / 视口 805），
// 用户点开什么都看不见。flipPanelIntoView 必须把它翻到上方。
function fakeWrap(rect, width, height) {
  // 同一个对象必须反复返回同一份：flipPanelIntoView 是往 panel.dataset 上写标记的，
  // 每次 querySelector 都新建一个对象，断言就永远读不到刚写进去的值（先踩过一次）。
  const panel = {
    getBoundingClientRect: () => rect,
    offsetWidth: width,
    offsetHeight: height,
    dataset: {},
    style: { setProperty: (k, v) => { panel.dataset[k] = v } },
  }
  return { querySelector: () => panel, getBoundingClientRect: () => rect, panel }
}
const flip = exportsObj.internals.flipPanelIntoView
// 量上下空间要靠视口尺寸，而沙箱里本来没有真的 window：整个 3e 段都用这个替身，
// 否则会拿 undefined 去比大小，判定结果全错（先踩过一次）。
const realWindow = sandbox.window
sandbox.window = { innerWidth: 1424, innerHeight: 805, addEventListener: () => {}, removeEventListener: () => {} }
// 输入条贴近视口底部（chip 在 744），面板高 585 —— 下面只剩 53px，必须上翻
const lowRect = { top: 744, bottom: 772, right: 929, height: 28, left: 848, width: 81 }
const wrapLow = fakeWrap(lowRect, 720, 585)
flip(wrapLow)
const panelLow = wrapLow.panel
ok('输入条贴近底部时向上展开', panelLow.dataset.drop === 'up', JSON.stringify(panelLow.dataset))
// 输入条在页面上方（top 120 / bottom 148），面板高 585，下面装得下 —— 保持下翻
const highRect = { top: 120, bottom: 148, right: 900, height: 28, left: 180, width: 81 }
const wrapHigh = fakeWrap(highRect, 720, 585)
flip(wrapHigh)
ok('上方空间够时保持向下展开', wrapHigh.panel.dataset.drop === 'down', JSON.stringify(wrapHigh.panel.dataset))
// 面板宽 720、左边缘 702 → 右边缘 1422 > 1424-12，必须翻到左边
const wideRect = { top: 120, bottom: 148, right: 783, height: 28, left: 702, width: 81 }
const wrapWide = fakeWrap(wideRect, 720, 585)
flip(wrapWide)
ok('右侧越界时翻到左边', wrapWide.panel.dataset.flip === 'true', JSON.stringify(wrapWide.panel.dataset))
// 面板宽 720、左边缘 180 → 右边缘 900，没越界，保持左边对齐
const narrowRect = { top: 120, bottom: 148, right: 261, height: 28, left: 180, width: 81 }
const wrapNarrow = fakeWrap(narrowRect, 720, 585)
flip(wrapNarrow)
ok('不越界时不翻左边', wrapNarrow.panel.dataset.flip === 'false', JSON.stringify(wrapNarrow.panel.dataset))
// 高度顶死在可用方向上：down 用下方空间（805-148-8=649），up 用上方空间（744-8=736）
ok('向下展开时按下方空间限高', wrapHigh.panel.dataset['--dvp-room'] === '649px', wrapHigh.panel.dataset['--dvp-room'])
ok('向上展开时按上方空间限高', wrapLow.panel.dataset['--dvp-room'] === '736px', wrapLow.panel.dataset['--dvp-room'])
// 输入条贴视口底部时"剩余空间"会算得比视口高（792 > 805-48），必须被基础 max-height 夹住
const bottomWrap = fakeWrap({ top: 800, bottom: 805, right: 100, height: 5, left: 0, width: 81 }, 720, 585)
flip(bottomWrap)
ok('剩余空间超过视口时被夹到 100dvh-48px', bottomWrap.panel.dataset['--dvp-room'] === '757px', bottomWrap.panel.dataset['--dvp-room'])
ok('向上限高不超过基础上限（736 ≤ 757）', Number(String(wrapLow.panel.dataset['--dvp-room']).replace('px', '')) <= 757, wrapLow.panel.dataset['--dvp-room'])
// 上下都极窄（窗口只有 330 高）：限高走 240 下限，且面板整体转为可滚（按钮能滚出来）
sandbox.window = { innerWidth: 1424, innerHeight: 330, addEventListener: () => {}, removeEventListener: () => {} }
const tightWrap = fakeWrap({ top: 183, bottom: 205, right: 100, height: 5, left: 0, width: 81 }, 720, 585)
flip(tightWrap)
ok('两个方向都不足 240px 时限高走下限', tightWrap.panel.dataset['--dvp-room'] === '240px', tightWrap.panel.dataset['--dvp-room'])
sandbox.window = { innerWidth: 1424, innerHeight: 805, addEventListener: () => {}, removeEventListener: () => {} }

// ── 3e2. layoutPanel：按实测高度给中段分配高度 ─────────────────────────────
section('3e2) layoutPanel（面板高度分配）')

// 造一个像真的面板：8 个直接子节点（固定部分合计 317），中段自然高度 251
// 现实值参考：fixed 430、gap 70、padding 28 —— 这里用 317 是为了把"available < 下限"这条分支量清楚
function fakePanel(opts) {
  const o = opts || {}
  const body = {
    className: 'dvp-body',
    offsetHeight: 0,
    scrollHeight: o.natural === undefined ? 251 : o.natural,
    style: {},
    querySelector: () => null,
  }
  const fixed = [
    { className: 'dvp-head', offsetHeight: 20 },
    { className: 'dvp-row', offsetHeight: 30 },
    { className: 'dvp-row', offsetHeight: 30 },
    { className: 'dvp-sect', offsetHeight: 105 },
    { className: 'dvp-sect', offsetHeight: 71 },
    { className: 'dvp-ok', offsetHeight: 15 },
    body,
    { className: 'dvp-foot', offsetHeight: 46 },
  ]
  return {
    children: fixed,
    body,
    dataset: {},
    style: {},
    querySelector: (sel) => (sel === '.dvp-body' ? body : null),
  }
}
const layout = exportsObj.internals.layoutPanel
// limit 572 → available = 572-(20+30+30+105+71+15+46)-70-28 = 157
// 下限 = min(220, max(48,157)) = 157 → 中段取 157（下限不会大过可用空间，否则面板会被顶出视口）
const p1 = fakePanel()
layout(p1, 572)
ok('空间不足时中段保持自然高度、面板整体滚（不再裁列表底缘）', p1.body.style.height === '251px', p1.body.style.height)
ok('放不下时面板整体可滚（按钮滚得出来）', p1.style.overflowY === 'auto' && p1.dataset.tight === 'true', JSON.stringify(p1.style) + JSON.stringify(p1.dataset))
// limit 900 → available = 900-317-70-28 = 485 > 自然 251 → 取 251（不拉长，不出现空档）
const p2 = fakePanel()
layout(p2, 900)
ok('空间充足时中段保持自然高度', p2.body.style.height === '251px', p2.body.style.height)
ok('放得下时面板不加滚动条', p2.style.overflowY === 'hidden' && p2.dataset.tight === 'false', JSON.stringify(p2.style))
// limit 300 → available 负数 → 中段仍是自然高度 251，靠面板整体滚动看全（压成 48 只会把内容裁没）
const p3 = fakePanel()
layout(p3, 300)
ok('极窄时中段不再被压扁（natural 251 + 面板滚）', p3.body.style.height === '251px', p3.body.style.height)
ok('极窄时面板可滚', p3.style.overflowY === 'auto' && p3.dataset.tight === 'true', JSON.stringify(p3.style))
// 没有 --dvp-room 时退到视口高度 - 48 → limit 757，available = 757-317-70-28 = 342 > 251 → 251
sandbox.window = { innerWidth: 1424, innerHeight: 805, addEventListener: () => {}, removeEventListener: () => {} }
const p4 = fakePanel()
layout(p4, 0)
ok('没有 room 时退到 100dvh-48px 计算', p4.body.style.height === '251px', p4.body.style.height)
sandbox.window = realWindow
ok('缺中段时安全返回', layout({ querySelector: () => null }, 572) === undefined)
ok('layoutPanel 由 flip 内部调用（不需要额外 effect）', /layoutPanel\(panel, room\)/.test(source), '')
// 回归（用户报"四个文件滚不动"的根因之一）：面板自己的 wrapRef 必须挂在面板根节点上，
// 否则 flip 的每轮 effect 与 ResizeObserver 全是空跑（"effect 计数在涨、函数却没执行到"）。
ok('面板根节点挂了 wrapRef', source.includes("h('div', { className: 'dvp-panel', ref: wrapRef }"))
ok('flip/RO 兼容"传面板本身"与"传外层 wrap"两种锚点', source.includes('function findPanelNode') && source.includes('findPanelNode(wrap)') && source.includes('findPanelNode(node)'))
sandbox.window = realWindow


// ── 3f. 预览页镜像 ─────────────────────────────────────────────────────────
section('3f) servable/client.js 与包根 client.js 一致')

const servablePath = path.join(PKG, 'servable', 'client.js')
const servableBytes = existsSync(servablePath) ? readFileSync(servablePath) : null
ok('servable/client.js 存在', servableBytes !== null)
ok('两份字节完全一致（预览页演的必须是同一份代码）',
  servableBytes !== null && createHash('sha256').update(servableBytes).digest('hex') === createHash('sha256').update(source).digest('hex'),
  '跑 node tools/sync-servable.mjs 同步')

// ── 4. 输入框定位 ──────────────────────────────────────────────────────────
section('4) 输入框定位（无 DOM 时应安全返回 null）')
ok('findComposerEditor 在无匹配时返回 null', exportsObj.internals.findComposerEditor() === null)
ok('dispatchToComposer 未找到输入框时给出理由', exportsObj.internals.dispatchToComposer('x').ok === false)

// ── 5. 宿主半边 ────────────────────────────────────────────────────────────
section('5) index.js · 宿主半边')

const host = await import(pathToFileURL(path.join(PKG, 'index.js')).href)
ok('导出 name', host.name === 'dsh-video-prompt')
ok('inject 含 webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))
ok('导出 apply 函数', typeof host.apply === 'function')

const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
await host.apply({ get: () => undefined, effect: () => () => {} }, {})
console.warn = originalWarn
ok('webServer 缺失时只告警不抛错', warnings.some((w) => w.includes('webServer 不可用')))

// ── 6. 技能包完整性 ────────────────────────────────────────────────────────
section('6) 技能包')

const expectSkills = ['video-prompt-pipeline', 'watch', 'oneshot-prompt-generator', 'prompt-videos', 'video-generation', 'viral-media-copywriter']
for (const skill of expectSkills) {
  const file = path.join(PKG, 'skills', skill, 'SKILL.md')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  ok(`${skill}: SKILL.md 存在且有 frontmatter`, match !== null)
  if (match) {
    ok(`${skill}: frontmatter 里 name 与目录一致`, new RegExp('name:\\s*' + skill + '\\b').test(match[1]))
    ok(`${skill}: frontmatter 里有 description`, /description:/.test(match[1]))
    // 块标量（`description: >`）本身是合法 YAML，坏的是解析器把它当成字面量 ">"。
    // 这里只断言"要么是单行正文，要么是块标量记号"；解析结果由 6b 段端到端验证。
    const raw = /description:[ \t]*(.*)$/m.exec(match[1])
    const inline = raw === null ? '' : raw[1].trim()
    ok(`${skill}: description 是单行正文或块标量记号`, inline !== '' && (/^[>|][+-]?\d*$/.test(inline) || inline.length >= 20), inline)
  }
}

// 端到端验一次宿主解析器：真的调 apply()，看它注册进技能的 description 是不是正文
section('6b) 宿主 frontmatter 解析（真的走 apply）')
{
  const captured = []
  const fakeSkills = { register(skill) { captured.push(skill); return () => {} }, list: async () => [] }
  const fakeWebServer = { register: () => () => {}, tapIndex: () => () => {} }
  const ctx = {
    get: (key) => (key === 'webServer' ? fakeWebServer : key === 'skills' ? fakeSkills : undefined),
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
  }
  await host.apply(ctx, { mediaRoot: PKG, runsRoot: PKG, registerSkills: true })
  const byName = new Map(captured.map((s) => [s.name, s]))
  ok('注册到 6 个技能', captured.length === 6, captured.map((s) => s.name))
  for (const name of expectSkills) {
    const skill = byName.get(name)
    ok(`${name}: 描述长度正常（≥20 字）`, skill !== undefined && skill.description.length >= 20, skill && skill.description)
    ok(`${name}: 描述不是块标量记号`, skill !== undefined && !/^[>|]$/.test(skill.description.trim()), skill && skill.description)
  }
  const pv = byName.get('prompt-videos')
  ok('折叠块被拼成一句话（prompt-videos）', pv !== undefined && pv.description.includes('Prompting techniques for AI video generation models'), pv && pv.description)
  ok('折叠块内部没有残留换行', pv !== undefined && !pv.description.includes('\n'), pv && JSON.stringify(pv.description))
  // 2026-09-11 合并回归：三个新包择优进底座
  const vpp = byName.get('video-prompt-pipeline')
  ok('视频复刻的中文触发词进了 frontmatter（fuke 版择优）', vpp !== undefined && vpp.description.includes('视频复刻'), vpp && vpp.description)
  ok('Phase 3 两张浏览器参考图已并入正文', vpp !== undefined && vpp.content.includes('Phase 3') && vpp.content.includes('chatgpt-reference-01'), vpp && vpp.content.length)
  ok('run layout 认面板的过程目录约定', vpp !== undefined && vpp.content.includes('过程目录'), vpp && vpp.content.length)
  const vmc = byName.get('viral-media-copywriter')
  ok('viral-media-copywriter 注册且 resourceBase 指真目录', vmc !== undefined && vmc.resourceBase && existsSync(vmc.resourceBase.path))
  ok('其 references/element-schema.md 与 output-contract.md 随包', ['references/element-schema.md', 'references/output-contract.md', 'references/domain-lenses.md', 'scripts/inventory_media.py']
    .every((rel) => existsSync(path.join(PKG, 'skills', 'viral-media-copywriter', ...rel.split('/')))))
  ok('四层抽象在其正文里', vmc !== undefined && vmc.content.includes('原子线索') && vmc.content.includes('可迁移配方'))
  // 上游包没有 watch 的 UTF-8 修复 —— 合并时不许丢（已修坑 3）
  const framesSrc = readFileSync(path.join(PKG, 'skills', 'watch', 'scripts', 'frames.py'), 'utf8')
  const whisperSrc = readFileSync(path.join(PKG, 'skills', 'watch', 'scripts', 'whisper.py'), 'utf8')
  ok('frames.py 保住 4 处 utf-8 修复', (framesSrc.match(/encoding="utf-8", errors="replace"/g) || []).length === 4, (framesSrc.match(/encoding="utf-8"/g) || []).length)
  ok('whisper.py 保住 2 处 utf-8 修复', (whisperSrc.match(/encoding="utf-8", errors="replace"/g) || []).length === 2)
}

// ── 6c. 技能包热重扫（/dvp/skills/reload）：开机后新增技能免重启 ───────────
section('6c) 技能包热重扫')
{
  const hostSrc = readFileSync(path.join(PKG, 'index.js'), 'utf8')
  ok('注册逻辑抽成 registerSkillPack（开机与 reload 共用）', hostSrc.includes('async function registerSkillPack') && hostSrc.includes('registered = await registerSkillPack()'))
  ok('reload 路由存在且只认 POST/PUT', hostSrc.includes("path: '/dvp/skills/reload'"))
  ok('reload 如实播报 first-wins 边界', hostSrc.includes('first-wins') && hostSrc.includes('重启桌面端'))
  ok('设置页有「重扫技能包」按钮', source.includes('重扫技能包') && source.includes('/dvp/skills/reload'))
}

// ── 7. Grok 批次工具 ───────────────────────────────────────────────────────
section('7) tools/grok-shot.mjs · 批次与落盘')

const shot = await import(pathToFileURL(path.join(PKG, 'tools', 'grok-shot.mjs')).href)
const samplePrompts = [
  '# 文档标题（不该进批次）',
  '',
  '**人物一致性锚点**：这一行是锚点不是提示词。',
  '',
  '## 1. 门廊按铃',
  '竖屏 9:16 电影感中近景。一位东亚女性侧身站在厚重深色木门旁，深色长发挽成低发髻、发间别一支银色花枝发饰，穿宽松灰色圆领卫衣，右手食指按在门框的黄铜门铃上。门缝内是暖金色室内：水晶吊灯、大理石地面反光。50mm，f/1.8 浅景深，暖光为主光，色温约 3000K，木纹与黄铜氧化痕迹清晰。',
  '',
  '## 2. 荧光药剂',
  '竖屏 9:16 电影感特写。同一人物双手举起透明小玻璃瓶到唇边，瓶中液体发出强烈青绿色荧光，光自下而上照亮嘴唇、鼻梁、下颌与虹膜。背景压暗到近黑，仅在下颌留一点暖色轮廓。100mm 微距，f/2，焦点在眼睛与瓶口玻璃边缘，皮肤保留湿润高光与毛孔质感，不磨皮。',
].join('\n')
const parsed = shot.splitPrompts(samplePrompts)
ok('解析出 2 条提示词（丢掉前言与锚点段）', parsed.length === 2, JSON.stringify(parsed.map((p) => p.slug)))
ok('标题去掉了序号', parsed[0] && parsed[0].title === '门廊按铃', parsed[0] && parsed[0].title)
ok('条目数少于文件里的标题数（伪块被剔除）', parsed.length < 4, parsed.length)
ok('slug 可做文件名', parsed.every((p) => /^[\p{L}\p{N}._-]+$/u.test(p.slug)), JSON.stringify(parsed.map((p) => p.slug)))
ok('每条带 hash 便于查重', parsed.every((p) => typeof p.hash === 'string' && p.hash.length === 12))
ok('扩展名按 content-type 推断', shot.extFromContentType('image/webp') === '.webp' && shot.extFromContentType('image/jpeg') === '.jpg' && shot.extFromContentType('') === '.png')

// 真实产物回归：demo-01 的图片提示词文档里有文档标题、风格锚点、正文外说明三种伪块，
// 正确的切分结果应当**恰好 4 条**（对应视频的四个镜头）。
const realDoc = path.join(SAMPLE_RUNS, 'demo-01', 'optimized-image-prompt.md')
const planFile = path.join(SAMPLE_MEDIA, 'grok-output', 'plan.json')
if (existsSync(realDoc)) {
  const realParsed = shot.splitPrompts(readFileSync(realDoc, 'utf8'))
  ok('真实文档切出恰好 4 条', realParsed.length === 4, realParsed.map((p) => p.slug))
  ok('真实文档里没有文档标题伪条目', realParsed.every((p) => !p.slug.includes('逐帧图片生成提示词')), realParsed.map((p) => p.slug))
  ok('真实文档里没有锚点伪条目', realParsed.every((p) => !/锚点/.test(p.title)), realParsed.map((p) => p.title))
  ok('真实文档条目长度合理（>500 字）', realParsed.every((p) => p.chars > 500), realParsed.map((p) => p.chars))
} else {
  console.log('  · 跳过真实文档回归（' + realDoc + ' 不存在）')
}

const recipe = shot.grokRecipe(parsed, 'D:/runs/grok-output')
ok('配方提到 browser_open 与 Edge', recipe.includes('browser_open') && recipe.includes('edge'))
ok('配方要求停止而不是绕过人机验证', recipe.includes('人机验证') && recipe.includes('不要尝试绕过'))
ok('配方里每条都有粘贴、等待、取图三步', recipe.includes('3.1 把第 1 条提示词') && recipe.includes('3.1b 等待出图') && recipe.includes('3.1c 取图') && recipe.includes('3.2 把第 2 条提示词'))
ok('配方禁止改账号设置', recipe.includes('不要修改用户的账号设置'))

const tmpOut = path.join(PKG, 'tools', '.tmp-grok-test')
const saved = await shot.saveImage(tmpOut, parsed[0], Buffer.from('89504e470d0a1a0a', 'hex'))
ok('saveImage 落盘成功', existsSync(saved.file) && saved.bytes === 8, saved.file)
await fsp.rm(tmpOut, { recursive: true, force: true })

// ── 7b. 批次回填 ───────────────────────────────────────────────────────────
section('7b) tools/backfill-plan.mjs · 提示词回填')

const backfill = await import(pathToFileURL(path.join(PKG, 'tools', 'backfill-plan.mjs')).href)
const fakePlan = {
  count: 2,
  grokUrl: 'https://grok.com/',
  entries: [
    { index: 1, title: '01 门廊按铃', slug: '01-men-lang', prompt: '（待填：01-doorbell.jpg 的图片生成提示词。）', source: '01-doorbell.jpg' },
    { index: 2, title: '02 垂眸心事', slug: '02-chui-mou', prompt: '（待填：02-downcast.jpg 的图片生成提示词。）', source: '02-downcast.jpg' },
  ],
}
const driverText = backfill.renderDriverDoc({ ...fakePlan, dir: 'D:/runs/grok-output' })
ok('驱动清单含批次条数', driverText.includes('批次条数：2'))
ok('驱动清单含每条提示词正文', driverText.includes('（待填：01-doorbell.jpg'))
ok('驱动清单要求等流式收尾再取图', driverText.includes('流式输出收尾') && driverText.includes('占位图'))
ok('驱动清单给出 Download 收件补救路径', driverText.includes('watch-downloads.mjs') && driverText.includes('Download'))
ok('驱动清单写明签名 URL 直连不可用', driverText.includes('403') && driverText.includes('CORS'))
ok('驱动清单要求核对 ledger', driverText.includes('ledger.json'))
ok('驱动清单为每条列出落盘文件名', driverText.includes('01-01-men-lang.<ext>') && driverText.includes('02-02-chui-mou.<ext>'))

// 回填真实配对：文档 4 条对批次 4 条
if (existsSync(realDoc) && existsSync(planFile)) {
  const livePlan = JSON.parse(readFileSync(planFile, 'utf8'))
  const liveParsed = shot.splitPrompts(readFileSync(realDoc, 'utf8'))
  ok('真实批次与文档条数一致', livePlan.entries.length === liveParsed.length, { plan: livePlan.entries.length, doc: liveParsed.length })
  ok('真实批次里没有占位符残留', livePlan.entries.every((e) => !String(e.prompt).startsWith('（待填')), livePlan.entries.map((e) => String(e.prompt).slice(0, 12)))
  ok('真实批次每条带指纹', livePlan.entries.every((e) => typeof e.hash === 'string' && e.hash.length === 12))
  ok('真实批次提示词长度合理（>500 字）', livePlan.entries.every((e) => String(e.prompt).length > 500), livePlan.entries.map((e) => String(e.prompt).length))
}

// ── 7c. 缓存捞图 ───────────────────────────────────────────────────────────
section('7c) tools/scan-cache.mjs · 图片签名辨认')

const cache = await import(pathToFileURL(path.join(PKG, 'tools', 'scan-cache.mjs')).href)
const jpegBytes = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
  Buffer.alloc(64, 0x20),
  Buffer.from([0xff, 0xd9]),
])
const pngHead = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0),
  Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
])
ok('认出完整 JPEG', JSON.stringify(cache.identifyImage(jpegBytes)) === JSON.stringify({ ext: '.jpg', head: true, tail: true }), cache.identifyImage(jpegBytes))
ok('认出完整 PNG', cache.identifyImage(pngHead) && cache.identifyImage(pngHead).ext === '.png')
const headOnly = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 0)])
ok('缺尾签名的残片被判为不完整', cache.identifyImage(headOnly) && cache.identifyImage(headOnly).tail === false, cache.identifyImage(headOnly))
ok('非图片字节返回 null', cache.identifyImage(Buffer.from('not an image at all')) === null)

// 真实产出回归：已落盘的那张成图必须是合法 JPEG，且体积与页面内读到的 259316 一致
const shotFile = path.join(SAMPLE_MEDIA, 'grok-output', '01-01-门廊按铃.jpg')
if (existsSync(shotFile)) {
  const shotBytes = readFileSync(shotFile)
  const kind = cache.identifyImage(shotBytes)
  ok('成图落盘且是完整 JPEG', kind !== null && kind.ext === '.jpg' && kind.tail === true, kind)
  ok('成图体积与页面内读到的一致（259316）', shotBytes.length === 259316, shotBytes.length)
} else {
  console.log('  · 跳过成图回归（' + shotFile + ' 不存在）')
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('\n' + (failures === 0 ? `全部通过：${checks} 项检查` : `${failures} / ${checks} 项失败`))
process.exit(failures === 0 ? 0 : 1)
