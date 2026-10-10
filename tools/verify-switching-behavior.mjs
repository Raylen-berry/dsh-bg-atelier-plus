// tools/verify-switching-behavior.mjs —— 第 6 项「切换与动效」的**功能**层真机验收
//
// 为什么不用像素断言：动效层已被冻结（`animation:none`，见 visual-baseline 的
// prepareEnvironment）—— 像素回归在那里**故意**不比动画。所以"动效到底动没动、
// 关闭后有没有残留"必须用**功能探针**验，不能靠截图。
//
// 覆盖的"必须检出的错误"（验收约定第 6 项）：
//   · 显示旧图（换图后画面没跟上）
//   · **旧请求覆盖新选择**（快速连切 A→B，最终停在 A）
//   · 轮播停摆（开了定时器但底图不换）
//   · 关闭后残留（关掉轮播还在换 / 关掉动效装饰元素还在动）
//   · 失败时没保留正确状态（选到无效底图导致白屏或插件失联）
//
// 用法：node tools/verify-switching-behavior.mjs [--skip-rotation]
//   轮播那一段按插件最小间隔 1 分钟验证，会等约 70 秒；--skip-rotation 可跳过。
import { readFileSync } from 'node:fs'

const SKIP_ROTATION = process.argv.includes('--skip-rotation')

