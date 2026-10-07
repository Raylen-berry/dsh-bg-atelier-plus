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
if (!['capture', 'compare', 'list'].includes(mode) || (!dir && mode !== 'list')) {
  console.error('用法: node tools/visual-baseline.mjs capture|compare <目录名>')
  console.error('      node tools/visual-baseline.mjs list          # 列出已建基准')
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
async function cdpSession(port) {
  let list
  try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json() }
  catch { throw new Error('CDP 端口 ' + port + ' 没响应。先让 agent 跑 browser_open{use:"plugin"}；或用 VB_CDP_PORT 指到别的实例') }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('CDP 里没有 page target')
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
const baseDir = path.join(OUT_ROOT, dir)
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
  STABLE_KEEP_RATIO, STABLE_X_BY_STATE, compareStableFiles,
} from './oracle-compare.mjs'

// 本文件内部沿用旧名字，避免大改调用点
function compareStable(baseFile, nowFile, stateName) {
  return compareStableFiles(baseFile, nowFile, stateName)
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
  if (!before || typeof before !== 'object') {
    if (log) console.log('     轮播: 读不到设置，跳过冻结（不做任何写入）')
    return null
  }
  // **关键是钉住 wallpaper，不只是关轮播**：
  // 关轮播只保证"从现在起不再换"，但"现在这张"可能与录基准时那张不同（轮播在我们开始前
  // 已经换过了）—— 实测就这样连续踩了三次：洁西卡金蜜 → 重返未来1999 → 百夫长。
  // 所以冻结必须同时把 wallpaper 固定成**基准里记下的那一张**（由调用方传入期望值；
  // 首次 capture 时用当前这张，之后 compare 时读基准 manifest 里的值）。
  return { raw, before }
}

/** 把 wallpaper 钉到指定那张（只改 wallpaper，其余整份保留）。 */
async function pinWallpaper(wallpaper, log) {
  const nowRaw = await readState(`(async()=>{const r=await fetch('/bga/settings.json',{cache:'no-store'});return await r.text()})()`)
  let now = null
  try { now = JSON.parse(nowRaw) } catch { now = null }
  if (!now || typeof now !== 'object') { if (log) console.log('     钉图: 读不到设置，跳过'); return }
  const patched = JSON.stringify({ ...now, autoOn: false, wallpaper })
  const r = await readState(`(async()=>{
    const res = await fetch('/bga/settings.json', {
      method:'PUT', headers:{'content-type':'application/json'},
      body: ${JSON.stringify(patched)},
    });
    return res.ok ? 'pinned(' + ${JSON.stringify(wallpaper && wallpaper.name)} + ') + autoOn=false' : 'PUT failed ' + res.status;
  })()`)
  if (log) console.log('     钉图: ' + r)
  // **写完必须刷新页面**：设置是 host 侧文件，而客户端只在启动时 STORE.load() 一次
  // （见 client.js 末尾）。只写不刷新的话，磁盘上是新值、画面还是旧图 ——
  // 实测踩到：manifest 记的是"玛尔莎"、基准图里却是"牙仙1"，一路 93% 假回归。
  await sleep(400)
  try { await cdp.send('Page.reload', { ignoreCache: false }) } catch { /* 用 navigate 兜底 */ }
  await sleep(3500) // 等重载 + 底图解码
  if (log) console.log('     钉图后已刷新页面')
}

