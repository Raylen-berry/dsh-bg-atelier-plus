// 底图工坊 · 自动切换 + 渐变过渡检查（离线，不进 npm 包）
//
// 为什么需要它：这两条都是"坏了也看不出来坏在哪"的逻辑，而且各自有一条会当场出事的坑：
//   ① 自动切换靠定时器。间隔是坏值（NaN / 0 / 越界）时 `setTimeout(fn, NaN)` 会退化成 0ms
//      —— 一秒换几千张图、顺手刷爆 settings.json；而"每次 STORE 变化都重起定时器"会让间隔
//      永远走不满（滑块调整不该清零，真正换图才清零）。
//   ② 渐变过渡会建一个 <style> 层（body::after 画上一张）。建了不拆 = 一张旧图永久盖在新图上。
// 所以这里用一个"记录型"假 document / 假定时器：不跑真样式计算，只盯住建了什么、拆没拆、
// 定时器起了几个，以及渐变时下层 URL 是否被冻结。真浏览器检查另见 verify-fade-browser.mjs。
//
// 用法：node tools/verify-auto-fade.mjs      退出码 0 = 通过，1 = 有不符
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ---- 假 document：head + 可记录可摘除的 <style> ----
const head = { children: [] }
head.appendChild = (el) => { el.parentNode = head; head.children.push(el) }
head.removeChild = (el) => {
  const i = head.children.indexOf(el)
  if (i >= 0) head.children.splice(i, 1)
  el.parentNode = null
}
const element = (tag) => ({
  tag, attributes: {}, children: [], parentNode: null, textContent: '',
  setAttribute(k, v) { this.attributes[k] = v },
  appendChild(c) { c.parentNode = this; this.children.push(c) },
})
const fadeLayers = () => head.children.filter((e) => e.attributes['data-bg-atelier-fade'] === '1')

// ---- 假定时器 / 假 rAF：只记录，不真跑 ----
const timers = new Map()
let setCalls = 0, clearCalls = 0, seq = 1
const rafQueue = []
let loaded
const sandbox = {
  window: { __ModuleLoader__: { load(m) { loaded = m } } },
  console,
  document: { head, createElement: element, addEventListener() {}, removeEventListener() {} },
  setTimeout(fn, ms) { setCalls++; const id = seq++; timers.set(id, { fn, ms }); return id },
  clearTimeout(id) { clearCalls++; timers.delete(id) },
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length },
  // 清单拉取失败这条路（cycleWallpaper 在池子为空时会走它）—— 这里让它正常失败，别抛未处理拒绝
  fetch: () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }),
}
vm.runInNewContext(src, sandbox)
const hCalls = []                                            // Slider 渲染出的 props（见 ⑦）
const React = { createElement: (t, p, ...kids) => { hCalls.push({ t, p, kids }); return null }, memo: (f) => f }   // 模块期只用这两个
const api = loaded.factory(() => React).internals

const S = api.STORE.state
const MIN = 60000, MAX = 7200000

// ---- ① 间隔读秒：不是数字的坏值兜 30 分钟，其余一律吸附到 AUTO_STOPS 里的档位 ----
// 2.5 / 6 正好卡在两档中间 ⇒ 取小的那个（结果确定，不来回跳），所以是 2 和 5。
for (const [input, want] of [[NaN, 1800000], [undefined, 1800000], [Infinity, 1800000], ['abc', 1800000],
  [0, MIN], [-5, MIN], [0.4, MIN], [1, MIN], [2.5, 120000], [6, 300000], [8, 420000], [13, 900000],
  [30, 1800000], ['60', 3600000], [60, 3600000], [89, 5400000], [90, 5400000], [47, 2700000],
  [120, MAX], [121, MAX], [999, MAX]]) {
  S.autoMin = input
  assert.equal(api.autoDelayMs(), want, 'autoMin=' + String(input) + ' 应读成 ' + want + 'ms')
}
console.log('PASS ① 间隔读秒：NaN/undefined/Infinity/字符串/越界/小数 —— 坏值兜 30 分钟，其余吸附到档位表')

// ---- ② 开关与 signature：关着不起表；开着起一根；没变化不许重起 ----
S.autoMin = 30
S.autoOn = false
api.armAuto(true)
assert.equal(api.autoPending(), false, 'autoOn=false 时不该有定时器')
assert.equal(setCalls, 0)

