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
import { decodePng, encodePng, comparePngEither } from '../../dsh-browser-live/pixdiff.js'

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
    settleMs: 2500,
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
const port = Number(process.env.VB_CDP_PORT || 9799)

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

/** 读页面当前状态（探针表达式）。 */
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
 * 裁到稳定区：去掉底部那条随实时计数与装饰粒子变动的带子。
 *
 * 比例是**量出来的**，不是拍的：实测两次捕获（零代码改动）的差异最早出现在
 * y=740（视口 905 高 ⇒ 0.817）。取 0.80 留余量 —— 保留上面的 80%。
 *
 * 为什么接受这个裁剪而不是继续追：
 *   · 被裁掉的带子里是宿主状态栏的实时计数（"8 轮 399 步 · 70 tok/s"）与底图插件的
 *     装饰粒子 bga-ptl（位置随机漂移）—— 对它们做像素回归本来就没意义；
 *   · 稳定区仍包含真正的视觉契约：整幅底图、主题染色、设置面板的头部/预览/按钮/滑杆。
 *   · 要保护被裁掉的部分（例如面板底部的图库网格），应该**另加一个专门的状态**，
 *     而不是放宽容差 —— 放容差会把真回归一起放过去。
 * 比例写进 manifest；改比例等于改口径，必须重录基准。
 */
export const STABLE_KEEP_RATIO = Number(process.env.VB_STABLE_RATIO || 0.80)

function cropStable(img) {
  const keep = Math.max(1, Math.floor(img.height * STABLE_KEEP_RATIO))
  if (keep >= img.height) return img
  return { width: img.width, height: keep, channels: 4, data: img.data.subarray(0, img.width * keep * 4) }
}

/** 读 PNG → 裁稳定区。比对一律走这里，避免有的地方漏裁。 */
function stableFrom(file) {
  return cropStable(decodePng(fs.readFileSync(file)))
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
  await sleep(1300)
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
  const r = await readState(`(async()=>{
    const res = await fetch('/bga/settings.json', {
      method:'PUT', headers:{'content-type':'application/json'},
      body: ${JSON.stringify(JSON.stringify(merged))},
    });
    return res.ok ? 'autoOn=true 已还原（字段 ' + ${Object.keys(merged).length} + ' 个）' : 'PUT failed ' + res.status;
  })()`)
  if (log) console.log('     轮播已还原: ' + r)
}

async function prepareState(s, log) {
  // 先把页面复位到"干净"：关掉任何已打开的设置对话框。
  // 为什么必须做：上一次状态可能开着面板，不复位的话后面的状态会**继承**它 ——
  // 实测踩到过：三个状态全都带着同一个面板，基准之间只差 0.05%，等于没区分开。
  // 关掉 dsh-browser-live 的观察窗：它**实时镜像当前页面**（截出来的图里能看到 FPS 计数与
  // 递归的自己），每帧都在变 ⇒ 天然不可复现。实测：不关它，零改动两次捕获差 0.231%；
  // 关掉后归零（见 CHANGELOG / 本文件下方 REPRODUCIBILITY 段）。
  // 这是**环境准备**不是作弊：观察窗是另一个插件的调试 UI，不属于底图插件的视觉契约。
  await closeObserver(log)

  if (s.reset !== false) {
    const closed = await readState(`(()=>{const d=document.querySelector('[role="dialog"]');
      if(!d) return 'already-clean';
      const btn=[...d.querySelectorAll('button')].find(b=>String(b.getAttribute('aria-label')||b.textContent||'').trim()==='关闭');
      if(btn){btn.click();return 'closed'} return 'no-close-button'})()`)
    if (log) console.log('     复位: ' + closed)
    await sleep(900)
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
}
if (mode === 'capture') {
  // 冻结轮播 + 钉住当前这张图（结束后还原；异常也要还原，所以放 try/finally）
  const frozen = await freezeRotation(true)
  const autoBefore = frozen ? frozen.raw : null
  // 录制时以"页面当下正在显示的那张"为准，钉住它，并把 wallpaper 记进 manifest ——
  // 之后 compare 就按这个值钉回去，与轮播是否跑过无关。
  const wallpaperNow = frozen && frozen.before ? frozen.before.wallpaper : null
  if (wallpaperNow) await pinWallpaper(wallpaperNow, true)
  try {
  const manifest = {
    dir, capturedAt: new Date().toISOString(), url: cdp.url,
    // 记下"比的是哪一块"：裁剪比例不藏在代码里，改比对口径必须重录基准
    comparison: { stableKeepRatio: STABLE_KEEP_RATIO, note: '只比视口上方 ' + (STABLE_KEEP_RATIO * 100) + '%（底部实时计数与装饰粒子天然不可复现）' },
    // 钉住的底图（compare 时按它钉回去，保证比的是同一张）
    pinnedWallpaper: wallpaperNow,
    rotationFrozenFrom: autoBefore,
    states: [],
  }
  for (const s of STATES) {
    await prepareState(s, true)
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
  const frozen = await freezeRotation(true)
  const autoBefore = frozen ? frozen.raw : null
  if (manifest.pinnedWallpaper) await pinWallpaper(manifest.pinnedWallpaper, true)
  else console.log('   ⚠️ 基准里没有 pinnedWallpaper（旧基准？）—— 只能冻结轮播，可能被换图干扰')
  let same = 0, diff = 0, missing = 0
  const probeDiffs = []
  try {
  for (const s of manifest.states) {
    const baseFile = path.join(baseDir, s.file)
    const state = STATES.find((x) => x.name === s.name)
    if (state) await prepareState(state, false)
    else await sleep(2000)
    const probeNow = await readState(state ? state.probe : 'null')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const nowFile = path.join(baseDir, s.name + '.after.png')
    fs.writeFileSync(nowFile, Buffer.from(shot.data, 'base64'))
    // 裁稳定区 →（尺寸不同时）跨 DPI 归一 → 逐像素比。
    // 注意：裁的是**解码后**的像素，不是文件；encodePng 只用于写差异图。
    const cmp = comparePngEither(
      encodePng(stableFrom(baseFile)), encodePng(stableFrom(nowFile)),
      { allowScale: true, tolerance: 0, maxDiffRatio: 0 })
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
  console.log('\n视觉回归：' + same + ' 一致 / ' + diff + ' 有差异 / ' + missing + ' 尺寸不符')
  const okAll = diff === 0 && missing === 0 && probeDiffs.length === 0
  console.log(okAll ? '✓ 视觉无回归' : '✗ 有差异 —— 逐张看 *.after.png')
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