/** 还原轮播设置：把捕获前读到的**整份** JSON 原样写回。 */
async function restoreRotation(before, log) {
  if (!before) { if (log) console.log('     轮播: 没有可还原的原值'); return }
  let want = null
  try { want = JSON.parse(before) } catch { /* 原值坏了就不写 */ }
  if (!want || typeof want !== 'object') { if (log) console.log('     轮播: 原值不可解析，不写回'); return }
  if (want.autoOn !== true) { if (log) console.log('     轮播: 原本就是关的，无需还原'); return }
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

  // 刷新让客户端内存同步；随后回读确认磁盘也仍是 true（防止刷新过程中又被写回 false）
  await sleep(300)
  try { await cdp.send('Page.reload', { ignoreCache: false }) } catch { /* 用 navigate 兜底 */ }
  await sleep(3500)
  const verifyRaw = await readState(`(async()=>{const x=await fetch('/bga/settings.json',{cache:'no-store'});return await x.text()})()`).catch(() => null)
  let v = null
  try { v = JSON.parse(verifyRaw) } catch { v = null }
  const restored = !!(v && v.autoOn === true)
  if (log) console.log('     轮播还原·回读: autoOn=' + (v ? v.autoOn : '读不到') + (restored ? ' ✅' : ' ❌ 仍未还原'))
  if (!restored) {
    // 不静默放过：还原失败意味着"用户的轮播被我们关掉了"，必须让人看见
    console.error('     ⚠️ 轮播未能还原（autoOn 仍不是 true）—— 请手动检查 ' +
      '$DSH_HOME/dsh-bg-atelier-plus/settings.json 的 autoOn，或重新跑一次本脚本')
  }
  return restored
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

async function prepareState(s, log) {
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
  const ready = await waitImagesReady(log)
  return { imagesReady: ready }
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
async function waitImagesReady(log, waitMs = 30000) {
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
      // 关键图就绪 + 没有坏图，才叫"这一帧可以截"。
      const criticalReady = v.bg === 'ready' && (v.heroState === 'ready' || v.heroState === 'absent')
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
  try {
    // 冻结轮播 + 钉住当前这张图（结束后还原；异常也要还原，所以放 try/finally）
    const frozen = await freezeRotation(true)
    autoBefore = frozen ? frozen.raw : null
    // 录制时以"页面当下正在显示的那张"为准，钉住它，并把 wallpaper 记进 manifest ——
    // 之后 compare 就按这个值钉回去，与轮播是否跑过无关。
    const wallpaperNow = frozen && frozen.before ? frozen.before.wallpaper : null
    if (wallpaperNow) await pinWallpaper(wallpaperNow, true)
    await resetToCleanHome(true)  // 上一轮 run 可能留下开着面板
    const manifest = {
      dir, capturedAt: new Date().toISOString(), url: cdp.url,
      // 记下"比的是哪一块"：裁剪比例不藏在代码里，改比对口径必须重录基准
    comparison: { stableKeepRatio: STABLE_KEEP_RATIO, stableXByState: STABLE_X_BY_STATE, note: '每状态只比它自己那块（视口上方 ' + (STABLE_KEEP_RATIO * 100) + '% 且按状态竖切）；底部实时计数、装饰粒子、会话正文都不参与' },
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
      process.exitCode = 4
      throw new Error('图片未就绪：' + s.name)
    }
    const probeValue = await readState(s.probe)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(baseDir, s.name + '.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    manifest.states.push({ name: s.name, note: s.note, probe: probeValue, file: path.basename(file), bytes: fs.statSync(file).size })
    console.log('  ✅ ' + s.name + '  ' + fs.statSync(file).size + ' 字节')
    console.log('     探针: ' + String(probeValue).slice(0, 160))
  }
  fs.writeFileSync(path.join(baseDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log('\n基准已建立：' + manifest.states.length + ' 个状态 → ' + baseDir)
  console.log('重构后跑： node tools/visual-baseline.mjs compare ' + dir)
  } finally {
    await restoreRotation(autoBefore, true)
  }
} else {
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
  try {
    const frozen = await freezeRotation(true)
    autoBefore = frozen ? frozen.raw : null
    if (manifest.pinnedWallpaper) await pinWallpaper(manifest.pinnedWallpaper, true)
    else console.log('   ⚠️ 基准里没有 pinnedWallpaper（旧基准？）—— 只能冻结轮播，可能被换图干扰')
    // **必须**在开始逐个状态之前先复位。03 状态会主动打开设置面板且不会自己关，
    // 而 DSH 还会把"面板开着"这个状态跨刷新保留 —— 于是下一次 run 的 01 状态直接拍到
    // 面板开着的样子，与"干净首页"的基准差 93%。看起来像严重回归，其实只是状态没复位。
    await resetToCleanHome(true)
  for (const s of manifest.states) {
    const baseFile = path.join(baseDir, s.file)
    const state = STATES.find((x) => x.name === s.name)
    let prep = null
    if (state) prep = await prepareState(state, false)
    else await sleep(2000)
    // 图片没就绪 ⇒ **本次比对不算数**，记为"就绪失败"而不是"有回归"。
    // 两者必须分开：混在一起会把"图没加载完"误报成视觉回归（审核方指出的缺陷）。
    if (prep && prep.imagesReady === false) {
      notReady++
      console.log('  ⚠️  ' + s.name + '  图片未就绪，本次跳过（不算回归，也不算通过）')
      continue
    }
    const probeNow = await readState(state ? state.probe : 'null')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const nowFile = path.join(baseDir, s.name + '.after.png')
    fs.writeFileSync(nowFile, Buffer.from(shot.data, 'base64'))
    // 裁稳定区 →（尺寸不同时）跨 DPI 归一 → 逐像素比。
    // 注意：裁的是**解码后**的像素，不是文件；encodePng 只用于写差异图。
    const cmp = compareStable(baseFile, nowFile, s.name)

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
  console.log(okAll
    ? '✓ 视觉无回归'
    : (notReady && diff === 0
      ? '✗ 有状态未就绪（图未加载完）—— 重跑一次通常就好；持续出现请查底图文件与网络'
      : '✗ 有差异 —— 逐张看 *.after.png'))
  // 不在这里 process.exit：finally 里的还原必须先跑完。
  // 退出码放到 finally 之后统一设置（原来在 try 里直接 exit 会让还原被跳过）。
  exitCode = okAll ? 0 : 1
  } finally {
    await restoreRotation(autoBefore, true)
  }
  cdp.close()
  process.exit(exitCode)
}

cdp.close()
process.exit(0)