S.autoOn = true
api.armAuto(true)
assert.equal(api.autoPending(), true)
assert.equal(setCalls, 1)
assert.equal([...timers.values()].at(-1).ms, 1800000)

// 手动换图 = watch 里再调一次 armAuto()：开关与间隔都没变 ⇒ 计时不许清零
{
  const s0 = setCalls, c0 = clearCalls
  api.armAuto()
  assert.equal(setCalls, s0, 'signature 没变却重起了定时器 ⇒ 间隔永远走不满')
  assert.equal(clearCalls, c0, 'signature 没变却清了旧定时器')
}

// 改间隔 ⇒ 必须重起（新的这一根按新间隔）
S.autoMin = 5
api.armAuto()
assert.equal(setCalls, 2)
assert.equal(clearCalls, 1)
assert.equal([...timers.values()].at(-1).ms, 300000)

// 关掉 ⇒ 拆表、不再起
S.autoOn = false
api.armAuto()
assert.equal(api.autoPending(), false)
assert.equal(setCalls, 2)

// **换图要重置自动切换**（v1.11.0，用户报的"我换到满意的又给我闪走"）：间隔从这一次换图算起。
// 这条逻辑原来埋在 watch 的订阅里，离线跑不到 ⇒ 抽成 switchFade 才测得到。
for (const [prev, url] of [['/a.png', '/b.png'], ['', '/b.png'], ['/a.png', '']]) {
  S.autoOn = true
  S.autoMin = 5
  api.armAuto(true)
  api.fadeStop()                                   // 清掉上一轮可能留下的过渡定时器
  api.switchFade(prev, url)                        // '' 的那两头照样重起表（WE 接管/退出也是一次换图）
  const live = [...timers.values()].filter((t) => t.ms === 300000)
  assert.equal(live.length, 1, '换图后自动切换的表只该有一根（' + prev + ' → ' + url + '，多了就是旧表没清）')
  assert.equal([...timers.values()].at(-1).ms, 300000, '最后起的必须是自动切换那一根（' + prev + ' → ' + url + '）')
}
// 图 → 图 才建过渡层；两头为空（首次加载 / 清空 / WE 接管）不建
S.fadeOn = true
api.fadeStop()
api.switchFade('', '/a.png')
api.switchFade('/a.png', '/b.png')
assert.equal(fadeLayers().length, 1, '图 → 图 要过渡')
api.fadeStop()
api.switchFade('', '/b.png')
api.switchFade('/a.png', '')
assert.equal(fadeLayers().length, 0, '从无到有 / 清空底图不该留过渡层')
// 关掉渐变开关时同样不建（但表还是要重起）
S.fadeOn = false
api.switchFade('/a.png', '/b.png')
assert.equal(fadeLayers().length, 0, '开关关着就不该建层')
S.fadeOn = true
S.autoOn = false
api.armAuto()
api.fadeStop()
rafQueue.length = 0          // 这一组建过层，帧队列清干净再交给 ④ 数自己的帧
console.log('PASS ② 开关/signature：关着零定时器；开着恰好一根；只调设置不重起；**换图重起**')

// ---- ③ autoTick：换图失败/池子为空也不许让循环停掉 ----
S.autoOn = true
S.autoMin = 30
api.armAuto(true)
{
  const before = setCalls
  const tick = [...timers.values()].at(-1).fn
  tick()                                   // 池子为空 ⇒ cycleWallpaper 走 fetchList 失败分支
  assert.equal(api.autoPending(), true, '一次换图没成功就把自动切换弄停了')
  assert.equal(setCalls, before + 1, 'autoTick 之后必须重新起表')
}
console.log('PASS ③ autoTick 重新起表：一次 no-op 换图不会让自动切换停摆')

