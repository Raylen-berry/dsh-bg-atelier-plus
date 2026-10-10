#!/usr/bin/env node
// tools/visual-baseline.mjs —— 底图插件「背景来源抽象」重构的视觉 oracle。
//
// 为什么需要它：重构会动到 client.js 的绘制核心（背景 URL 计算、样式重建、token 下发），
// 而本插件自带的 15 套测试主要覆盖设置页与几何，**不覆盖视觉**。没有 oracle 的重构 = 盲改。
//
// 判据：重构前后对同一组状态截图，逐像素比，要求 diffRatio = 0。不放容差。
//
// **为什么只比"稳定区"**（实测结论，不是猜的）：底部一条带天然不可复现 ——
// 那里有两个随时间变的东西：① 宿主状态栏的实时计数（"8 轮 399 步 · 70 tok/s"、
// "121M tok · 缓存命中 98%"、百分比进度）；② 底图插件自己的装饰粒子 bga-ptl，位置随机漂移。
// 对它们做像素回归本来就没意义（粒子位置随机），而真正的视觉契约（底图、主题色、
// 设置面板布局）全在稳定区里。裁剪比例写进 manifest，不藏在代码里。
// 另：dsh-browser-live 的观察窗会**实时镜像当前页面**（含 FPS 计数与递归的自己），
// 比截图前必须先关掉它 —— 不关的话零改动也能差 0.23%。
//
// 怎么截：**不自己起浏览器**，而是走 dsh-browser-live 已经认证过的那个会话
// （GUI 根路径由 dsh-client-connection 把守，带 launch token 的 URL 只在宿主内部拿得到）。
// 所以本脚本的用法是"被 agent 调用"：agent 先 browser_open{gui:true} 把页面准备好，
// 再用 browser_screenshot 截，然后用 pixdiff 比。本文件提供的是**状态定义**与**比对逻辑**，
// 以及一个把两边串起来的可执行入口（走 CDP 的 /json/list 拿当前标签）。
//
// 用法：
//   1) 让 agent 打开 GUI：browser_open {gui:true}
//   2) 建基准：  node tools/visual-baseline.mjs capture before-refactor
//   3) 重构后：  node tools/visual-baseline.mjs compare before-refactor
//
// 环境变量：
//   VB_CDP_PORT  连哪个 CDP 端口（默认 9799，读自 $DSH_HOME/dsh-browser-live/state.json 的 port）
//   VB_BROWSER   浏览器可执行文件（只在需要自己拉起时用）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resizePixels, comparePngEither } from '../../dsh-browser-live/pixdiff.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = path.resolve(HERE, '..', 'baselines')

const mode = process.argv[2]
const dir = process.argv[3]
if (!['capture', 'compare', 'list', 'selftest'].includes(mode) || (!dir && mode !== 'list' && mode !== 'selftest')) {
  console.error('用法: node tools/visual-baseline.mjs capture|compare <目录名>')
  console.error('      node tools/visual-baseline.mjs list          # 列出已建基准')
  console.error('      node tools/visual-baseline.mjs selftest      # 用**真实插件元素**验证检出能力（不需基准）')
  process.exit(2)
}
if (dir) fs.mkdirSync(path.join(OUT_ROOT, dir), { recursive: true })

// ---------------------------------------------------------------- 状态定义
// 覆盖绘制核心的不同分支（重构风险就在这些分支上）：
//   · 静态底图：body::before 的 background-image + 主题 token
//   · 淡入过渡中：绘制管线的时间相关分支
//   · 设置面板：底图插件自绘的 UI（不依赖宿主组件）
//   · dock 特效：bga-dockfx 系列节点
// 每个状态记录"要不要动状态"以及"截图前等多久"（等图片解码）。
export const STATES = [
  {
    name: '01-static-wallpaper',
    note: '静态底图：body::before 的 url(...) 与主题 token 已下发',
    settleMs: 4500,
    probe: `(()=>{const b=getComputedStyle(document.body,'::before');const h=getComputedStyle(document.documentElement);
      return JSON.stringify({bg:b.backgroundImage, size:b.backgroundSize, filter:b.filter, opacity:b.opacity,
        accent:h.getPropertyValue('--bga-accent'), imgFade:h.getPropertyValue('--cc-img-fade'),
        fxRise:h.getPropertyValue('--bga-fx-rise')})})()`,
  },
  {
    name: '02-fx-nodes',
    note: '特效节点是否在位（bga-orb / bga-dockfx / bga-ptl）',
    settleMs: 1500,
    probe: `(()=>{const n=[...document.querySelectorAll('[class*="bga"]')].map(e=>e.className);
      return JSON.stringify({count:n.length, nodes:n})})()`,
  },
  {
    name: '03-settings-studio',
    note: '底图工坊设置页（自绘 UI；重构最容易被带偏的地方）',
    settleMs: 6000,  // 设置页里的底图预览要解码一张几 MB 的图 + 套 framing；2500 实测不够，会拍到半成品
    // 这个状态**期望**面板头部有底图预览（.bga-hero-image）。审核方指出：不区分"首页"与
    // "设置页"的话，预览图"还没插进 DOM"（absent）会被当成"本来就没有"而提前放行。
    expectHero: true,
    // 打开路径：侧边栏"设置" → 左导航"底图工坊"。用 DOM 直点，不依赖 :has-text（本工具链不支持）。
    // 实测：走完之后 .bga-studio 存在且是 560×1341 —— 这才是真正覆盖到插件 UI 的状态。
    open: `(()=>{const b=[...document.querySelectorAll('button,[role="button"]')].find(x=>String(x.textContent||'').trim()==='设置');if(b)b.click();return 'clicked-settings'})()`,
    openSettleMs: 1200,
    open2: `(()=>{const d=document.querySelector('[role="dialog"]');if(!d)return 'no-dialog';
      const el=[...d.querySelectorAll('*')].find(e=>e.children.length===0&&String(e.textContent||'').trim()==='底图工坊');
      if(!el)return 'no-nav-item';(el.closest('button,[role="button"],li,a')||el).click();return 'clicked-studio'})()`,
    probe: `(()=>{const s=document.querySelector('.bga-studio');return JSON.stringify({hasStudio:!!s,
      studioSize:s?[s.offsetWidth,s.offsetHeight]:null,
      heading:s&&s.querySelector('h2')?s.querySelector('h2').textContent.trim():null,
      saveState:s&&s.querySelector('.bga-save-state')?s.querySelector('.bga-save-state').textContent.trim():null})})()`,
  },
]

// ---------------------------------------------------------------- CDP 客户端
/** DSH GUI 的地址（要对着它做视觉回归，不是随便哪个标签页）。 */
const GUI_HOST = process.env.VB_GUI_HOST || '127.0.0.1:19387'

async function cdpSession(port) {
  let list
  try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json() }
  catch { throw new Error('CDP 端口 ' + port + ' 没响应。先让 agent 跑 browser_open{use:"plugin"}；或用 VB_CDP_PORT 指到别的实例') }

  // ⚠️ **不能随便挑一个 page**。原来写的是 `list.find(t => t.type === 'page')` —— 拿的是
  // "第一个/当前激活的"标签页。而浏览器是共用的：实测它当时停在 chatgpt.com 与
  // deepseekdocs.com 上，于是脚本对着**别的网站**执行探针，预检报 ok:404、
  // 表现成"页面 fetch 通道不可用"，与真实原因（跑错页面）完全不符。
  // 现在**按 URL 找 DSH GUI**；找不到就明确报出来，不猜。
  const pages = list.filter((t) => t.type === 'page')
  const mine = pages.filter((t) => String(t.url || '').includes(GUI_HOST))
  if (mine.length === 0) {
    throw new Error('CDP 里没有 DSH GUI 的标签页（期望 URL 含 "' + GUI_HOST + '"，实际有：'
      + pages.map((t) => String(t.url || '').slice(0, 60)).join(' | ')
      + '）。先跑 browser_open{gui:true} 把 GUI 打开。可用 VB_GUI_HOST 改期望地址。')
  }
  const page = mine[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('CDP 连接失败: ' + (e.message || e))) })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)))
      else resolve(m.result)
    }
  }
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const myId = ++id
    const t = setTimeout(() => { pending.delete(myId); reject(new Error('CDP 超时: ' + method)) }, timeoutMs)
    pending.set(myId, { resolve: (r) => { clearTimeout(t); resolve(r) }, reject: (e) => { clearTimeout(t); reject(e) } })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  return { send, close: () => ws.close(), url: page.url }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 端口从 dsh-browser-live 的 state.json 读（**不写死**）：浏览器重启后端口会变，
// 实测重启一次就从 9799 变成 9614 —— 写死会导致"连得上但 evaluate 全部超时"这种难查的症状。
const port = Number(process.env.VB_CDP_PORT || (() => {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME || '', 'dsh-browser-live', 'state.json'), 'utf8'))
    return st.port
  } catch { return 9799 }
})())

if (mode === 'list') {
  const dirs = fs.existsSync(OUT_ROOT) ? fs.readdirSync(OUT_ROOT).filter((d) => d !== '.profile' && fs.statSync(path.join(OUT_ROOT, d)).isDirectory()) : []
  console.log('已建立的基准：' + (dirs.length ? '' : '（无）'))
  for (const d of dirs) {
    const mf = path.join(OUT_ROOT, d, 'manifest.json')
    const m = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null
    const shots = fs.readdirSync(path.join(OUT_ROOT, d)).filter((f) => f.endsWith('.png') && !f.endsWith('.after.png'))
    console.log('  ' + d + '  ' + shots.length + ' 张' + (m ? '  建于 ' + m.capturedAt : ''))
  }
  process.exit(0)
}

let exitCode = 0
// selftest 不需要基准目录（它拿"当前截图 vs 涂改后的当前截图"自比）⇒ 别让 path.join 炸掉
const baseDir = dir ? path.join(OUT_ROOT, dir) : null
if (mode === 'compare' && !fs.existsSync(path.join(baseDir, 'manifest.json'))) {
  console.error('基准不完整：' + baseDir + ' 里没有 manifest.json（先跑 capture）')
  process.exit(2)
}

console.log('=== 视觉基准 ' + mode + '：' + dir + ' ===')
const cdp = await cdpSession(port)
console.log('  已连上: ' + cdp.url)

// 开工前先探页面网络通道（见 preflightPageFetch 注释：挂了的话后面会以一个看不懂的超时崩）
{
  const probe = await preflightPageFetch()
  console.log('  预检 page fetch: ' + probe)
  if (probe !== 'ok:200') {
    console.error('\n✗ 页面里的 fetch 通道不可用（' + probe + '）。')
    console.error('  这不是本脚本的问题，重启浏览器即可恢复：')
    console.error('    browser_close{} → browser_open{gui:true}')
    console.error('  不要在这个状态下继续比 —— 后面冻结轮播/钉图都会崩在一个看不懂的超时上。')
    process.exit(3)
  }
}

/**
 * 开工前的自检：页面的 fetch 通道还活着吗？
 *
 * 为什么需要：浏览器用久了（反复刷新/反复跑本脚本之后）会出现一种**很难查的状态** ——
 * `Runtime.evaluate` 里的纯计算（1+1）秒回，但只要表达式里 `await fetch(...)` 就永久挂住，
 * 表现为本脚本在 freezeRotation 那步 "CDP 超时: Runtime.evaluate" 然后整个 run 崩掉。
 * 根因在页面/浏览器侧的网络通道（不是本脚本），**重启浏览器即恢复**。
 * 与其让它以一个看不懂的超时崩，不如开工前先探一下并给出明确修法。
 */