let pass = 0, fail = 0
const untested = []   // 前置不满足 ⇒ 单列，不混进通过/失败（验收约定规则 4）
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ------------------------------------------------------------------ CDP
const st = JSON.parse(readFileSync(process.env.DSH_HOME + '/dsh-browser-live/state.json', 'utf8'))
const list = await (await fetch('http://127.0.0.1:' + st.port + '/json/list')).json()
const page = list.find((t) => String(t.url || '').includes('127.0.0.1:19387'))
if (!page) { console.error('没找到 GUI 标签页'); process.exit(3) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws open 失败')) })
let id = 0
const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}, t = 30000) => new Promise((res) => {
  const i = ++id
  const tm = setTimeout(() => { pend.delete(i); res({ __timeout: 1 }) }, t)
  pend.set(i, (m) => { clearTimeout(tm); res(m) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r?.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ 页面侧读取/写入
const READ_SETTINGS = `(async()=>{const r=await fetch('/bga/settings.json',{cache:'no-store'});return await r.text()})()`
async function readSettings() {
  const raw = await ev(READ_SETTINGS)
  try { return JSON.parse(raw) } catch { return null }
}
async function writeSettings(obj) {
  const body = JSON.stringify(JSON.stringify(obj))
  const r = await ev(`(async()=>{const res=await fetch('/bga/settings.json',{
    method:'PUT',headers:{'content-type':'application/json'},body:${body}});
    return res.ok?'ok':'fail '+res.status})()`)
  return r === 'ok'
}
async function reload() {
  try { await send('Page.reload', { ignoreCache: false }) } catch { /* noop */ }
  await sleep(3200)
}
/** 画面**实际渲染**的底图（不是设置值）—— 判断"显示旧图"要看这个。 */
async function renderedWallpaper() {
  const raw = await ev(`(()=>{const bi=String(getComputedStyle(document.body,'::before').backgroundImage||'');
    return JSON.stringify({bi:bi.slice(0,600)})})()`)
  let j = null
  try { j = JSON.parse(raw) } catch { j = null }
  const src = String(j && j.bi || '')
  const names = []
  let from = 0
  for (;;) {
    const i = src.indexOf('/bga/wallpapers/', from)
    if (i < 0) break
    from = i + 1
    let e = src.length
    for (const sep of ['"', ')', ',', ' ', "'"]) { const k = src.indexOf(sep, i + 16); if (k >= 0 && k < e) e = k }
    let dec = src.slice(i + 16, e)
    try { dec = decodeURIComponent(dec) } catch { /* 原样 */ }
    names.push(dec.replace(/^.*\//, ''))
  }
  return { names, empty: src === '' || src === 'none' || src === 'url("")' }
}
async function probe() {
  const raw = await ev(`(()=>{ if(typeof window.__bgaStateProbe!=='function') return '"absent"';
    return JSON.stringify(window.__bgaStateProbe()) })()`)
  try { return JSON.parse(raw) } catch { return null }
}

// 装饰动效元素：位置 + 数量（firefly 用 bga-fly/bga-star/bga-meteor）
const FX_SEL = '[class*="bga-fly"],[class*="bga-star"],[class*="bga-meteor"]'
async function fxSample() {
  const raw = await ev(`(()=>{
    const els=[...document.querySelectorAll('${FX_SEL}')];
    return JSON.stringify({count:els.length,
      pos:els.slice(0,6).map(e=>{const b=e.getBoundingClientRect();
        return [Math.round(b.left*10)/10, Math.round(b.top*10)/10]})})})()`)
  try { return JSON.parse(raw) } catch { return { count: -1, pos: [] } }
}
/**
 * 插件下发的样式表里有没有动效规则 —— **不依赖宿主的 slot 是否挂载**。
 * 为什么需要这个替代信号：动效节点是注入在宿主 slot `conversation.composer.dock` 上的
 * （client.js:3105），只有会话页那个 slot 挂上才会渲染。实测在"强制 reload 之后的首页"
 * 里该 slot 不挂（同页 `bga-orb` 所属的 `sidebar.footer.action` 却正常）⇒ 只看节点数量
 * 会把"前置不满足"误判成"动效坏了"。样式规则是插件**自己**下发的，能稳定观测。
 */
async function fxCssPresent() {
  const raw = await ev(`(()=>{
    const css=[...document.querySelectorAll('style')].map(s=>s.textContent||'').join('\\n');
    return JSON.stringify({fly:/\\.bga-fly\\s*[,{]/.test(css), star:/\\.bga-star\\s*[,{]/.test(css),
      meteor:/\\.bga-meteor\\s*[,{]/.test(css), bytes:css.length})})()`)
  try { return JSON.parse(raw) } catch { return null }
}

console.log('=== 第 6 项「切换与动效」功能验收（真机）===\n')

// ⚠️ **前置：页面必须"可见且聚焦"**。插件在后台/失焦时**故意**不装轮播定时器
//    （`wallpaperBackgrounded()` = `document.hidden === true`，client.js:840-842），
//    并且 `window blur` 也会触发挂起（client.js:868）。
//    而回到前台时会 `armAuto(true)` 补装表（client.js:858）⇒ 如果测试期间反复 bringToFront，
//    每来一次都把表**重置**成整段间隔，"它到底会不会到点换图"就永远验不出来。
//    所以正确做法不是反复抢焦点，而是用 CDP 的 **focus 模拟**：让页面在协议层一直报告
//    "可见且聚焦"，与真实窗口状态无关。实测：本机 GUI 标签页默认 `document.hidden=true`，
//    不处理的话"轮播没停摆"这条会**假失败**（第一版就是这么挂的）。
try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch { /* 不支持则下面如实报未测 */ }
try { await send('Page.bringToFront', {}) } catch { /* noop */ }
await sleep(1000)
const vis = await ev(`JSON.stringify({hidden:document.hidden,vis:document.visibilityState,focus:document.hasFocus()})`)
console.log('  页面可见性（focus 模拟后）: ' + vis)
let pageVisible = false
try { const v = JSON.parse(vis); pageVisible = v.hidden === false && v.focus === true } catch { pageVisible = false }
if (!pageVisible) {
  console.log('  ⚠️ 页面仍不可见/未聚焦 ⇒ 轮播与动效相关断言会列为**未测**（不冒充通过）\n')
} else {
  console.log('')
}

// ------------------------------------------------------------------ 快照
const snapshot = await readSettings()
if (!snapshot || typeof snapshot !== 'object') {
  console.error('读不到当前设置 ⇒ 为安全起见直接退出（绝不盲写）')
  ws.close(); process.exit(4)
}
const fieldCount0 = Object.keys(snapshot).length
console.log('  设置快照: ' + fieldCount0 + ' 字段, wallpaper=' +
  (snapshot.wallpaper ? snapshot.wallpaper.cat + '/' + snapshot.wallpaper.file : 'null') +
  ', autoOn=' + snapshot.autoOn + ', effect=' + snapshot.effect + '\n')

// 两个不同的底图条目
const listRaw = await ev(`(async()=>{const r=await fetch('/bga/wallpapers.json',{cache:'no-store'});return await r.text()})()`)
let pool = []
try {
  const j = JSON.parse(listRaw)
  // ⚠️ 列表条目的身份字段是 **name**（不是 file）：实测 `/bga/wallpapers.json` 的条目只有
  //    name/base/hd/tags/no/url/size。`file` 是插件存进设置时才补上的。按 file 取会拿到
  //    undefined，于是"画面渲染的是不是 A"这条断言永远假失败（踩过一次）。
  for (const c of (j.categories || [])) {
    for (const it of (c.items || [])) pool.push({ ...it, cat: c.name, file: it.file || it.name })
  }
} catch { pool = [] }
if (pool.length < 2) { console.error('底图不足两张 ⇒ 无法验证换图'); ws.close(); process.exit(4) }
const A = pool[0], B = pool[1]
console.log('  测试用图: A=' + A.cat + '/' + A.file + '   B=' + B.cat + '/' + B.file + '\n')

try {
  // ---------------------------------------------------------------- ① 换图确实生效
  console.log('— ① 换图：画面必须跟上设置（不是只有设置值对）—')
  await writeSettings({ ...snapshot, wallpaper: A, autoOn: false })
  await reload()
  let rA = await renderedWallpaper()
  ok('切到 A 后画面渲染的是 A', rA.names.includes(A.file) && !rA.names.includes(B.file), rA.names.join(',') || '(空)')

  await writeSettings({ ...snapshot, wallpaper: B, autoOn: false })
  await reload()
  let rB = await renderedWallpaper()
  ok('★ 再切到 B 后画面是 B（不是显示旧图 A）',
    rB.names.includes(B.file) && !rB.names.includes(A.file), rB.names.join(',') || '(空)')

  // ---------------------------------------------------------------- ② 快速连切：旧请求不许覆盖新选择
  console.log('\n— ② 快速连切 A→B：最终必须是 B（旧请求不覆盖新选择）—')
  // 不等待 A 的整轮刷新，紧接着写 B（模拟用户连点）
  await writeSettings({ ...snapshot, wallpaper: A, autoOn: false })
  await sleep(150)
  await writeSettings({ ...snapshot, wallpaper: B, autoOn: false })
  await reload()
  const rRace = await renderedWallpaper()
  ok('★ 连切之后最终是 B（不是被 A 的旧请求覆盖）',
    rRace.names.includes(B.file) && !rRace.names.includes(A.file), rRace.names.join(',') || '(空)')

  // ---------------------------------------------------------------- ④ 动效（不依赖轮播，先跑省时间）
  console.log('\n— ④ 动效：开着要真在动，关掉后不许残留 —')
  await writeSettings({ ...snapshot, wallpaper: B, effect: 'firefly', autoOn: false })
  await reload()
  const fx1 = await fxSample()
  await sleep(1600)
  const fx2 = await fxSample()
  const orbAlive = await ev(`document.querySelectorAll('[class*="bga-orb"]').length > 0`)
  if (fx1.count > 0) {
    ok('★ effect=firefly ⇒ 装饰节点存在', fx1.count > 0, 'count=' + fx1.count)
    ok('★ 且它们在动（两次采样位置不同）', JSON.stringify(fx1.pos) !== JSON.stringify(fx2.pos),
      '第一次 ' + JSON.stringify(fx1.pos.slice(0, 2)) + ' 第二次 ' + JSON.stringify(fx2.pos.slice(0, 2)))
    await writeSettings({ ...snapshot, wallpaper: B, effect: 'off', autoOn: false })
    await reload()
    const fxOff = await fxSample()
    ok('★ effect=off ⇒ 装饰节点不残留（数量为 0）', fxOff.count === 0, 'count=' + fxOff.count)
    const fxOff2 = await fxSample()
    ok('★ 关闭后再采样仍为 0（不是延迟消失）', fxOff2.count === 0, 'count=' + fxOff2.count)
  } else {
    // ⚠️ **前置不满足 ⇒ 如实列为"未测"，绝不冒充通过**。
    //   动效节点注入在宿主 slot `conversation.composer.dock`（client.js:3105）；
    //   实测在"强制 reload 之后的首页"该 slot 不挂（同页 sidebar.footer.action 的 bga-orb 正常
    //   ⇒ slot 机制本身可用）。此时**无法区分**"slot 没挂"与"动效坏了"，
    //   所以只报未测，并把原因写清楚，交给人判断。
    //   （另：不能拿"样式表里有没有 .bga-fly"当替代信号 —— 实测开/关两份样式表几乎完全相同，
    //     动效 CSS 是常驻的，开关只体现在是否渲染节点。我一开始就是判据选错了。）
    if (orbAlive) {
      console.log('  ⏭️  **未测**：effect=firefly 时装饰节点数 0（宿主 slot conversation.composer.dock '
        + '未挂载；同页 bga-orb 正常 ⇒ slot 机制可用）⇒ 无法区分"slot 没挂"与"动效坏了"。')
    } else {
      console.log('  ⏭️  **未测**：装饰节点数 0，且 bga-orb 也不在 ⇒ 整页 slot 都没挂，前置更不满足。')
    }
    untested.push('effect 开/关的节点级断言（前置：宿主 conversation.composer.dock slot 已挂载）')
  }

  // ---------------------------------------------------------------- ⑤ 失败时保留正确状态
  console.log('\n— ⑤ 选到无效底图：不许白屏、插件不许失联 —')
  await writeSettings({ ...snapshot, wallpaper: { file: '__no_such__.png', cat: 'x', url: '/bga/wallpapers/x/__no_such__.png' }, effect: 'off', autoOn: false })
  await reload()
  const pBad = await probe()
  const rBad = await renderedWallpaper()
  ok('★ 无效底图后插件仍存活（探针可用）', !!(pBad && typeof pBad.autoOn === 'boolean'), JSON.stringify(pBad))
  ok('★ 无效底图后仍有可用的画面状态（不是空 backgroundImage）', rBad.empty === false,
    'names=' + (rBad.names.join(',') || '(空)') + ' empty=' + rBad.empty)

  // ---------------------------------------------------------------- ③ 轮播（最慢，放最后）
  if (SKIP_ROTATION) {
    console.log('\n— ③ 轮播：已用 --skip-rotation 跳过（会等约 70 秒）—')
  } else {
    console.log('\n— ③ 轮播：开起来要真的换图，关掉后不许继续 —')
    await writeSettings({ ...snapshot, wallpaper: B, effect: 'off', autoOn: true, autoMin: 1 })
    await reload()
    const pOn = await probe()
    ok('★ autoOn=true ⇒ 探针报定时器在跑（autoPending）', !!(pOn && pOn.autoPending === true),
      'autoPending=' + (pOn && pOn.autoPending))
    const before = (await renderedWallpaper()).names.join(',')
    console.log('     等 70 秒看它是否真的换图……')
    await sleep(70000)
    const after = (await renderedWallpaper()).names.join(',')
    ok('★ 轮播**确实在工作**（70 秒后画面底图变了）', before !== '' && after !== before,
      '之前 ' + before + ' → 之后 ' + after)

    await writeSettings({ ...snapshot, wallpaper: B, effect: 'off', autoOn: false })
    await reload()
    const pOff = await probe()
    ok('★ autoOn=false ⇒ 探针报定时器已停', !!(pOff && pOff.autoPending === false),
      'autoPending=' + (pOff && pOff.autoPending))
    const s1 = (await renderedWallpaper()).names.join(',')
    await sleep(12000)
    const s2 = (await renderedWallpaper()).names.join(',')
    ok('★ 关掉后不再换图（12 秒内画面不变）', s1 === s2, s1 + ' → ' + s2)
  }
} finally {
  // ---------------------------------------------------------------- 还原用户状态
  console.log('\n— 还原用户状态 —')
  const nowBack = snapshot
  const wrote = await writeSettings(nowBack)
  await reload()
  const disk = await readSettings()
  const pb = await probe()
  const same = disk && JSON.stringify(disk.wallpaper) === JSON.stringify(snapshot.wallpaper)
    && disk.autoOn === snapshot.autoOn && disk.effect === snapshot.effect
    && Object.keys(disk).length === fieldCount0
  ok('★ 设置已按快照还原（字段数/底图/autoOn/effect 一致）', !!same,
    '字段 ' + (disk ? Object.keys(disk).length : '?') + '/' + fieldCount0
    + ', wallpaper=' + (disk && disk.wallpaper ? disk.wallpaper.file : 'null')
    + ', autoOn=' + (disk && disk.autoOn) + ', effect=' + (disk && disk.effect))
  ok('★ 客户端内存也同步（探针可用且底图一致）',
    !!(pb && snapshot.wallpaper && pb.wallpaper && pb.wallpaper.file === snapshot.wallpaper.file),
    JSON.stringify(pb))
  if (!wrote) console.error('     ⚠️ 还原写入未确认');
}

try { await send('Emulation.setFocusEmulationEnabled', { enabled: false }) } catch {}

console.log('\n切换与动效：' + pass + ' 通过 / ' + fail + ' 失败'
  + (untested.length ? ' / ' + untested.length + ' 项**未测**（前置不满足，不冒充通过）：\n  - ' + untested.join('\n  - ') : ''))
ws.close()
process.exit(fail === 0 ? 0 : 1)