// ---- ④ 真正的连点回归：同时检查旧图层与新图层，而不只数旧层 ----
S.wallpaper = { url: '/bga/wallpapers/a.png' }
assert.equal(api.bgUrlOnScreen(S), S.wallpaper.url)
assert.equal(api.bgUrlOnScreen({wallpaper:null}), '')
const frame = () => { const q = rafQueue.splice(0); q.forEach(fn => fn()) }
const fireTimer = ms => {
  const entry = [...timers].filter(([, t]) => t.ms === ms).at(-1)
  assert.ok(entry, 'missing timer ' + ms)
  timers.delete(entry[0]); entry[1].fn()
}
const select = url => {
  const prev = api.STORE.state.wallpaper?.url || ''
  api.STORE.state.wallpaper = url ? {url} : null
  api.switchFade(prev, url)
}
const reset = () => { api.STORE.state.autoOn = false; api.fadeStop(); select(''); timers.clear(); rafQueue.length = 0 }
reset(); select('/a.png'); select('/b.png')
assert.equal(fadeLayers().length, 1)
assert.match(fadeLayers()[0].textContent, /position:fixed;inset:0;z-index:-1;pointer-events:none/)
assert.ok(fadeLayers()[0].textContent.includes('url("/a.png")'))
assert.equal(api.renderedBgUrl(), '/b.png')
assert.ok(fadeLayers()[0].textContent.includes('opacity:1;transition:none'))
assert.ok(fadeLayers()[0].textContent.includes('prefers-reduced-motion:reduce'))
assert.equal(timers.size, 0, 'rAF 卡住期间不能启动拆层计时')
frame()
assert.ok(fadeLayers()[0].textContent.includes('opacity:1;'), '第一帧保留起点')
frame()
assert.ok(fadeLayers()[0].textContent.includes('opacity:0;transition:opacity 900ms'))
const originalLayer = fadeLayers()[0]
sandbox.getComputedStyle = () => ({content:'""', opacity:'0.4'})
for (let i = 0; i < 100; i++) select('/queued-' + i + '.png')
assert.equal(fadeLayers()[0], originalLayer, '100 次连点不能重建旧层')
assert.equal(api.renderedBgUrl(), '/b.png', '旧层半透明时，下层图片也不许偷换')
assert.ok(api.backgroundCss().includes('url("/b.png")'), '实际输出 CSS 仍必须画 b')
assert.equal(timers.size, 2, '连点不增加过渡计时器')
fireTimer(900); fireTimer(950)
assert.equal(fadeLayers()[0], originalLayer, '墙钟到期但 opacity=0.4 时不能拆层')
for (let i = 0; i < 65; i++) fireTimer(100)
assert.equal(fadeLayers()[0], originalLayer, '超过旧的 60 次限制仍不能强摘可见层')
sandbox.getComputedStyle = () => ({content:'""', opacity:'0'})
fireTimer(100)
assert.equal(api.renderedBgUrl(), '/queued-99.png', '淡完后接上最后一次选择，丢弃中间队列')
assert.ok(fadeLayers()[0].textContent.includes('url("/b.png")'), '下一段从刚淡入的 b 开始')
assert.ok(fadeLayers()[0].textContent.includes('opacity:1;'))
delete sandbox.getComputedStyle
frame(); frame(); fireTimer(900); fireTimer(950)
assert.equal(fadeLayers().length, 0)
assert.equal(timers.size, 0)
// 最新选择回到正在淡入的图：取消旧的 pending，不能在淡完后又跳回去。
reset(); select('/a.png'); select('/b.png'); select('/c.png'); select('/b.png')
frame(); frame(); fireTimer(900); fireTimer(950)
assert.equal(api.renderedBgUrl(), '/b.png')
assert.equal(fadeLayers().length, 0)
// 清空、关过渡和减少动态效果均要取消旧层与排队项。
for (const mode of ['clear', 'off', 'reduced']) {
  reset(); select('/a.png'); select('/b.png'); select('/c.png')
  if (mode === 'off') api.STORE.state.fadeOn = false
  if (mode === 'reduced') sandbox.window.matchMedia = () => ({matches:true})
  select(mode === 'clear' ? '' : '/d.png')
  assert.equal(fadeLayers().length, 0, mode + ': cancel old fade')
  frame(); frame()
  assert.equal(api.renderedBgUrl(), mode === 'clear' ? '' : '/d.png')
  assert.equal(timers.size, 0, mode + ': no leaked callbacks')
  api.STORE.state.fadeOn = true; delete sandbox.window.matchMedia
}
reset(); S.wallpaper = {url:'/bga/wallpapers/b.png'}
console.log('PASS ④ 连点 100 次：上下两层均无硬切、仅最后选择接续、卡顿不强拆、取消与减少动态效果')