async function preflightPageFetch() {
  // ⚠️ 必须用**短超时且容忍超时**，不能走普通 readState（它 30s 才放弃）。
  // 实测：坏状态下页面里 `await fetch(...)` 连表达式自带的 AbortController 都不生效
  // （请求把事件循环一起卡住），preflight 自己会挂满 30s 才崩 —— 那就完全没起到
  // "早点明确报错" 的作用。所以这里自带超时，超时即判通道不可用。
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async()=>{
      const c=new AbortController(); setTimeout(()=>c.abort(),4000);
      try { const x=await fetch('/bga/settings.json',{cache:'no-store',signal:c.signal}); return 'ok:'+x.status }
      catch(e){ return 'err:'+e.name }
    })()`,
    returnByValue: true, awaitPromise: true,
  }, 9000).catch((e) => ({ __timeout: true, message: String(e && e.message) }))
  if (r.__timeout) return 'timeout(页面 fetch 卡住，9s 未返回)'
  if (r && r.exceptionDetails) return 'exception:' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || '').slice(0, 60)
  return r && r.result ? r.result.value : 'no-value'
}

/**
 * 读页面状态。**必须带 awaitPromise** —— 表达式里一旦有 `(async()=>{...})()`（例如
 * 读设置要走 fetch），不带的话拿回来是个 Promise 对象而不是值，`JSON.parse` 直接失败。
 * 这个坑踩过：冻结轮播时读到 null，于是"跳过冻结"，一路静默不生效。
 * returnByValue 也一起开着，否则拿到的是远程对象引用、取不到值。
 */
async function readState(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r && r.exceptionDetails) {
    // 页面里抛错时不要静默返回 null —— 那会让"读不到"和"读到 null"混在一起
    throw new Error('页面表达式抛错: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text))
  }
  return r && r.result ? r.result.value : null
}

/**
 * 把页面准备到某个状态要观察的样子：先执行 open（如果需要打开 UI），再等它稳定。
 * 两个 open 是因为"打开设置对话框"与"点开底图工坊导航项"是两步，中间要各自等一次渲染。
 */
/**
 * 稳定区：裁掉"会自己变"的部分，只留底图插件真正负责渲染的区域。
 *
 * 三条竖切（实测坐标，1654×905 视口）：
 *   · 左侧栏 x[0,300]     —— 底图插件的 orb 与主题染色都在这里，是**必须比**的；
 *   · 会话区 x[300,1300]  —— **必须排除**：对话内容随会话实时变化（正在跑 agent 时每帧都在变）。
 *                            实测：同一份代码连捕两次，会话区差 7.2%、而左侧栏差 0.000%。
 *   · 右侧   x[1300,1654] —— 观察窗/滚动条等，排除。
 * 竖切之后按 STABLE_KEEP_RATIO 再横向裁掉底部（宿主状态栏实时计数 + 装饰粒子）。
 *
 * 换句话说：**只看插件自己画的那一条**。会话内容是宿主的、且天然在变，把它算进"视觉回归"
 * 只会制造假警报 —— 实测就是这样把一次"其实完全没变"的切换报成了 5%。
 */
// ---------------------------------------------------------------- 比对口径
// 口径（裁剪范围 / 容差 / compareStable）已抽到 tools/oracle-compare.mjs ——
// 原因是审计脚本 audit-oracle-coverage.mjs 也需要同一份口径，而本文件是可执行脚本
// （顶层有 await，import 会直接跑起来）没法被复用，于是审计只能自己复制一份、
// 结果两份实现漂移了（审核方指出：审计还是旧的"先裁后缩"顺序，11/11 没测到真实路径）。
// 现在两边都 import 同一份，不再有第二份实现。
import {
  STABLE_RECT_BY_STATE, MASK_RECTS, REF_CSS_WIDTH, PIXEL_TOLERANCE, EXPECT_GEOMETRY,
  compareStableFiles, compareStableImages, paint, cssScale, deriveGeom, cropStable,
  pluginRectRel, assertLayoutContract,
  rotationRestoreNeed, judgeRotationRestore, isValidSettings,
} from './oracle-compare.mjs'

// 本文件内部沿用旧名字，避免大改调用点
function compareStable(baseFile, nowFile, stateName, geomBase, geomNow, opts2) {
  return compareStableFiles(baseFile, nowFile, stateName, geomBase, geomNow, opts2)
}
/** 关掉 dsh-browser-live 的观察窗（它实时镜像页面，是不确定性的主源）。 */
async function closeObserver(log) {
  const r = await readState(`(()=>{
    const panel=document.querySelector('.bl-panel');
    const hide=document.getElementById('bl-hide');
    // 面板可能已经收起来了（display:none）——那就没什么要做的
    if(!panel || getComputedStyle(panel).display==='none') return 'panel-already-hidden';
    if(!hide) return 'no-hide-button';
    hide.click();
    return 'panel-hidden';
  })()`)
  if (log) console.log('     观察窗: ' + r)
  // 关面板会调 closeStream()（停掉实时帧流），留一点时间让它真的停
  await sleep(700)
}
// **冻结轮播**：底图插件的自动换图会在"录基准"与"比对"之间换掉底图 —— 实测踩到过：
// 两次捕获差 98%，因为壁纸从"瓦伦塞梅"轮到了"洁西卡金蜜"。那不是回归，是插件在正常工作。
//
// ⚠️ **这个 PUT 是整份覆盖写，不是合并**（host 的 writeSettings 直接 writeFile(body)）。
// 我第一次写成 `PUT {autoOn:false}`，**把用户的 25 个设置字段全清了**（wallpaper/accent/
// 全部外观参数），只剩两个字段。已用老插件的同 schema 文件 + 当天读到的真实值重建。
// 所以这里必须：① 先 GET 整份；② 只改 autoOn；③ 把**整份**写回。
// 好在窗口尺寸/DPI 没变，基准本身不受影响；但这是必须记下来的教训。
async function freezeRotation(log) {
  const raw = await readState(`(async()=>{
    const r = await fetch('/bga/settings.json', {cache:'no-store'});
    return await r.text();
  })()`)
  let before = null
  try { before = JSON.parse(raw) } catch { /* 读不到就不动 */ }
  // ⚠️ 必须用 isValidSettings（判"含已知设置键"），不能只查"是对象"：
  // 宿主的 readSettings 在**磁盘读取失败时返回 `{}` 且 GET 仍报 200**（host index.js：
  // `catch { return {} }`）。`{}` 恰好是对象 ⇒ 旧检查放行 ⇒ 审核方复现过：
  // 首次读失败被当合法原值 ⇒ 钉图写入 autoOn=false ⇒ 还原判"无需还原" ⇒ exit=0，
  // 用户的轮播被留在关。数组同理（typeof [] === 'object'）。
  if (!isValidSettings(before)) {
    if (log) console.log('     轮播: 读到的不是合法设置（宿主读失败会返回 {} 且报 200）—— 视同读失败，不做任何写入')
    return null
  }
  // **关键是钉住 wallpaper，不只是关轮播**：
  // 关轮播只保证"从现在起不再换"，但"现在这张"可能与录基准时那张不同（轮播在我们开始前
  // 已经换过了）—— 实测就这样连续踩了三次：洁西卡金蜜 → 重返未来1999 → 百夫长。
  // 所以冻结必须同时把 wallpaper 固定成**基准里记下的那一张**（由调用方传入期望值；
  // 首次 capture 时用当前这张，之后 compare 时读基准 manifest 里的值）。
  return { raw, before }
}

/** 把 wallpaper 钉到指定那张（只改 wallpaper，其余整份保留）。
 *
 * ⚠️ 修一个"读失败却仍然写入"的缺陷（审核方在内存里复现过这条路径）：
 *   `freezeRotation()` 首次 GET 失败会返回 null；但 compare/capture 之后仍会调本函数，
 *   而本函数**自己又 GET 一次** —— 若这次成功，就会带着 `autoOn:false` 写进去。
 *   于是出现：首次读失败 → 第二次读成功 → 钉图写入 autoOn=false →
 *   还原阶段因"没有原值"返回 skipped → **exit=0**，用户的轮播却被我们关掉了且无人报错。
 *   "没有原值"**并不保证**"没有写入"。
 * 现在：必须**显式传入已确认有效的原始设置**（frozen.before）才允许写；
 * 拿不到就拒绝写入并如实报告，由调用方决定怎么退出。
 */
async function pinWallpaper(wallpaper, log, frozenBefore) {
  if (!isValidSettings(frozenBefore)) {
    console.error('     ✗ 钉图被拒绝：没有有效的原始设置可依据（{} 不算有效——宿主读失败长这样）。')
    return false
  }
  const nowRaw = await readState(`(async()=>{const r=await fetch('/bga/settings.json',{cache:'no-store'});return await r.text()})()`)
  let now = null
  try { now = JSON.parse(nowRaw) } catch { now = null }
  // 同一条判据：now 不合法 ⇒ **拒绝写**（写下去就是把用户设置清成 2 字段）
  if (!isValidSettings(now)) {
    console.error('     ✗ 钉图被拒绝：当前设置读失败/不合法（写下去会覆盖成残缺文件），本次不写。')
    return false
  }
  const patched = JSON.stringify({ ...now, autoOn: false, wallpaper })
  const r = await readState(`(async()=>{
    const res = await fetch('/bga/settings.json', {
      method:'PUT', headers:{'content-type':'application/json'},
      body: ${JSON.stringify(patched)},
    });
    return res.ok ? 'pinned(' + ${JSON.stringify(wallpaper && wallpaper.name)} + ') + autoOn=false' : 'PUT failed ' + res.status;
  })()`).catch((e) => 'PUT threw: ' + String(e && e.message || e).slice(0, 60))
  if (log) console.log('     钉图: ' + r)
  // ⚠️ 修缺陷三（审核方第七轮）：上一版这里**只打印** PUT 失败、刷新异常被 catch 吞掉、
  //   最后无条件 return true ⇒ 模拟 PUT 503 或刷新失败时，截图时客户端 autoOn 仍是 true，
  //   capture/compare 却 exit=0。现在三步都要确认成功才返回 true：
  //   ① PUT 确实 ok；② 刷新没抛错；③ 刷新后**客户端内存里真的钉上了**（读 __bgaStateProbe）。
  if (typeof r !== 'string' || !r.startsWith('pinned(')) {
    console.error('     ✗ 钉图写入未确认：' + String(r))
    return false
  }
  // **写完必须刷新页面**：设置是 host 侧文件，而客户端只在启动时 STORE.load() 一次
  // （见 client.js 末尾）。只写不刷新的话，磁盘上是新值、画面还是旧图 ——
  // 实测踩到：manifest 记的是"玛尔莎"、基准图里却是"牙仙1"，一路 93% 假回归。
  await sleep(400)
  try { await cdp.send('Page.reload', { ignoreCache: false }) } catch (e) {
    console.error('     ✗ 钉图后刷新失败：' + String(e && e.message || e).slice(0, 80) + ' —— 客户端内存可能仍是旧状态')
    return false
  }
  await sleep(3500) // 等重载 + 底图解码
  // ③ 确认客户端真的把这张图**钉上画面了** —— 不只是设置值。
  // ⚠️ 上一版这里只读 __bgaStateProbe()（= 客户端的**设置**状态），验浅了：
  //   真机实测出现过「设置里已钉上小瑞安侬3、探针也说 file 对，但 body::before 的
  //   backgroundImage 还是重返未来1999」—— 于是基准是在**另一张图**上录的，
  //   之后每次 compare 都报 93%。审核方要的"客户端钉图状态"必须验到**实际渲染**。
  //   所以这里同时检查画面背景 URL 里确实是那张图（URL 是 encodeURIComponent 后的文件名）。
  const confirm = await readState(`(()=>{
    try {
      const bi = String(getComputedStyle(document.body, '::before').backgroundImage || '')
        + '|' + String(getComputedStyle(document.documentElement, '::before').backgroundImage || '');
      const s = (typeof window.__bgaStateProbe === 'function') ? window.__bgaStateProbe() : null;
      return JSON.stringify({
        probe: s ? 'ok' : 'absent',
        autoOn: s ? s.autoOn === true : null,
        file: s && s.wallpaper ? s.wallpaper.file : null,
        rendered: bi.slice(0, 500),
      });
    } catch(e){ return JSON.stringify({probe:'error', msg:String(e.message).slice(0,50)}) }
  })()`).catch(() => null)
  let cf = null
  try { cf = JSON.parse(confirm) } catch { cf = null }
  if (!cf || cf.probe !== 'ok') {
    console.error('     ✗ 钉图后无法确认客户端状态（探针 ' + (cf ? cf.probe : '读不到') + '）—— 不假定成功')
    return false
  }
  if (cf.autoOn !== false || cf.file !== (wallpaper && wallpaper.file)) {
    console.error('     ✗ 钉图未生效：客户端内存 autoOn=' + cf.autoOn + '、壁纸=' + String(cf.file)
      + '（期望 autoOn=false、' + String(wallpaper && wallpaper.file) + '）')
    return false
  }
  const want = String(wallpaper && wallpaper.file || '')
  // 渲染确认：从背景的 URL 里**解析出壁纸文件名再精确比对**。
  // ⚠️ 不要写成 `rendered.indexOf(want)` 这种子串匹配 —— 实测 A5 场景里
  //    want='x.png'，而 URL 是 http://x/... 就含 'x' ⇒ 松匹配会**假通过**。
  //    页面里 URL 是 encodeURIComponent 过的，所以取 /bga/wallpapers/ 之后那段并解码。
  const names = []
  const src = String(cf.rendered || '')
  let from = 0
  for (;;) {
    const i = src.indexOf('/bga/wallpapers/', from)
    if (i < 0) break
    from = i + 1
    let j = src.length
    for (const sep of ['"', ')', ',', ' ', "'"]) { const k = src.indexOf(sep, i + 16); if (k >= 0 && k < j) j = k }
    const raw = src.slice(i + 16, j)
    let dec = raw
    try { dec = decodeURIComponent(raw) } catch { /* 保持原样 */ }
    names.push(dec)
  }
  const hit = want !== '' && names.some((n) => n === want || n.replace(/^.*\//, '') === want)
  if (!hit) {
    console.error('     ✗ 钉图未渲染：设置是「' + want + '」但画面背景是 '
      + (names.length ? names.join(' / ').slice(0, 120) : '（没解析出壁纸 URL）') + ' —— 不能继续')
    return false
  }
  if (log) console.log('     钉图确认: autoOn=false、设置已钉上、**画面背景确实是这张** ✓')
  return true
}

/**
 * 还原轮播设置。**返回三态字符串，不是布尔** —— 这一点被审核方指出了漏洞：
 *
 *   返回 'restored'   已还原（或**本来就不需要还原**，例如用户原本就关着轮播）
 *   返回 'skipped'    没有可还原的原值（本来就没冻结成功）—— 无需报错
 *   返回 'failed'     确实需要还原但没成功 —— **调用方必须据此置失败退出码**
 *
 * 为什么要三态：原来只返回 true/undefined，调用方写 `if (restored !== true)` ⇒
 * "用户原本就关着轮播"（无需还原、返回 undefined）被**误报成还原失败**，
 * 结果一次正常的运行以 exit=5 结束（审核方模拟"轮播原本关闭 + 视觉比较通过"复现）。
 * "无需还原"与"还原失败"是两件事，必须在返回值里分开。
 */
async function restoreRotation(before, log) {
  // 判断逻辑走 oracle-compare.mjs 的**纯函数**（这样能离线单测，见该文件注释）
  const need = rotationRestoreNeed(before)
  if (need === 'skip') {
    if (log) console.log('     轮播: 没有可还原的原值（当初就没冻结成功）—— 无需还原，不算失败')
    return 'skipped'
  }
  if (need === 'not-needed') {
    if (log) console.log('     轮播: 原本就是关的，无需还原（不算失败）')
    return 'restored'
  }
  let want = null
  try { want = JSON.parse(before) } catch { /* 已由 need 判定过，这里必然可解析 */ }
  // 还原时**把当前 wallpaper 一起带回原值**：冻结期间轮播可能已经换过图，
  // 磁盘上的 wallpaper 字段可能已经不是原来那张。整份回填会把 wallpaper 也还原成
  // 采集前那张 —— 但那和"当前页面上正在显示的那张"又可能不一致。
  // 所以这里只还原 autoOn 与 autoMin（轮播开关与间隔），**不动 wallpaper**：
  // 用户看到哪张就留哪张，我们把"轮播开着"这个状态还回去即可。
  const nowRaw = await readState(`(async()=>{const r=await fetch('/bga/settings.json',{cache:'no-store'});return await r.text()})()`)
  let now = null
  try { now = JSON.parse(nowRaw) } catch { now = null }
  const merged = { ...(now && typeof now === 'object' ? now : want), autoOn: true }
  if (Number.isFinite(want.autoMin)) merged.autoMin = want.autoMin
  for (const k of Object.keys(want)) if (!(k in merged)) merged[k] = want[k] // 兜底：任何丢掉的字段补回来

  // ⚠️ **只写磁盘是不够的** —— 这是本脚本一个真实的缺陷（审核方复现指出）：
  //   客户端的内存 state 里 autoOn 仍是 false，而它在**任何**状态变更时都会把整个内存
  //   state 整份 PUT 写回（client.js 的 STORE.save → flushSave）。于是我们这次"还原"
  //   会在用户下一次点任何开关时被内存里的 false 覆盖掉。
  //   实测证据：跑完若干次 oracle 之后，磁盘上 autoOn=False（而本文档与提交信息都写了
  //   "已还原为 true"）—— 那个说法是错的，特此更正。
  // 正确做法：写盘**之后**再刷新页面，让客户端重新 load 一次、把内存也变成 true。
  // 这样内存与磁盘一致，后续任何写回都不会再把 autoOn 变回 false。
  const r = await readState(`(async()=>{
    const res = await fetch('/bga/settings.json', {
      method:'PUT', headers:{'content-type':'application/json'},
      body: ${JSON.stringify(JSON.stringify(merged))},
    });
    return res.ok ? 'autoOn=true 已写盘（字段 ' + ${Object.keys(merged).length} + ' 个）' : 'PUT failed ' + res.status;
  })()`)
  if (log) console.log('     轮播还原·写盘: ' + r)

  // 刷新让客户端内存同步；随后**同时**确认磁盘与客户端内存。
  //
  // ⚠️ 修两个会被误判成"还原成功"的缺口（审核方复核指出）：
  //   ① 原来 `try { reload } catch {}` **把刷新失败吞掉**，然后只读磁盘 ⇒ 磁盘是 true
  //      就返回成功，而页面内存可能仍是 false，下一次保存又把磁盘改回去。
  //      现在刷新失败**向上传递**（reloadErr 记录并在最后如实报出）。
  //   ② 原来只检查磁盘，**没确认客户端内存**。现在额外探客户端实际状态：
  //      用底图插件暴露的 STORE（如果拿得到）或退而求其次——检查页面上"轮播"开关的
  //      实际勾选状态；两者都拿不到时至少把"未能确认内存"如实写进结果。
  await sleep(300)
  let reloadErr = null
  try { await cdp.send('Page.reload', { ignoreCache: false }) } catch (e) { reloadErr = e }
  await sleep(3500)
  if (reloadErr) {
    console.error('     ❌ 刷新页面失败（' + String(reloadErr.message || reloadErr).slice(0, 80) + '）'
      + ' —— 客户端内存可能仍是 autoOn=false，下次保存会把磁盘改回去。还原**未确认**。')
  }

  // 磁盘
  const verifyRaw = await readState(`(async()=>{const x=await fetch('/bga/settings.json',{cache:'no-store'});return await x.text()})()`).catch(() => null)
  let v = null
  try { v = JSON.parse(verifyRaw) } catch { v = null }
  const diskOk = !!(v && v.autoOn === true)

  // 客户端内存：读插件自己挂的**只读观测点** window.__bgaStateProbe()。
  // 为什么必须有这一条：磁盘与客户端内存是两份；客户端在任何变更时会把**内存整份写回**，
  // 所以"磁盘是 true"根本不能证明"内存是 true"。实测踩到：oracle 跑完后 autoOn=False。
  // 观测点由插件在 client.js 末尾挂出（只读快照，含轮播定时器是否在跑 = 内存态的直接证据）。
  const memProbe = await readState(`(()=>{
    try {
      if (typeof window.__bgaStateProbe === 'function') {
        const s = window.__bgaStateProbe();
        return JSON.stringify({ src:'probe', autoOn: s.autoOn === true, autoPending: s.autoPending === true, autoMin: s.autoMin });
      }
      // 退路：设置页里的"自动切换"开关（input[type=checkbox] 勾选态）
      const d=document.querySelector('[role="dialog"]');
      const scope=d||document;
      const boxes=[...scope.querySelectorAll('input[type=checkbox]')];
      for(const b of boxes){
        const txt=(b.closest('label')||b.parentElement||{}).textContent||'';
        if(/自动|轮播|定时|切换/.test(String(txt))) return JSON.stringify({ src:'switch', autoOn: b.checked===true });
      }
      return JSON.stringify({ src:'unavailable' });
    } catch(e){ return JSON.stringify({ src:'error', msg:String(e.message).slice(0,60) }) }
  })()`).catch(() => null)
  let mem = null
  try { mem = JSON.parse(memProbe) } catch { mem = null }
  const memKnown = !!(mem && mem.src !== 'unavailable' && mem.src !== 'error')
  const memOk = memKnown ? mem.autoOn === true : null

  if (log) {
    console.log('     轮播还原·磁盘: autoOn=' + (v ? v.autoOn : '读不到') + (diskOk ? ' ✅' : ' ❌'))
    console.log('     轮播还原·内存: ' + (memKnown ? ('autoOn=' + mem.autoOn + (memOk ? ' ✅' : ' ❌') + '（来自 ' + mem.src + '）')
      : '未能确认（无可用探针）—— 不计为成功'))
  }
  // 判定也走纯函数（可离线单测）
  const outcome = judgeRotationRestore(need, {
    diskOk, memKnown, memOk, reloadFailed: !!reloadErr,
  })
  if (outcome === 'failed') {
    console.error('     ⚠️ 轮播未能确认还原：磁盘=' + (diskOk ? 'true ✅' : '仍未 true ❌')
      + '、内存=' + (memKnown ? String(memOk) : '未能确认') + (reloadErr ? '、刷新失败' : '')
      + '。请检查 $DSH_HOME/dsh-bg-atelier-plus/settings.json 的 autoOn，或重跑本脚本。')
  }
  return outcome
}

/**
 * 把页面复位到「干净首页」：关掉任何已打开的设置对话框。
 *
 * 为什么必须**每帧之前**都做：03 状态会主动打开设置面板，而它**不会自己关**。下一个状态
 * （甚至下一次运行）如果不先复位，就会带着上一个状态的面板 —— 实测踩到两次：
 *   · 三个状态全都带着同一个面板，基准之间只差 0.05%，等于没区分开；
 *   · 上一轮 run 结束后面板还开着，下一轮 run 的 01 状态拍到了"面板开着"，
 *     与"干净首页"的基准差 93% —— 看起来像严重回归，其实只是状态没复位。
 * 所以复位不能只写在 prepareState 里（那只覆盖"下一个状态"），必须在每次 run 开始时也来一次。
 */
async function resetToCleanHome(log) {
  const closed = await readState(`(()=>{const d=document.querySelector('[role="dialog"]');
    if(!d) return 'already-clean';
    const btn=[...d.querySelectorAll('button')].find(b=>String(b.getAttribute('aria-label')||b.textContent||'').trim()==='关闭');
    if(btn){btn.click();return 'closed'} return 'no-close-button'})()`)
  if (log) console.log('     复位: ' + closed)
  await sleep(900)
  return closed
}

/**
 * 环境准备（截图前必须执行，捕获与比对两次都要）：让画面进入**确定性**状态。
 *
 * 两条干预（都**可逆**，由 cleanupEnvironment 成对移除；刷新也清；不写盘、不改插件源码）：
 *
 * ① **在对话框背后垫一块固定颜色**（洋红）。
 *    宿主设置对话框背景是 3% 半透明（rgba(...,0.97)），**背后**的会话内容以 3% 权重透进
 *    面板像素；我自己的命令输出不断往会话里加内容 ⇒ 面板像素漂几级（实测 Δ≤10、17000+ 像素）。
 *    垫固定底之后，面板合成 = 0.97*面板 + 0.03*洋红 —— 确定。**谁的样式都不改**（对比上一版
 *    "把半透明抬成不透明"的教训，见 prepareEnvironment 函数体内注释）。
 *
 * ② **停掉插件自己的动画装饰层**。
 *    实测文档里查到 41 个带 CSS 动画的元素：`bga-fly f1..f22`、`bga-star s1..s17`、
 *    `bga-meteor`，其中 **30 个落在面板矩形内**（如 `bga-fly f1@542,705`）。
 *    它们是**持续飘动的粒子/星光**（用户设置的 `effect: firefly`），每帧都在动 ⇒
 *    任意两张截图都不可能一致。实测证据最直接：
 *      · 停动画**之前**：连截两张 diff=**1608**、maxΔ=3
 *      · 停动画**之后**：连截两张 diff=**0**、maxΔ=0
 *    ⇒ 那点残留差异**全部**来自这层动画。
 *
 * **代价与边界（必须如实写）**：动画**本身**不再被像素回归覆盖 —— 因为它根本无法被像素比较
 * （同一帧不可能重现）。被覆盖的是**静态渲染**：布局、配色、文字、按钮、面板结构。
 * 动效的正确性应靠**功能验证**（开一次动效壁纸看是否在动），不是靠截图比对。
 *
 * 和"放宽容差"的区别：容差会把"整屏偏色"一起放过（审核方已证）；这里是**冻结一个连续变化的
 * 装饰层**，静态部分的灵敏度一点没降（容差仍为 0）。
 */
async function prepareEnvironment(log) {
  const r = await readState(`(()=>{
    let st=document.getElementById('vb-env');
    if(!st){ st=document.createElement('style'); st.id='vb-env'; document.head.appendChild(st) }
    st.textContent = [
      // ② 停掉插件的动画装饰层（bga-fly / bga-star / bga-meteor）——见上方说明
      '[class*="bga"]{animation:none!important}',
      '[class*="bga"] *{animation:none!important}',
    ].join('\\n');

    // ① 在对话框背后垫一块固定颜色（洋红）。
    // ⚠️ 为什么用"垫底"而不是上一版的"把半透明改成不透明"（审核方第六轮指出后者是错的）：
    //    上一版的判定是"类名不含 bga 就当宿主样式"——**不成立**：插件自己就会在宿主选择器上
    //    写底色（client.js settingsSurfaceCss 写 [role="dialog"][class*="panel"] 与
    //    [role="dialog"]>[class*="settings" i] 的 background-color）。于是那次 alpha 抬升
    //    把插件写的 0.97 与 0.50 的背景**一并改成了同一个不透明色**——"静态灵敏度没降"
    //    的说法不成立。垫底则**谁的样式都不改**：
    //      · 面板 alpha/颜色任何变化仍然被检出（垫底色与面板色差异大 ⇒ alpha 变化信号最强）；
    //      · 同机制的有效性已实测：背后铺红 ⇒ 面板像素变 137116 px（证明透光通道是活的）。
    const dlg = document.querySelector('[role="dialog"]');
    let backdrop = 0;
    if (dlg && !document.getElementById('vb-backdrop')) {
      const bd = document.createElement('div'); bd.id = 'vb-backdrop';
      bd.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none;background:rgb(255,0,255)';
      document.body.appendChild(bd); backdrop = 1;
    }
    return 'applied(backdrop=' + backdrop + ')';
  })()`)
  if (log) console.log('     环境: 停插件动画 + 对话框垫固定底 ' + r)
  await sleep(200)
  // 把"垫底到底有没有生效"**回传**（不再只打印）。为什么必须回传：垫底没生效时，
  // 宿主 3% 透光会把会话内容透进面板 —— 表现是**静默的 0.57% 假回归**（实测），
  // 比"大声失败"坏得多。调用方据此把这一次判为"画面不可信"。
  const m = /backdrop=(\d+)/.exec(String(r))
  return { applied: true, backdrop: m ? Number(m[1]) : 0 }
}

/**
 * 环境清理（与 prepareEnvironment 成对）。返回布尔：true=清理成功（或页面已消失、无需清理）。
 *
 * ⚠️ 修两处（审核方第七轮）：
 *   ① 上一版 `.catch(() => null)` 把**清理自身的异常吞掉**、还打印"样式随刷新消失"这种
 *      安慰话 —— 模拟清理超时后仍 exit=0。现在清理失败如实返回 false，由调用方置退出码。
 *   ② 上一版把清理挂在还原**之后**（同一个 finally 里顺序执行）⇒ 还原抛异常时清理根本不执行
 *      （审核方让还原读取抛错，实测清理 0 次、两个注入物都残留）。现在调用方用**独立的
 *      try/finally**：还原怎么炸都不影响清理。
 */
async function cleanupEnvironment(log) {
  let r = null
  let threw = null
  try {
    r = await readState(`(()=>{
      const out={style:false,backdrop:false};
      const st=document.getElementById('vb-env');
      if(st){ st.remove(); out.style=true }
      const bd=document.getElementById('vb-backdrop');
      if(bd){ bd.remove(); out.backdrop=true }
      return JSON.stringify(out);
    })()`)
  } catch (e) { threw = e }
  if (threw) {
    // 页面本身已经不可用（比如已经关了）⇒ 没有残留可言，算清理成功；
    // 但**执行了却抛错**（超时/表达式错）⇒ 清理未确认，返回 false。
    const dead = /没响应|连接失败|not found|closed|no page|target/i.test(String(threw.message || threw))
    if (dead) { if (log) console.log('     环境清理: 页面已关闭，无残留'); return true }
    console.error('     ✗ 环境清理执行失败（' + String(threw.message || threw).slice(0, 70)
      + '）—— 注入的样式/垫底可能残留，请刷新页面')
    return false
  }
  if (log) console.log('     环境清理: ' + (r || '读不到结果'))
  return true
}

/** 这次**实际参与比较**的设备像素尺寸（录制时算一次存进基准，比对时用来查覆盖缩水）。 */
function comparedBoxOf(geom, pngBase64, stateName) {
  try {
    const img = decodePng(Buffer.from(pngBase64, 'base64'))
    const c = cropStable(img, stateName, geom)
    return { width: c.width, height: c.height }
  } catch { return null }
}

/**
 * 在**运行时**从实测锚点导出这一次比对的几何（CSS 矩形 + 屏蔽框 + CSS 视口宽）。
 *
 * ⚠️ 为什么必须有这个（用户第八轮指出"要可迁移别写死内容，一换就读取不了"）：
 *   原先把 REF_CSS_WIDTH=1418 和 03 的绝对矩形写死，换浏览器（Edge→Chrome）后窗口变成
 *   CSS 1426 / 截图 1664，对话框整体右移 4px ⇒ 整套坐标失准、几何核对直接拒绝工作。
 *   常量只能当兜底；真相来自**每次都量的锚点元素**。规则：
 *   · cssWidth = 实测 innerWidth（不再假设 1418）
 *   · 03 的矩形 = .bga-studio 的实测矩形（左右各留 6/4px 余量、上留 4px），
 *     下沿取 min(面板底, 对话框底) − 7（那 7px 是宿主裁剪边的取整碎行，实测 127px/Δ2 全在那）
 *   · 03 的屏蔽框 = .bga-hero 的实测矩形 +2px（43MP 预览图跨刷新重采样不稳）
 *   · 01/02 的右边界 = 会话列表里"X天前"这类**日期文字的左边界** − 1（它们随时间变）；
 *     下沿 = innerHeight − 156（再往下是宿主状态栏的实时计数），都相对实测视口推导
 *   锚点拿不到 ⇒ 返回 null，由调用方**大声失败**，绝不回落到写死常量去比错地方。
 */
async function measureLiveGeom(stateName, log, rel) {
  const raw = await readState(`(()=>{
    const R=(e)=>{ if(!e) return null; const b=e.getBoundingClientRect();
      return {l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)} };
    // 会话列表里**随时间变**的那一列。⚠️ 别只按"X天前"找 —— 实测宿主的标签文本是
    // "6分钟"（**没有"前"字**），要求"前"会漏掉整列，右边界回落到"侧栏右-8"，
    // 于是把 x234-261 的时间列圈进比较区，"6分钟"→"7分钟" 就报 397 像素假回归（真机踩过）。
    // 所以：① 数字+单位，"前"可有可无；② 再兜一层"类名后缀含 time/date/ago 且含数字"。
    const TIME_RE=/^[0-9]+\\s*(秒|分钟|小时|天|周|月)前?$/;
    const vol=[];
    document.querySelectorAll('*').forEach(e=>{
      if(e.children.length>0) return;
      const t=String(e.textContent||'').trim();
      if(!t||t.length>14) return;
      const cls=String((typeof e.className==='string'?e.className:'')||'').toLowerCase();
      const suffix=(cls.split(/[_\\s]/).pop()||'');
      const byClass=/(^|_|-)(time|date|ago|elapsed)$/.test(suffix)&&/[0-9]/.test(t);
      if(TIME_RE.test(t)||byClass){
        const b=e.getBoundingClientRect();
        if(b.width>0&&b.left>=0&&b.right<=innerWidth) vol.push({l:Math.round(b.left),r:Math.round(b.right),t:t});
      }
    });
    return JSON.stringify({
      w: Math.round(innerWidth), h: Math.round(innerHeight),
      dlg: R(document.querySelector('[role="dialog"]')),
      studio: R(document.querySelector('.bga-studio')),
      hero: R(document.querySelector('.bga-hero')),
      sidebar: R(document.querySelector('[class*="sidebar" i]')),
      volatile: vol.slice(0, 60),
      // 插件**自己**在左侧栏里画出来的可见元素（orb / dock 特效等）。
      // 有它才叫比到插件；此前 01/02 的矩形是整列宿主装饰，插件的 orb（实测 y724–751）
      // 完全落在矩形之外 ⇒ 那两张状态实际上没比插件任何像素（真机查出来的）。
      plugin: (()=>{
        const out=[];
        document.querySelectorAll('[class*="bga"]').forEach(e=>{
          const b=e.getBoundingClientRect(); const cs=getComputedStyle(e);
          if(b.width<2||b.height<2) return;
          if(cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0) return;
          if(b.left>innerWidth*0.35) return;              // 只取左区的
          out.push({l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom)});
        });
        return out.slice(0, 40);
      })(),
      // **壁纸位图表面**：大图预览 + 图库缩略图。它们是把几 MP~43MP 的原图缩到几百 px，
      // 跨刷新（我们会 reload）重采样结果不完全一致 —— 实测：hero 刷新后 diff=11618/Δ3；
      // 图库缩略图带 diff=2185/Δ≤7。属"浏览器缩放同一张位图不完全可复现"，不是插件逻辑。
      // 记下它们的矩形（**裁到对话框内**），由 deriveGeom 转成屏蔽框 —— 与 hero 的处理同源。
      imgSurfaces: (()=>{
        const dlg=document.querySelector('[role="dialog"]');
        const db=dlg?dlg.getBoundingClientRect():null;
        const out=[];
        document.querySelectorAll('.bga-hero-image,.bga-picture-image').forEach(e=>{
          const b=e.getBoundingClientRect(); const cs=getComputedStyle(e);
          if(b.width<4||b.height<4) return;
          if(cs.display==='none'||cs.visibility==='hidden') return;
          let l=b.left,t=b.top,r=b.right,bo=b.bottom;
          if(db){ l=Math.max(l,db.left); t=Math.max(t,db.top); r=Math.min(r,db.right); bo=Math.min(bo,db.bottom); }
          if(r-l<4||bo-t<4) return;                       // 被对话框裁得看不见就不算
          out.push({l:Math.round(l),t:Math.round(t),r:Math.round(r),b:Math.round(bo)});
        });
        return out.slice(0, 60);
      })(),
    });
  })()`)
  let a = null
  try { a = JSON.parse(raw) } catch { a = null }
  // 规则本身是**纯函数** deriveGeom()（在 oracle-compare.mjs，可离线单测）；这里只负责量锚点。
  // ⚠️ `rel` = **基准录制时**记下的"框相对宿主的内缩量"。
  //    录制时传 undefined（由 deriveGeom 按当前局面定下并回传 rel）；
  //    比对时传基准的 rel ⇒ 框钉在**宿主**上，插件自己挪位不会把差异对齐掉。
  const g = deriveGeom(stateName, a, rel || undefined)
  if (!g) {
    console.error('  ✗ ' + stateName + '：实测几何推不出来（锚点缺失：'
      + 'dlg=' + JSON.stringify(a && a.dlg) + ' sidebar=' + JSON.stringify(a && a.sidebar)
      + ' studio=' + JSON.stringify(a && a.studio) + ' plugin=' + ((a && a.plugin) || []).length + '个'
      + '）—— 本次不比对，绝不回落到写死常量去裁错地方。')
    return null
  }
  g.volatileCount = (a.volatile || []).length
  // 插件自己相对宿主的量 —— 布局契约的断言对象（比对时与基准记的那份比）
  g.pluginRel = pluginRectRel(stateName === '03-settings-studio' ? 'studio' : 'sidebar', a)
  if (stateName !== '03-settings-studio' && g.volatileCount === 0) {
    console.log('     ⚠️ 这页没探测到随时间变的时间/日期标签 ⇒ 右边界取"侧栏右−8"；'
      + '若之后这类标签被圈进比较区会报假回归（实测踩过："6分钟"→"7分钟" 差 397 像素）')
  }
  if (log) {
    console.log('     实测几何: css宽=' + g.cssWidth + ' 矩形=' + JSON.stringify(g.rect)
      + ' 屏蔽框=' + g.masks.length + ' 时间标签=' + g.volatileCount + ' 个'
      + ' 插件相对宿主=' + JSON.stringify(g.pluginRel))
  }
  return g
}

/**
 * 核对这一次实测出的几何是否合理（不再比对绝对位置，而是比对**插件自己的尺寸**）。
 * 面板宽度是插件的固有布局，与窗口尺寸无关 ⇒ 它变了才是真回归/布局坏了。
 */
async function assertGeometry(s, log) {
  const want = EXPECT_GEOMETRY[s.name]
  if (!want) return true
  const got = await readState(`(()=>{const e=document.querySelector(${JSON.stringify(want.sel)});
    if(!e) return JSON.stringify({absent:true});
    const r=e.getBoundingClientRect();
    return JSON.stringify({l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),
      w:Math.round(r.width),h:Math.round(r.height)})})()`)
  let g = null
  try { g = JSON.parse(got) } catch { g = null }
  if (!g || g.absent) {
    console.error('  ✗ 几何核对失败：找不到 ' + want.sel + '（实际：' + String(got).slice(0, 80) + '）')
    return false
  }
  // 只断言**与窗口无关的量**：元素自己的宽高。位置随窗口变，不再当契约。
  if (want.w != null && Math.abs(g.w - want.w) > 3) {
    console.error('  ✗ 几何核对失败：' + want.sel + ' 实测宽 ' + g.w + '，期望 ' + want.w + '（±3）—— 插件布局变了')
    return false
  }
  if (log) console.log('     几何核对: ' + want.sel + ' ✓ 实测宽 ' + g.w + '（不比对绝对位置，可迁移）')
  return true
}

async function prepareState(s, log, rel, basePluginRel) {
  // 为什么必须做：上一次状态可能开着面板，不复位的话后面的状态会**继承**它 ——
  // 实测踩到过：三个状态全都带着同一个面板，基准之间只差 0.05%，等于没区分开。
  // 关掉 dsh-browser-live 的观察窗：它**实时镜像当前页面**（截出来的图里能看到 FPS 计数与
  // 递归的自己），每帧都在变 ⇒ 天然不可复现。实测：不关它，零改动两次捕获差 0.231%；
  // 关掉后归零（见 CHANGELOG / 本文件下方 REPRODUCIBILITY 段）。
  // 这是**环境准备**不是作弊：观察窗是另一个插件的调试 UI，不属于底图插件的视觉契约。
  await closeObserver(log)

  if (s.reset !== false) {
    await resetToCleanHome(log)
  }
  if (s.open) {
    const r1 = await readState(s.open)
    if (log) console.log('     打开①: ' + r1)
    await sleep(s.openSettleMs || 1000)
  }
  if (s.open2) {
    const r2 = await readState(s.open2)
    if (log) console.log('     打开②: ' + r2)
    await sleep(800)
  }
  await sleep(s.settleMs)
  // **等图片真的解码完**，而不是靠固定时长赌。
  // 实测踩到：页面刚重载（冷缓存）时，设置页里的底图预览要现解一张几 MB 的图，
  // 6 秒都不一定够 —— 表现为"重载后第一次 run 必挂 03、之后再跑就过"（4.209% 差异，
  // 差异全在面板头部的预览图上、文字一字不差）。固定时长永远只是赌，改成等条件。
  //
  // ⚠️ 返回值**必须检查**：原来这里直接忽略，于是等超时/底图加载失败时照样截图，
  // 把未完成的画面录成基准（审核方复现指出）。现在把结果交给调用方决定。
  const ready = await waitImagesReady(log, s.expectHero === true)
  // 环境准备（见 prepareEnvironment 注释）：对话框背后垫固定底 + 停插件动画。
  // **必须在截图前**，且捕获与比对两次都执行，两边才看到同一种确定性画面。
  const env = await prepareEnvironment(log)
  // ⚠️ 开着对话框的状态（03）**必须**拿到垫底，否则宿主 3% 透光会把会话内容透进面板，
  //   表现成**静默的 0.57% 假回归**（实测）—— 比大声失败坏得多，所以这里判为不可信。
  const needsBackdrop = s.expectHero === true
  const backdropOk = !needsBackdrop || env.backdrop === 1
  if (!backdropOk) {
    console.error('  ✗ 对话框垫底未生效（backdrop=' + env.backdrop + '）—— 面板像素会被背后会话内容污染，'
      + '这次画面不可信，不参与比对。')
  }
  // 几何：**运行时从实测锚点推导**（见 measureLiveGeom 注释，可迁移、不写死）。
  // 比对时把基准录下的 rel 传进去 ⇒ 框钉在**宿主**上（插件自己挪位不会被对齐掉）。
  const geom = await measureLiveGeom(s.name, log, rel || undefined)
  // 环境核对：确认插件元素还在（宽度契约）。失败 ⇒ 后续裁剪无意义。
  const geomOk = await assertGeometry(s, log)
  if (!geom) {
    console.error('  ✗ ' + s.name + '：实测几何拿不到 ⇒ 本次不比对（绝不回落到写死常量去比错地方）。')
  }
  // 布局契约：插件**自己**相对宿主的偏移与基准相比不许漂（这条专门抓"插件自己挪了"，
  // 因为裁剪框钉在宿主上时，插件挪位会变成像素差异 —— 但契约能给出带数字的明确原因）。
  let layoutDrift = null
  if (geom && basePluginRel) {
    layoutDrift = assertLayoutContract(basePluginRel, geom.pluginRel)
    if (layoutDrift) console.error('  ✗ ' + s.name + ' ' + layoutDrift)
  }
  return {
    imagesReady: ready,
    geometryOk: geomOk && !!geom,
    backdropOk,
    envApplied: env.applied,
    geom,
    layoutDrift,
  }
}

/**
 * 等「画面上真正会看到的那几张图」解码完，**并且底图确实加载成功**。
 *
 * ⚠️ 不能等 `document.images` 全部就绪：设置页的图库网格有 **300+ 张缩略图**，
 * 实测 316 张里 288 张是懒加载/屏外的（它们永远不会在我们截图时解码完）。
 * 等全部就会一直等到超时，等于没等。所以只等**在视口内可见**的。
 *
 * ⚠️ 本函数修过两个**会放过失败**的缺陷（审核方复现指出）：
 *   ① 底图加载 **error** 原来也被判"就绪"（只排除了 `timeout`）⇒ 一张根本没出来的底图
 *      会被当成"准备好"，把坏画面录成基准。现在 **error 一律算未就绪**。
 *   ② 原来的判断只看 `pending===0`：如果预览 `<img>` 还没被插进 DOM（React 尚未渲染完），
 *      pending 天然是 0 ⇒ 立刻"就绪"，于是冷缓存下会拍到没有预览图的画面。
 *      现在额外要求**关键图（.bga-hero-image 或面板里的大图）确实 complete**。
 *
 * 返回 true/false，**调用方必须检查** —— 原来调用方直接忽略返回值继续截图（见下）。
 */
async function waitImagesReady(log, expectHero = false, waitMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    const r = await readState(`(async()=>{
      // **真正可见**的判定必须把各级滚动容器的裁剪算进去。
      // 踩过的坑：原来只用 getBoundingClientRect 看"在视口内"，但面板里有纵向滚动容器，
      // 容器外的图 rect 依然落在视口坐标里、被判成可见 —— 而它们全是 loading="lazy"
      // （实测 316 张里 313 张 lazy），**不进滚动视口就永远不会加载**，
      // 于是 waitImagesReady 一直等到 30s 超时，03 状态被误判"未就绪"。
      // 正确做法：除了在视口内，还要检查没有被任何 overflow 祖先裁掉。
      const inView=(el)=>{
        const b=el.getBoundingClientRect();
        if(!(b.bottom>0 && b.top<innerHeight && b.right>0 && b.left<innerWidth && b.width>0 && b.height>0)) return false;
        let p=el.parentElement;
        while(p){
          const s=getComputedStyle(p);
          if(/auto|scroll|hidden|clip/.test(s.overflowY + ' ' + s.overflowX)){
            const pb=p.getBoundingClientRect();
            // 与最近的可滚动祖先求交集；空集 = 被裁掉了 = 不会被懒加载触发
            if(b.bottom<=pb.top || b.top>=pb.bottom || b.right<=pb.left || b.left>=pb.right) return false;
          }
          p=p.parentElement;
        }
        return true;
      };
      const vis=[...document.images].filter(i=>{const s=getComputedStyle(i);
        return s.display!=='none' && s.visibility!=='hidden' && inView(i)});
      const pending=vis.filter(i=>!i.complete||i.naturalWidth===0);
      const broken=vis.filter(i=>i.complete && i.naturalWidth===0);   // 已加载但失败（坏图）
      // 关键图：设置页里的底图预览。它没就绪就不能算稳定。
      const hero=document.querySelector('.bga-hero-image');
      const heroState = hero ? (hero.complete ? (hero.naturalWidth>0 ? 'ready' : 'error') : 'loading') : 'absent';
      // 底图：body::before 的 background-image。**不能用 new Image() 查**：
      //   实测踩到 —— 用 plain URL 建 Image() 会命中一条**失效的缓存记录**，
      //   立刻 complete 但 naturalWidth=0，被误判成"底图加载失败"，
      //   于是所有状态都被判"未就绪"、整轮 oracle 全跳过。
      //   同一 URL 加随机参数绕开缓存后 onload nw=9744；直接 fetch 是 HTTP 200 / 59MB；
      //   createImageBitmap 解出 9744×4500 ⇒ **图本身完全正常，是探测方法不对**。
      // 正确做法：fetch（no-store）拿字节 + createImageBitmap 真正解码一次。
      //   这才叫"图片就绪"——它同时验证了传输与解码，而不是只看一个缓存标志。
      let bg='unknown';
      const m=(getComputedStyle(document.body,'::before').backgroundImage||'').match(/url\\("([^"]+)"\\)/);
      if(m){
        bg = await (async()=>{
          try {
            const resp = await fetch(m[1], { cache:'no-store' });
            if (!resp.ok) return 'http-'+resp.status;
            const blob = await resp.blob();
            const bm = await createImageBitmap(blob);
            const ok = bm.width>0 && bm.height>0;
            if (bm.close) bm.close();
            return ok ? 'ready' : 'zero-size';
          } catch(e) { return 'error:' + String(e && e.name || e).slice(0,30) }
        })();
      }
      return JSON.stringify({pending:pending.length, broken:broken.length, visible:vis.length, bg, heroState});
    })()`)
    let v = null
    try { v = JSON.parse(r) } catch { v = null }
    // 读不到就**不算就绪**（原来"按就绪处理"是放过失败）——继续等，等超时由调用方处理
    if (v) {
      // **只看"关键图"**：底图（body::before）+ 面板主预览图（.bga-hero-image）。
      // 为什么不等图库缩略图：实测 316 张图里 **313 张是 loading="lazy"**，它们是不进
      // 滚动视口就不加载的缩略图；而面板刚打开那一瞬间，有 2 张恰好被判定为可见、
      // 正在加载 —— 但它们的加载与"画面是否稳定"无关（它们在面板下方/边缘，截图里
      // 也几乎看不出来）。原来等它们 ⇒ 每次都在这一步超时 30s、03 被误判"未就绪"。
      // ⚠️ `absent` 不能无条件接受（审核方复核指出）：
      //   原来写成 `heroState === 'ready' || heroState === 'absent'`，于是"预览图还没被插进
      //   DOM"（absent）与"这个状态本来就没有预览图"被当成同一件事 —— 设置页明明应该在
      //   面板头部显示当前底图的预览，如果它 missing 了，那是**没渲染完**，不是"无需等待"。
      //   修法：由调用方告诉本函数"这个状态是否期望有预览图"（expectHero）。
      const heroOk = expectHero
        ? v.heroState === 'ready'                    // 期望有 ⇒ 必须真就绪
        : (v.heroState === 'ready' || v.heroState === 'absent')  // 不期望 ⇒ absent 是正常的
      const criticalReady = v.bg === 'ready' && heroOk
      if (criticalReady && v.broken === 0) {
        if (log) console.log('     图片就绪: 底图 ready，预览图 ' + v.heroState
          + (v.pending ? '（另有 ' + v.pending + ' 张懒加载缩略图仍在加载，不影响本帧）' : '')
          + '（' + (Date.now() - t0) + 'ms）')
        return true
      }
      if (String(v.bg).startsWith('error') || String(v.bg).startsWith('http-') || v.bg === 'zero-size'
        || v.heroState === 'error' || v.broken > 0) {
        // 明确的加载失败：再等也不会好，立刻报出来（不要静默截一张坏画面）
        console.log('     ❌ 图片加载失败：底图=' + v.bg + ' 预览图=' + v.heroState + ' 坏图=' + v.broken + ' —— 画面不完整，本次不该当基准')
        return false
      }
    }
    if (Date.now() - t0 > waitMs) {
      console.log('     ⚠️ 等图超时（' + (Date.now() - t0) + 'ms）：' + (v
        ? '底图 ' + v.bg + '、预览图 ' + v.heroState + '、待解码懒加载图 ' + v.pending + ' 张'
        : '读不到状态'))
      return false
    }
    await sleep(300)
  }
}
if (mode === 'capture') {
  // ⚠️ 冻结/钉图/复位**必须包进 try/finally 里**：
  //   原来这三步写在 `try {` 之前，于是它们自己抛错时 finally 不会执行 ⇒
  //   **轮播永远停留在被关闭的状态**（用户的设置被我们改坏）。
  //   审核方复现指出过这一点；现在把它们移进来，并让 autoBefore 先声明再赋值。
  let autoBefore = null
  let restored = false
  // ⚠️ 外层 try/catch（审核方第七轮入口测试暴露）：主动拒绝时我 `throw` 出去，而顶层没有
  //   任何 catch ⇒ Node 以**未捕获异常**退出（码 1），把已经设好的 exitCode=4 冲掉了。
  //   现在：主动拒绝（已置 exitCode）按原码退出；只有没置过码的意外异常才算 1。
  try {
  try {
    // 冻结轮播 + 钉住当前这张图（结束后还原；异常也要还原，所以放 try/finally）
    const frozen = await freezeRotation(true)
    // ⚠️ 修缺陷二（审核方第七轮）：上一版 frozen=null（读不到可信原值）时只是
    //   wallpaperNow=null ⇒ 钉图被**整段跳过**，capture 照样录基准 —— 实测录下的
    //   manifest 里 pinnedWallpaper 与 rotationFrozenFrom 都是 null、轮播仍开着，
    //   而基准图却是在"随时可能换图"的状态下截的（不可信）。
    //   现在：拿不到可信原值 = **拒绝录基准**（退出码 4），不是跳过钉图继续录。
    if (!frozen) {
      console.error('  ✗ 读不到可信的原始设置（宿主读失败会返回 {} 且报 200）—— 拒绝录基准。')
      console.error('    没有可信原值就无从钉图/还原，录出来的基准也不可信（轮播可能中途换图）。')
      exitCode = 4
      throw new Error('无有效原始设置')
    }
    autoBefore = frozen.raw
    // 录制时以"页面当下正在显示的那张"为准，钉住它，并把 wallpaper 记进 manifest ——
    // 之后 compare 就按这个值钉回去，与轮播是否跑过无关。
    const wallpaperNow = frozen.before.wallpaper || null
    if (!wallpaperNow) {
      console.error('  ✗ 原始设置里没有 wallpaper —— 拒绝录基准（无法钉图 ⇒ 录到的画面可能被轮播换掉）')
      exitCode = 4
      throw new Error('原设置无 wallpaper')
    }
    if (!await pinWallpaper(wallpaperNow, true, frozen.before)) {
      exitCode = 4
      throw new Error('钉图未确认（写入/刷新/客户端状态任一没确认成功）—— 拒绝录基准')
    }
    await resetToCleanHome(true)  // 上一轮 run 可能留下开着面板
    const manifest = {
      dir, capturedAt: new Date().toISOString(), url: cdp.url,
      // 记下"比的是哪一块"：口径不藏在代码里，改口径必须重录基准
    comparison: {
      // ⚠️ 口径是**运行时实测推导**的，不是常量表（见 measureLiveGeom 注释）。
      //    每个状态实际用的几何记在 states[].geom；下面这些常量只是兜底与文档。
      geometrySource: 'measureLiveGeom() 运行时从锚点实测'
        + '（.bga-studio / 对话框 / .bga-hero / 会话日期文字 / innerWidth）',
      fallbackRectsCss: STABLE_RECT_BY_STATE, fallbackMaskRectsCss: MASK_RECTS,
      fallbackCssWidthAnchor: REF_CSS_WIDTH,
      pixelTolerance: PIXEL_TOLERANCE, geometryContract: EXPECT_GEOMETRY,
      note: '各状态矩形是 CSS 坐标，比较时乘 (截图宽 / 该次实测 innerWidth) 换算；'
        + '基准与当前**各用自己录制/运行时实测的几何**裁剪 ⇒ 换窗口尺寸/换浏览器仍能对齐同一块。'
        + '只比插件自己画的那块；宿主会话/状态栏、以及实测推导出的屏蔽框都不参与。'
        + '像素容差 ' + PIXEL_TOLERANCE + (PIXEL_TOLERANCE === 0 ? '（严格逐字节）' : '（在容差内一致）') + '。',
    },
    // 钉住的底图（compare 时按它钉回去，保证比的是同一张）
    pinnedWallpaper: wallpaperNow,
    rotationFrozenFrom: autoBefore,
    states: [],
  }
  for (const s of STATES) {
    // 图片没就绪就不录 —— 录下去等于把未完成的画面当基准（审核方指出的缺陷）
    const prep = await prepareState(s, true)
    if (prep && prep.imagesReady === false) {
      console.error('  ✗ ' + s.name + ' 图片未就绪，拒绝录基准（避免把不完整画面固化）。检查网络/底图文件后重跑。')
      exitCode = 4
      throw new Error('图片未就绪：' + s.name)
    }
    if (prep && prep.geometryOk === false) {
      console.error('  ✗ ' + s.name + ' 插件元素几何与期望不符，拒绝录基准（裁剪区域会失准）。')
      exitCode = 4
      throw new Error('几何不符：' + s.name)
    }
    // 同 compare：垫底没生效 ⇒ 录出来的基准会被宿主透光污染 ⇒ 拒绝录（而不是录一张不可信的）
    if (prep && prep.backdropOk === false) {
      console.error('  ✗ ' + s.name + ' 对话框垫底未生效，拒绝录基准（基准会被宿主透光污染）。')
      exitCode = 4
      throw new Error('垫底未生效：' + s.name)
    }
    const probeValue = await readState(s.probe)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(baseDir, s.name + '.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    manifest.states.push({
      name: s.name, note: s.note, probe: probeValue, file: path.basename(file), bytes: fs.statSync(file).size,
      // ⚠️ 记下**这一次实测出的几何**：compare 时基准那张图必须用"它自己录制时的几何"裁剪，
      // 当前这张用"现在实测的几何"裁剪 —— 两边各自换算才能对齐（可迁移的关键）。
      // geom 里同时含 rel（框相对宿主的内缩量，供比对时钉在宿主上）与 pluginRel
      //（插件相对宿主的位置，布局契约的基准值）。
      geom: prep ? prep.geom : null,
      // 覆盖基准：这次**实际参与比较的设备像素尺寸**。比对时若当前侧与之不符（哪怕两侧
      // 一起缩水），一律判"覆盖不足" —— 不许静默比交集（审核方第十轮第二条）。
      expectCompared: prep ? comparedBoxOf(prep.geom, shot.data, s.name) : null,
    })
    console.log('  ✅ ' + s.name + '  ' + fs.statSync(file).size + ' 字节')
    console.log('     探针: ' + String(probeValue).slice(0, 160))
  }
  fs.writeFileSync(path.join(baseDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log('\n基准已建立：' + manifest.states.length + ' 个状态 → ' + baseDir)
  console.log('重构后跑： node tools/visual-baseline.mjs compare ' + dir)
  } finally {
    // ⚠️ 修缺陷一（审核方第七轮）：上一版把"还原"与"清理"写在**同一个 finally 里顺序执行**
    //   ⇒ 还原一抛异常，后面的清理根本不执行（审核方让还原读取抛错，实测清理 0 次、
    //   两个注入物都残留）。现在拆成嵌套 try/finally：**还原怎么炸都不影响清理**。
    try {
      // **只有 'failed' 才算失败**（三态契约见 restoreRotation 头注释）：
      // 'restored' = 已还原或本来就不需要还原；'skipped' = 当初没冻结成功、无可还原。
      // 原来写 `!== true` 会把"用户原本就关着轮播"误报成失败（审核方复现）。
      const outcome = await restoreRotation(autoBefore, true)
      if (outcome === 'failed') {
        console.error('  ✗ 轮播还原失败 —— 用户的 autoOn 可能仍是被改过的值。退出码按失败处理（5）。')
        if (exitCode === 0) exitCode = 5
      }
    } catch (e) {
      console.error('  ✗ 轮播还原过程抛错：' + String(e && e.message || e).slice(0, 90) + ' —— 按失败处理（5）')
      if (exitCode === 0) exitCode = 5
    } finally {
      // 清理在最内层 finally：无论还原成功/失败/抛错都会执行
      const cleaned = await cleanupEnvironment(true)
      if (!cleaned && exitCode === 0) exitCode = 6
    }
  }
  } catch (e) {
    // 主动拒绝（已置 exitCode）按原码退出；没置过码的意外异常才算 1
    if (exitCode === 0) {
      exitCode = 1
      console.error('  ✗ 未预期异常：' + String(e && e.message || e).slice(0, 120))
    }
  }
} else if (mode === 'selftest') {
  // ────────────────────────────────────────────────────────────────────────────
  // 用**真实插件元素**验证"检出能力"（审核方第 1 条要求：不能只靠改坐标，还要证明
  // 改对了 —— 用实际元素植入变化、确认 oracle 会失败）。
  //
  // 做法：打开 03 设置页 → 施加环境准备 → 截图 → 在页面里**查出真实元素的 rect**
  //   → 按那个 rect 在截图上涂色 → 走**真实 compareStableImages** 比
  //   → 断言"必须判有差异"。
  // 不需要基准，随时可跑；不写任何文件。
  //
  // 为什么必须这么做：我之前只"改了坐标"，没有任何检查能证明新坐标真的覆盖到了插件元素。
  // 实际发生的正是漏检（审核方把 ＋图单/动态壁纸 改色，oracle 报 diff=0）。
  // ────────────────────────────────────────────────────────────────────────────
  const s = STATES.find((x) => x.name === '03-settings-studio')
  console.log('=== oracle 自检：用真实插件元素验证检出能力 ===')

  // 元素探测：**在插件根 .bga-studio 内**按可见文本找（比硬编码 class 稳，也避免
  // 误抓宿主左导航里同名的"底图工坊"）。返回 CSS rect。
  const SCOPE = `(document.querySelector('.bga-studio')||document)`
  const byText = (txt, maxKids = 1) => `(()=>{const R=${SCOPE};
    return [...R.querySelectorAll('button,[role="tab"],em,span,div,h2,h3')].find(e=>
      e.children.length<=${maxKids} && String(e.textContent||'').trim()===${JSON.stringify(txt)})})()`
  const PROBES = [
    ['动态壁纸标签', byText('动态壁纸')],
    ['＋图单按钮', `(()=>{const R=${SCOPE};
      return [...R.querySelectorAll('button')].find(e=>/图单/.test(String(e.textContent||''))&&String(e.textContent||'').trim().length<8)})()`],
    ['底图工坊标题', byText('底图工坊', 0)],
    ['当前选择标签', byText('当前选择', 0)],
    ['全部壁纸标题', byText('全部壁纸', 0)],
    ['搜索框', `(()=>{const R=${SCOPE}; return R.querySelector('input[type="search"]')})()`],
  ]

  let stPass = 0, stFail = 0
  const stOk = (n, c, e = '') => { if (c) { stPass++; console.log('  ✅ ' + n + (e ? '  [' + e + ']' : '')) } else { stFail++; console.log('  ❌ ' + n + (e ? '  [' + e + ']' : '')) } }

  // ⚠️ 上一版有两个"静默放行"的口子（审核方第六轮指出，模拟面板缺失时 6 个目标全部
  //    跳过仍 exit=0）：
  //      ① prepareState 的返回值被忽略 —— 图片未就绪/几何不符照样往下走；
  //      ② 元素找不到/越界直接"跳过"—— 6 个全跳 = 零验证还报成功。
  //    现在：准备失败 = 直接失败；**每个探针都是强制的**（找不到 = 失败，越界 = 失败
  //    —— 越界说明比较矩形没盖住该盖的元素）。
  try {
    const prep = await prepareState(s, true)
    if (!prep || prep.imagesReady === false) {
      stOk('截图前图片就绪', false, 'prepareState 报告未就绪 —— 继续截只会得到半成品')
    } else { stOk('截图前图片就绪', true) }
    if (!prep || prep.geometryOk === false) {
      stOk('插件元素几何核对', false, '几何与基准记录不符 ⇒ 裁剪区域失准（详见上方错误）')
    } else { stOk('插件元素几何核对', true) }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const raw = decodePng(Buffer.from(shot.data, 'base64'))
    const sc = cssScale(raw, prep && prep.geom ? prep.geom.cssWidth : REF_CSS_WIDTH)
    // 用**实测导出的几何**（不是写死常量）—— 否则 selftest 在别的窗口尺寸下会验到错的块
    const rect = (prep && prep.geom && prep.geom.rect) || STABLE_RECT_BY_STATE[s.name]
    const liveGeom = prep && prep.geom
    const inRect = (r) => r.l >= rect.x0 - 2 && r.r <= rect.x1 + 2 && r.t >= rect.y0 - 2 && r.b <= rect.y1 + 2
    const masked = (liveGeom && liveGeom.masks) || MASK_RECTS[s.name] || []

    for (const [label, finder] of PROBES) {
      const got = await readState(`(()=>{const e=${finder}; if(!e) return JSON.stringify({absent:true});
        const r=e.getBoundingClientRect();
        return JSON.stringify({l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom)})})()`)
      let g = null
      try { g = JSON.parse(got) } catch { g = null }
      // 找不到 = 失败（面板没打开/DOM 变了/选择器失效 —— 都不该静默通过）
      if (!g || g.absent || g.r <= g.l) { stOk(label + ' 存在于面板中', false, '页面里找不到：' + String(got).slice(0, 60)); continue }
      // 越界 = 失败（比较矩形没盖住它 —— 正是第五轮漏检的形态）
      if (!inRect(g)) { stOk(label + ' 落在比较矩形内', false, 'CSS' + JSON.stringify(g) + ' 越出矩形 ' + JSON.stringify(rect)); continue }
      stOk(label + ' 落在比较矩形内', true, 'CSS' + JSON.stringify(g))
      // 落在屏蔽框内的元素无法验证（那正是"能力缺口"）—— 标注而不是当成失败。
      // ⚠️ MASK_RECTS 每项是 [x0, y0, x1, y1]（x 在前）。第一版我按 [x0,x1,y0,y1] 解构，
      //    于是"当前选择"标签（在预览屏蔽框内）被判定"不在框内"，断言方向反了。
      const inMask = masked.some(([mx0, my0, mx1, my1]) =>
        g.l >= mx0 - 2 && g.r <= mx1 + 2 && g.t >= my0 - 2 && g.b <= my1 + 2)
      // 涂该元素（CSS→px，向内缩 1px 避免涂到边界外）
      const px0 = Math.round(g.l * sc) + 1, px1 = Math.round(g.r * sc) - 1
      const py0 = Math.round(g.t * sc) + 1, py1 = Math.round(g.b * sc) - 1
      const painted = paint(raw, px0, py0, Math.max(px0 + 1, px1), Math.max(py0 + 1, py1), [255, 0, 255])
      const cmp = compareStableImages(raw, painted, s.name, liveGeom, liveGeom)
      const detected = !cmp.same
      stOk(label + ' 改色被抓到' + (inMask ? '（注：该元素在屏蔽框内，预期抓不到）' : ''),
        inMask ? detected === false : detected,
        'px[' + px0 + ',' + py0 + ',' + px1 + ',' + py1 + '] diff=' + cmp.diff)
    }

    // 面板本身必须存在且被矩形覆盖（'absent' = 失败，不是跳过）
    const ownStudio = await readState(`(()=>{const e=document.querySelector('.bga-studio');if(!e)return 'absent';
      const r=e.getBoundingClientRect();return JSON.stringify({l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom)})})()`)
    let os = null
    try { os = JSON.parse(ownStudio) } catch { os = null }
    if (!os || os.absent) {
      stOk('面板 .bga-studio 存在', false, '找不到 —— 面板没打开或 DOM 变了，整轮自检无效')
    } else {
      stOk('面板 .bga-studio 的水平范围被比较矩形覆盖（CSS ' + os.l + '–' + os.r + ' vs 矩形 ' + rect.x0 + '–' + rect.x1 + '）',
        os.l >= rect.x0 && os.r <= rect.x1)
    }
  } finally {
    // selftest 也会注入环境样式 —— 必须成对清理；清理失败要影响退出码（6）
    const cleaned = await cleanupEnvironment(true)
    if (!cleaned && stFail === 0) exitCode = 6
  }

  console.log('\n自检：' + stPass + ' 通过 / ' + stFail + ' 失败')
  if (stFail > 0) exitCode = 1
  cdp.close()
  process.exit(exitCode)
} else {
  // ⚠️ 这里曾丢过一行：上一轮加 selftest 分支时把 `const manifest = ...` 一起替换掉了
  //    却没有补回来 ⇒ compare 一跑就 ReferenceError: manifest is not defined。
  //    提交前没跑真机 compare（只跑了 selftest/离线套件）所以没发现 —— 教训：
  //    动过 compare 分支就必须跑一次真机 compare 再提交。
  const manifest = JSON.parse(fs.readFileSync(path.join(baseDir, 'manifest.json'), 'utf8'))
  // 比对时：冻结轮播 + **钉回基准里记的那张底图**。
  // 只关轮播是不够的：录制之后轮播可能已经换过图，那"现在这张"与基准那张就不是同一张 ——
  // 实测连踩三次（洁西卡金蜜 → 重返未来1999 → 百夫长），探针里能直接看到 url 不同。
  // 钉回去之后，比的就一定是同一张图上的差异，那才是绘制核心的回归。
  //
  // ⚠️ 同 capture：冻结/钉图/复位都必须在 try 内，否则它们抛错时 finally 不执行，
  //    轮播会停留在被关闭的状态（用户设置被改坏）。
  let autoBefore = null
  let same = 0, diff = 0, missing = 0, notReady = 0
  const probeDiffs = []
  // 外层 try/catch：同 capture —— 主动拒绝要按已置的 exitCode 退出，不能被未捕获异常冲成 1
  try {
  try {
    const frozen = await freezeRotation(true)
    // 同 capture：读不到可信原值 ⇒ **本次比对不算数**（轮播可能还在跑，画面不可信）。
    if (!frozen) {
      console.error('  ✗ 读不到可信的原始设置（宿主读失败会返回 {} 且报 200）—— 本次比对不算数。')
      exitCode = 4
      throw new Error('无有效原始设置')
    }
    autoBefore = frozen.raw
    if (manifest.pinnedWallpaper) {
      if (!await pinWallpaper(manifest.pinnedWallpaper, true, frozen.before)) {
        exitCode = 4
        throw new Error('钉图未确认（写入/刷新/客户端状态任一没确认成功）—— 本次比对不算数')
      }
    } else {
      // 旧基准没记 pinnedWallpaper：至少要求 autoOn 已被冻结（frozen.before 可信），
      // 否则画面随时会被轮播换掉 ⇒ 比对无意义。
      console.log('   ⚠️ 基准里没有 pinnedWallpaper（旧基准）—— 已冻结轮播但无法钉回原图，结果可能受换图干扰')
    }
    // **必须**在开始逐个状态之前先复位。03 状态会主动打开设置面板且不会自己关，
    // 而 DSH 还会把"面板开着"这个状态跨刷新保留 —— 于是下一次 run 的 01 状态直接拍到
    // 面板开着的样子，与"干净首页"的基准差 93%。看起来像严重回归，其实只是状态没复位。
    await resetToCleanHome(true)
  for (const s of manifest.states) {
    const baseFile = path.join(baseDir, s.file)
    const state = STATES.find((x) => x.name === s.name)
    let prep = null
    // 把基准录下的 rel（框相对宿主的内缩量）与 pluginRel（插件相对宿主的位置）传进去：
    // 前者让裁剪框钉在宿主上，后者用来抓"插件自己挪了"。
    const baseGeom = s.geom || null
    if (state) prep = await prepareState(state, false, baseGeom && baseGeom.rel, baseGeom && baseGeom.pluginRel)
    else await sleep(2000)
    // 图片没就绪 ⇒ **本次比对不算数**，记为"就绪失败"而不是"有回归"。
    // 两者必须分开：混在一起会把"图没加载完"误报成视觉回归（审核方指出的缺陷）。
    if (prep && prep.imagesReady === false) {
      notReady++
      console.log('  ⚠️  ' + s.name + '  图片未就绪，本次跳过（不算回归，也不算通过）')
      continue
    }
    if (prep && prep.geometryOk === false) {
      notReady++
      console.log('  ⚠️  ' + s.name + '  插件元素几何与期望不符，本次跳过（裁剪区域失准，结果无意义）')
      continue
    }
    // 垫底没生效 ⇒ 面板像素会被背后会话内容污染 ⇒ **本次不算数**（不能让它冒充 0.5% 的"回归"）
    if (prep && prep.backdropOk === false) {
      notReady++
      console.log('  ⚠️  ' + s.name + '  对话框垫底未生效，本次跳过（画面会被宿主透光污染，结果无意义）')
      continue
    }
    // 布局契约：插件自己相对宿主漂了 ⇒ **这是真错误**（不是"未就绪"），计为差异并给出数字。
    // 审核方第十轮第一条：视口与宿主都不动、插件自己横移 12px，旧实现会被自动对齐吃掉。
    if (prep && prep.layoutDrift) {
      diff++
      console.log('  ❌ ' + s.name + '  ' + prep.layoutDrift + ' —— 插件自身布局错误（宿主没动）')
      continue
    }
    const probeNow = await readState(state ? state.probe : 'null')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const nowFile = path.join(baseDir, s.name + '.after.png')
    fs.writeFileSync(nowFile, Buffer.from(shot.data, 'base64'))
    // 裁稳定区 →（尺寸不同时）跨 DPI 归一 → 逐像素比。
    // 注意：裁的是**解码后**的像素，不是文件；encodePng 只用于写差异图。
    // 两边的几何**各自实测**：基准用录下来那份，当前用这一次量出来的那份
    // ⇒ 窗口尺寸/浏览器换了也能对上同一块内容（可迁移），而不是拿旧坐标裁新图。
    const geomBase = s.geom || null
    // 把**基准录制时的比较尺寸**传进去：覆盖缩水必须报"覆盖不足"，不能静默比交集
    // （审核方第十轮第二条：缩到 31 行丢掉基准 789 行后，1600 像素变化变 diff=0）
    const cmp = compareStable(baseFile, nowFile, s.name, geomBase, prep ? prep.geom : null,
      { expectCompared: s.expectCompared || null })

    // 覆盖不足 ⇒ **显式失败**，绝不当"一致"（这正是审核方要求的口径）
    if (cmp.coverage && cmp.coverage.ok === false) {
      diff++
      console.log('  ❌ ' + s.name + '  **覆盖不足**：' + cmp.coverage.reason
        + '（本次没有比到基准的完整范围，不能宣称一致）')
      continue
    }

    const probeSame = String(probeNow) === String(s.probe)
    if (!probeSame) probeDiffs.push({ name: s.name, before: s.probe, after: probeNow })
    if (cmp.same && probeSame) { same++; console.log('  ✅ ' + s.name + '  像素与状态都一致' + (cmp.scaled ? '（已归一尺寸）' : '')) }
    else if (cmp.sizeMismatch) { missing++; console.log('  ⚠️  ' + s.name + '  尺寸不一致且未归一') }
    else {
      diff++
      console.log('  ❌ ' + s.name + '  像素差异 ' + cmp.diff + '/' + cmp.total + '（' + (cmp.ratio * 100).toFixed(3) + '%）maxChannelDelta=' + cmp.maxChannelDelta + (probeSame ? '' : '；探针状态也变了'))
      console.log('     差异图: ' + nowFile.replace(/\.png$/, '') + ' 与基准 ' + baseFile)
    }
  }
  if (probeDiffs.length) {
    console.log('\n状态探针差异（比像素更早说明问题）：')
    for (const p of probeDiffs) { console.log('  · ' + p.name); console.log('      基准: ' + String(p.before).slice(0, 150)); console.log('      现在: ' + String(p.after).slice(0, 150)) }
  }
  console.log('\n视觉回归：' + same + ' 一致 / ' + diff + ' 有差异 / ' + missing + ' 尺寸不符'
    + (notReady ? ' / ' + notReady + ' 未就绪跳过' : ''))
  // 「未就绪」也**不算通过** —— 不能让"图没加载完"悄悄变成绿灯（审核方指出的缺陷）
  const okAll = diff === 0 && missing === 0 && probeDiffs.length === 0 && notReady === 0
  // ⚠️ 结论文案**必须写明容差**：容差 >0 时"一致"只在容差内成立，不能说成"完全一致"。
  // 有容差时它挡不住"整屏每通道偏色几级"（审核方复核证明整个保留区 +5 仍报 same=true），
  // 所以结论按容差分档措辞。
  const tolNote = PIXEL_TOLERANCE > 0
    ? '（在每通道 ±' + PIXEL_TOLERANCE + ' 级容差内一致；容差内的大面积低幅变化**不会被发现**）'
    : '（严格逐字节，无容差）'
  console.log(okAll
    ? '✓ 视觉一致' + tolNote
    : (notReady && diff === 0
      ? '✗ 有状态未就绪（图未加载完）—— 重跑一次通常就好；持续出现请查底图文件与网络'
      : '✗ 有差异 —— 逐张看 *.after.png'))
  // 不在这里 process.exit：finally 里的还原必须先跑完。
  // 退出码放到 finally 之后统一设置（原来在 try 里直接 exit 会让还原被跳过）。
  exitCode = okAll ? 0 : 1
  } finally {
    // 同 capture：还原与清理拆成嵌套 try/finally，**还原抛错也要清理**（审核方第七轮）。
    try {
      // **还原失败必须影响退出码**（审核方复核指出：原来返回值被忽略，
      // "比较全过 + 还原失败"会 exit=0，等于把"用户的轮播被我们关掉了"报成成功）。
      // 用独立退出码 5，与"有视觉差异(1)""未就绪(1)""页面通道挂(3)""拒绝录基准/钉图(4)"区分开。
      // **只有 'failed' 才算失败** —— 'restored'（含"用户原本就关着轮播"）与 'skipped'
      // 都不是失败（三态契约见 restoreRotation 头注释）。
      const outcome = await restoreRotation(autoBefore, true)
      if (outcome === 'failed') {
        console.error('  ✗ 轮播还原失败 —— 用户的 autoOn 可能仍是被改过的值。退出码按失败处理（5）。')
        if (exitCode === 0) exitCode = 5
      }
    } catch (e) {
      console.error('  ✗ 轮播还原过程抛错：' + String(e && e.message || e).slice(0, 90) + ' —— 按失败处理（5）')
      if (exitCode === 0) exitCode = 5
    } finally {
      const cleaned = await cleanupEnvironment(true)
      if (!cleaned && exitCode === 0) exitCode = 6
    }
  }
  } catch (e) {
    if (exitCode === 0) {
      exitCode = 1
      console.error('  ✗ 未预期异常：' + String(e && e.message || e).slice(0, 120))
    }
  }
  cdp.close()
  process.exit(exitCode)
}

cdp.close()
// ⚠️ 这里原来写死 `process.exit(0)` —— 而 capture 分支的 finally 会把 exitCode 置成 5
// （还原失败），于是出现"内部分支知道失败了(exitCode=5)、进程却仍退出 0"。
// 审核方模拟"录制成功 + 还原失败"复现了这个不一致。
// 统一用 exitCode（capture 成功时它本来就是 0，没有副作用）。
process.exit(exitCode)