// ---- ⑤ 抽取回归：dynamicCss 的 ::before 还是原来那套配方 ----
{
  const dyn = api.dynamicCss()
  const url = S.wallpaper.url
  assert.ok(dyn.includes('body{background-color:' + S.deep + '}'))
  assert.ok(dyn.includes('body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background-image:linear-gradient('))
  assert.ok(dyn.includes('url("' + url + '")'))
  assert.ok(dyn.includes('background-size:cover;background-repeat:no-repeat;background-position:' + S.focus))
  assert.ok(dyn.includes('transform:scale(1.00);transform-origin:' + S.focus))
  assert.ok(api.bgLayerCss('body::after', { focus: '0% 0%', zoom: 1.5 }, '/u.png', 'v')
    .includes('transform:scale(1.50);transform-origin:0% 0%'))
  assert.ok(!api.bgLayerCss('body::before', {}, '/u.png', 'v').includes('scale(NaN)'), 'zoom 坏值不许写进 CSS')
}
console.log('PASS ⑤ dynamicCss 的 ::before 配方经抽取后逐条不变（cover/焦点/缩放/暗纱）')

// ---- ⑥ 换图前先解码：新图还没解码就切 ⇒ 过渡那几帧透出深色底（先变暗再回来） ----
// 列表里显示的是 640px 预览、底图是几十 MB 原图，这条路上"没解码就切"是常态而不是边角情况。
const decoded = []
sandbox.Image = class {
  constructor() { this.src = '' }
  decode() { return new Promise((res, rej) => { decoded.push({ res, rej, img:this, done:false }) }) }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const decodeNext = async (ok=true) => {
  const entry=decoded.find(e=>!e.done&&e.img.src)
  assert.ok(entry,'expected one live decoder')
  entry.done=true
  if(ok)entry.res();else entry.rej(new Error('decode failed'))
  await settle()
}
const item = (n) => ({ id: 'a\u0000' + n, cat: 'a', base: n, file: n + '.png', url: '/bga/wallpapers/a/' + n + '.png' })
const onScreen = () => (api.STORE.state.wallpaper || {}).url

api.STORE.state.wallpaper = { id: 'a\u0000b', cat: 'a', file: 'b.png', name: 'b', url: '/bga/wallpapers/a/b.png' }
api.setWallpaper(item('c'))
assert.equal(onScreen(), '/bga/wallpapers/a/b.png', '新图没解码好就不许换（换了就是那几帧透底）')
assert.equal(decoded.length, 1, 'setWallpaper 必须真的去解码新图')
await decodeNext()
assert.equal(onScreen(), '/bga/wallpapers/a/c.png', '解码完成后才换')

// 原来每次点击都新开一个 decode；现在最多一个在跑，加一个可替换的最新目标。
api.setWallpaper(item('d'))
const running=decoded.length
api.setWallpaper(item('skip'));api.setWallpaper(item('e'))
assert.equal(decoded.length,running,'rapid clicks cannot spawn overlapping decoders')
await decodeNext()
assert.equal(onScreen(),item('c').url,'stale decoded result cannot be presented')
assert.equal(decoded.at(-1).img.src,item('e').url,'next decoder goes straight to latest target')
await decodeNext()
assert.equal(onScreen(),item('e').url)

// 解码失败 / 超时：保留已可画的图，不能把空图塞到渐变下面
api.setWallpaper(item('f'))
await decodeNext(false)
assert.equal(onScreen(), '/bga/wallpapers/a/e.png', '解码失败保留当前图')

api.setWallpaper(item('g'))
const stuck = [...timers.entries()].filter(([, t]) => t.ms === 15000)
assert.ok(stuck.length, '解码卡住要有兜底定时器')
stuck.at(-1)[1].fn()
assert.equal(onScreen(), '/bga/wallpapers/a/e.png', '超时不能强行换成未解码的图')
api.setWallpaper(item('h'))
api.STORE.set({wallpaper:null})
assert.equal(decoded.at(-1).img.src,'','clear detaches image source as well as ignoring its result')
decoded.at(-1).res(); await settle()
assert.equal(api.STORE.state.wallpaper, null, '清除后迟到的解码不能恢复旧图')

// 没有 url（清除底图那条路）: 不等，直接切
api.setWallpaper({ id: 'x', cat: 'a', base: 'x', file: 'x.png', url: '' })
assert.equal(onScreen(), '', '没有 url 就不该进解码等待')
console.log('PASS ⑥ 换图前先解码新图：解码前不换 / 后点的快图不被慢图盖掉 / 失败与超时保留原图')

api.STORE.list=['a','b','c','d'].map(item)
api.setPlaybackSource('all');api.setPlaybackMode('ordered')
api.setWallpaper(item('a'));await decodeNext()
const beforeBurst=decoded.length
api.cycleWallpaper();api.cycleWallpaper();api.cycleWallpaper()
assert.equal(decoded.length,beforeBurst+1)
await decodeNext();await decodeNext()
assert.equal(onScreen(),item('d').url,'rapid sequential requests advance through pending targets')
assert.equal(decoded.length,beforeBurst+2,'middle target c never needs a decoder')
api.previousWallpaper();await decodeNext(false)
assert.equal(onScreen(),item('d').url,'failed previous load leaves current picture and history position unchanged')
api.previousWallpaper();await decodeNext()
assert.equal(onScreen(),item('a').url,'previous skips canceled requests, retry still returns the visited picture')
api.cycleWallpaper();await decodeNext()
assert.equal(onScreen(),item('d').url,'forward restores history after successful back')
api.setPlaybackSource('cat:a');api.setPlaybackMode('ordered')
api.setWallpaper(item('b'));await decodeNext()
api.setWallpaper(item('c'));await decodeNext()
api.previousWallpaper();api.previousWallpaper()
await decodeNext();await decodeNext()
assert.equal(onScreen(),item('d').url,'rapid previous clicks reserve their history positions while decoding')
api.cycleWallpaper();api.setPlaybackSource('list:missing');decoded.at(-1).res();await settle()
assert.equal(onScreen(),item('d').url,'switching scope cancels pending navigation')
const removing=api.createPlaylist('加载时移出',[item('a').id,item('d').id])
api.setPlaybackSource('list:'+removing);api.cycleWallpaper()
api.removeFromPlaylist(removing,[item('a').id]);await decodeNext()
assert.equal(onScreen(),item('d').url,'scoped request must not accept a removed member after decode')
api.setPlaybackSource('all')
api.setWallpaper(item('a'));const sameJob=decoded.length
for(let i=0;i<30;i++)api.setWallpaper(item('a'))
assert.equal(decoded.length,sameJob,'same URL shares the running job')
await decodeNext();assert.equal(onScreen(),item('a').url)
api.setWallpaper(item('b'));api.STORE.set({weId:'scene-loading'})
assert.equal(decoded.at(-1).img.src,'','WE selection cancels pending static work')
decoded.at(-1).res();await settle();assert.equal(onScreen(),item('a').url)
api.STORE.set({weId:null})
const beforeMetadata=decoded.length
api.STORE.set({wallpaper:{id:item('a').id,url:item('a').url}})
api.setWallpaper(item('a'),{automatic:true})
assert.equal(api.STORE.state.wallpaper.name,'a','same-image restoration can fill missing metadata')
assert.equal(decoded.length,beforeMetadata,'metadata restoration does not decode an already displayed image')
console.log('PASS ⑥b 顺序连点 / 迟到解码 / 上一张失败重试 / 连续后退 / 换范围取消')

// ---- ⑦ 档位表与档位滑杆（v1.11.0 用户要求的不平均刻度）----
// 注意：internals 里的数组来自 vm 沙箱（跨 realm），deepStrictEqual 会连原型一起比 ⇒ 先摊平成宿主数组
assert.deepEqual([...api.AUTO_STOPS], [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120], '档位表就是用户点名的那 14 个')
// 也别再用上面那个 S：STORE.set 是**整个换掉 state 对象**（client.js 里 `this.state = next`），
// ⑥ 的 setWallpaper 已经换过一次 ⇒ 老引用上的写入谁都看不见。往后一律 api.STORE.state 现取。
for (let i = 1; i < api.AUTO_STOPS.length; i++) {
  assert.ok(api.AUTO_STOPS[i] > api.AUTO_STOPS[i - 1], '档位必须严格升序：滑杆按 index 映射，重复/乱序会指错档')
}
for (const m of api.AUTO_STOPS) {                    // 每一档自己读秒不许漂到邻档
  api.STORE.state.autoMin = m
  assert.equal(api.autoDelayMs(), m * MIN, m + ' 分钟这一档读成了别的档')
}
const lastRange = () => hCalls.filter((c) => c.p && c.p.type === 'range').at(-1).p
// 取值文本在定宽格子里（.bga-val）——它必须是**元素**，光挂个裸文本节点
// 就会随字数变宽，把同一行后面的滑杆挤着横跳（这一组就是在守这个）。
// 注意 React 桩每层都返回 null，所以不能顺着 label 的 kids 往下找，得看 hCalls 的顺序：
// span 是 label 的最后一个实参 ⇒ 它的记录紧挨在 label 那条记录之前。
const lastValCell = () => {
  const cell = hCalls[hCalls.findLastIndex((c) => c.t === 'label') - 1]
  return cell && cell.t === 'span' && cell.p && cell.p.className === 'bga-val' ? cell : null
}
const lastShown = () => {
  const cell = lastValCell()
  assert.ok(cell, '取值文本必须是 label 的最后一个子元素，且挂 .bga-val 定宽格子')
  return cell.kids[0]
}
{
  const got = []
  api.Slider('切换间隔', 30, 1, 120, (v) => got.push(v), 'min', api.AUTO_STOPS)
  const sl = lastRange()
  assert.equal(sl.min, '0', '滑杆走 index（等距），不是 1..120 的均匀刻度')
  assert.equal(sl.max, '13')
  assert.equal(sl.step, '1')
  assert.equal(sl.value, '9', '30 分钟该落在第 9 档')
  assert.equal(lastShown(), '30 分钟')
  for (let i = 0; i < api.AUTO_STOPS.length; i++) sl.onChange({ target: { value: String(i) } })
  assert.deepEqual(got, [...api.AUTO_STOPS], '第 i 档必须交给 STORE 第 i 个档位值')
  // 表外的存量值（手改过 settings.json）：先吸附再落档，否则滑杆指到空档、显示也不对
  api.Slider('切换间隔', 47, 1, 120, () => {}, 'min', api.AUTO_STOPS)
  assert.equal(lastRange().value, '10', '47 该吸附到 45 = 第 10 档')
  assert.equal(lastShown(), '45 分钟')
  api.Slider('切换间隔', 120, 1, 120, () => {}, 'min', api.AUTO_STOPS)
  assert.equal(lastShown(), '2 小时', '满档按小时显示，别写成 120 分钟')
  // 毫秒滑杆（响应时间 / 渐变时长）——上限跟着源码，别在这里写死两份
  const durMax = api.fadeDurMs({ fadeMs: 999999 }), waitMax = api.fadeWaitMs({ fadeDelayMs: 999999 })
  api.Slider('渐变时长', 900, 100, durMax, () => {}, 'ms')
  assert.equal(lastRange().step, '50')
  assert.equal(lastShown(), '900 毫秒')
  api.Slider('响应时间', 1000, 0, waitMax, () => {}, 'ms')
  assert.equal(lastShown(), '1 秒')
  // 滑杆上限必须等于钳制上限：不然手改的 settings.json 塞个超界值，滑杆指不到那个位置（拇指贴边、值却更大）
  for (const [name, max] of [['渐变时长', durMax], ['开始前等待', waitMax]]) {
    const call = src.match(new RegExp("Slider\\('" + name + "',\\s*s\\.\\w+,\\s*(\\d+),\\s*(\\d+)"))
    assert.ok(call, '设置页里要有「' + name + '」滑杆')
    assert.equal(Number(call[2]), max, name + ' 滑杆上限(' + call[2] + ') 与钳制上限(' + max + ') 对不上')
  }
  assert.equal(durMax, 5000, '渐变时长上限')
  assert.equal(waitMax, 1000, '响应时间上限')
  // 取值格必须定宽：不然拖动时数字长短一变，同一行后面的滑杆就被挤着横跳（观感问题，肉眼才看得出来）
  const css = src.match(/\.bga-field \.bga-val\{[^}]*\}/)
  assert.ok(css, 'client.js 里要有 .bga-field .bga-val 定宽规则')
  assert.match(css[0], /min-width:5[6-9]px|min-width:[6-9]\dpx/, '取值格至少 56px，得放得下最长的 "1000 毫秒"')
  assert.match(css[0], /text-align:right/, '右对齐，数字位数变化时向左长')
  assert.match(css[0], /nowrap/, '不许换行（换行会把整行高度撑高一倍）')
  assert.match(css[0], /tabular-nums/, '等宽数字：不然 1 和 8 的字宽差也在抖')
  for (const [v, want] of [[1050, '1.05 秒'], [2000, '2 秒'], [5000, '5 秒'], [950, '950 毫秒'], [100, '100 毫秒']]) {
    api.Slider('渐变时长', v, 100, 5000, () => {}, 'ms')
    assert.equal(lastShown(), want, '毫秒档 ' + v + ' 的显示')
  }
  api.Slider('切换间隔', 1, 1, 120, () => {}, 'min', api.AUTO_STOPS)
  assert.equal(lastShown(), '1 分钟')
  api.Slider('切换间隔', 120, 1, 120, () => {}, 'min', api.AUTO_STOPS)
  assert.equal(lastShown(), '2 小时')
}
console.log('PASS ⑦ 档位滑杆：等距 index → 查表取值（14 档不平均）/ 表外值吸附 / 显示分钟与小时（取值格定宽）')

// ---- ⑧ 渐变时长与响应时间：从设置里读，坏值有兜底 ----
for (const [v, want] of [[NaN, 900], [undefined, 900], [0, 100], [-100, 100], [5000, 5000], [99999, 5000], ['1500', 1500]]) {
  assert.equal(api.fadeDurMs({ fadeMs: v }), want, 'fadeMs=' + String(v) + ' 该读成 ' + want + 'ms')
}
for (const [v, want] of [[NaN, 0], [undefined, 0], [-1, 0], [1000, 1000], [99999, 1000], ['250', 250]]) {
  assert.equal(api.fadeWaitMs({ fadeDelayMs: v }), want, 'fadeDelayMs=' + String(v) + ' 该读成 ' + want + 'ms')
}
{
  const st = api.STORE.state
  reset(); st.fadeMs = 300; st.fadeDelayMs = 200
  select('/a.png'); select('/b.png'); select('/c.png')
  assert.equal(api.renderedBgUrl(), '/b.png')
  assert.equal(rafQueue.length, 0)
  assert.equal(timers.size, 1, '延迟期间只有等待计时器')
  fireTimer(200); frame(); frame()
  assert.ok(fadeLayers()[0].textContent.includes('opacity:0;transition:opacity 300ms'))
  fireTimer(300); fireTimer(350)
  assert.equal(api.renderedBgUrl(), '/c.png')
  assert.ok(fadeLayers()[0].textContent.includes('url("/b.png")'))
  // 旧层尚未执行的 rAF 不得推进新层。
  fireTimer(200); frame()
  const staleFrame = rafQueue.shift()
  api.fadeStop(); select('/d.png')
  staleFrame()
  assert.ok(fadeLayers()[0].textContent.includes('opacity:1;'))
  assert.equal(timers.size, 1)
  // 旧层尚未执行的延迟回调也不得推进新层。
  const staleWait = [...timers.values()][0].fn
  api.fadeStop(); select('/e.png'); staleWait()
  assert.equal(rafQueue.length, 0)
  api.fadeStop(); st.fadeMs = 900; st.fadeDelayMs = 0
}
console.log('PASS ⑧ 渐变时长 / 响应时间：从设置读 + 坏值兜底；延迟期间不动、到点才淡、连点不拆在动的层')

// ---- ⑨ 点击频率调速：档位、等待段、原生速率更新、旧运行时回退 ----
for(const [gap,want] of [[null,2800],[NaN,2800],[Infinity,2800],[-1,2800],[1500,2800],[1499,1000],[800,1000],[799,500],[400,500],[399,300],[0,300]]){
  assert.equal(api.adaptiveFadeMs({fadeMs:2800},gap),want,'click interval '+gap)
}
for(const gap of [0,200,400,800,1400])assert.equal(api.adaptiveFadeMs({fadeMs:250},gap),250,'never lengthen a short user setting')
reset();api.STORE.state.fadeMs=2800;api.STORE.state.fadeDelayMs=800
let clickTime=0
sandbox.performance={now:()=>clickTime}
assert.deepEqual({...api.manualFadeTiming()},{duration:2800,wait:800})
select('/a.png');select('/b.png')
clickTime=1000
assert.deepEqual({...api.manualFadeTiming()},{duration:1000,wait:0})
assert.equal([...timers.values()].some(t=>t.ms===800),false,'fast click bypasses initial wait immediately')
frame();frame()
assert.ok(fadeLayers()[0].textContent.includes('opacity 1000ms ease'))
const unchangedLayer=fadeLayers()[0], originalText=unchangedLayer.textContent, rates=[]
let finishAnimation
const finished=new Promise(resolve=>{finishAnimation=resolve})
sandbox.document.body={getAnimations:()=>[
  {transitionProperty:'opacity',playState:'running',effect:{target:sandbox.document.body,pseudoElement:'::before'}},
  {transitionProperty:'opacity',playState:'running',currentTime:300,finished,updatePlaybackRate:rate=>rates.push(rate),
    effect:{target:sandbox.document.body,pseudoElement:'::after',getComputedTiming:()=>({duration:1000})}}
]}
sandbox.getComputedStyle=()=>({content:'""',opacity:'0.7'})
clickTime=1500;api.manualFadeTiming()
assert.equal(rates.at(-1),1000/500)
clickTime=1750;api.manualFadeTiming()
assert.equal(rates.at(-1),1000/300)
assert.equal(unchangedLayer.textContent,originalText,'changing speed cannot reset CSS opacity or rebuild its layer')
const timerCount=setCalls
clickTime=1800;api.manualFadeTiming();clickTime=1900;api.manualFadeTiming()
assert.equal(setCalls,timerCount,'same-tier clicks cannot push back the deadline')
clickTime=3600
assert.equal(api.manualFadeTiming().duration,2800,'pause restores configured duration for new targets')
assert.equal(api.fadeMotionStatus().duration,300,'an active accelerated fade cannot be slowed again')
api.fadeStop();const timerCountAfterStop=timers.size
finishAnimation();await settle()
assert.equal(timers.size,timerCountAfterStop,'late animation completion after stop cannot start another transition')
delete sandbox.document.body;delete sandbox.getComputedStyle

reset();api.STORE.state.fadeMs=2800;api.STORE.state.fadeDelayMs=0
clickTime=4000;api.manualFadeTiming();select('/a.png');select('/b.png');frame();frame()
const fallbackLayer=fadeLayers()[0]
sandbox.getComputedStyle=()=>({content:'""',opacity:'0.4'})
clickTime=4500;api.manualFadeTiming()
assert.equal(fadeLayers()[0],fallbackLayer)
assert.ok(fallbackLayer.textContent.includes('opacity:0.4;transition:none'),'CSS fallback freezes current alpha, never resets to 1')
clickTime=4600;api.manualFadeTiming();frame();frame()
assert.ok(fallbackLayer.textContent.includes('opacity:0;transition:opacity 120ms linear'),'remaining distance is 0.4 × fastest 300 ms')
delete sandbox.getComputedStyle;reset();delete sandbox.performance
api.STORE.state.fadeMs=900;api.STORE.state.fadeDelayMs=0
console.log('PASS ⑨ 点击档位边界 / 不延长原设置 / 跳过等待 / 原动画保进度加速 / 同档不重起 / 停顿恢复 / CSS 回退 / 取消清理')

console.log('\n全部通过：自动切换（档位吸附 / 开关 / 换图重起表 / tick 起表）+ 档位滑杆（14 档不平均）'
  + ' + 渐变过渡（建拆 / 两帧 / 看不见了才摘 / 时长与响应时间可调）'
  + ' + 换图前解码（解码前不换 / 慢图不盖快图 / 失败/超时/清除取消）')
