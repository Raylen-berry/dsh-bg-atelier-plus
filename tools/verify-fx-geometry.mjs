// 底图工坊 · 特效画布几何 + 标签气泡（离线，进 npm test）
//
// 为什么需要它：2026-10-01 用户报的两件事都是"量出来的事实"，不是观感问题——
//   ① 画布写死 90px 高，往输入框里塞两张图后卡面长到 320px，下半截一点特效都没有
//      （"底部没对齐 + 空白区域断层"）；
//   ② 标签该是小气泡（附图），且卡片上只留名字。
// 这两条都能在**不打开浏览器**的前提下断言：
//   · 几何：给 syncCanvasWidth() 一组假 DOM 量（卡面 912×320、定位祖先 1131×350），
//     看它写到 .bga-dockfx 内联样式上的 --bga-fx-h/oy/inset 是不是卡面矩形本身；
//     再看粒子纵向几何（bottom 百分比 + --bga-fx-rise/fall/drop）随高度放大。
//   · 气泡：直接调 tagPill()/tagPool()，看类名、颜色是不是字面量、池子去重排序。
//
// 用法： node tools/verify-fx-geometry.mjs   （退出码 0 = 全过）
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(process.env.BGA_TEST_CLIENT || new URL('../client.js', import.meta.url), 'utf8')

// ---- 假 DOM ---------------------------------------------------------------
// 需要的最小面：parentElement 链 / getBoundingClientRect / inline style /
// querySelector（两个选择器）/ documentElement.style.setProperty / body.hasAttribute。
// 尺寸全部照本机实测填：卡面 912×320、定位祖先（composerSeat）1131×350、两者左上角对齐。
function el(cls, box, parent) {
  const style = {
    props: {},
    setProperty(k, v) { this.props[k] = v },
    getPropertyValue(k) { return this.props[k] || '' },
  }
  const node = {
    className: cls, parentNode: parent || null, parentElement: parent || null,
    children: [], style, attributes: {},
    setAttribute(k, v) { this.attributes[k] = v },
    getAttribute(k) { return this.attributes[k] },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); c.parentNode = null },
    getBoundingClientRect: () => box,
  }
  return node
}
const seatBox = { width: 1131, height: 350, left: 280, right: 1411, top: 426, bottom: 776 }
const cardBox = { width: 912, height: 320, left: 390, right: 1302, top: 426, bottom: 746 }
const seat = el('Dc7zOa_composerSeat', seatBox)
seat.style.positionSet = true
const root = el('RlGAzG_root', seatBox, seat)
const card = el('RlGAzG_card', cardBox, root)
const host = el('stage', seatBox)
host.parentElement = seat
host.parentNode = seat
const fx = el('bga-dockfx', { width: 912, height: 0, left: 390, right: 1302, top: 426, bottom: 426 }, host)
const rootStyle = { props: {}, setProperty(k, v) { this.props[k] = v }, getPropertyValue(k) { return this.props[k] || '' } }
const head = { children: [], appendChild(n) { head.children.push(n) }, removeChild() {} }
const document = {
  head, body: { hasAttribute: () => false }, documentElement: { style: rootStyle },
  createElement: () => el('', { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }),
  querySelector(sel) {
    if (sel === '.bga-dockfx') return fx
    if (sel === '[data-composer-card]') return card
    if (sel.indexOf('composerSeat') >= 0) return seat
    return null
  },
}
const listeners = new Map()
const window = {
  addEventListener(n, fn) { listeners.set(n, fn) },
  removeEventListener(n) { listeners.delete(n) },
  __ModuleLoader__: { load(m) { loaded = m } },
}
const sandbox = {
  window, document, console,
  // 假样式查询：只有定位祖先（composerSeat）是 sticky，其余在流里（static）——
  // syncCanvasInset 就是靠这条往上找"真正给它定位的祖先"。
  getComputedStyle: (node) => ({ position: node && node.className === 'Dc7zOa_composerSeat' ? 'sticky' : 'static' }),
  setTimeout: () => 0, clearTimeout() {}, ResizeObserver: undefined,
  fetch: () => Promise.resolve({ ok: false }),
}
let loaded
vm.runInNewContext(source, sandbox)
const mod = loaded.factory(() => ({ createElement: (...args) => ({ props: args[1] || {}, children: args.slice(2) }), memo: (f) => f, useState: () => [0, () => {}], useEffect() {}, useRef: () => ({}), useCallback: (f) => f, useMemo: (f) => f() }))
const api = mod.internals

// ---- ① 画布 = 卡面矩形 ----------------------------------------------------
api.STORE.state.effect = 'bubble'
// 假 DOM 的 getBoundingClientRect 是定值（不会因为写入 --bga-fx-h 就真的变高），
// 所以把"卡面高度就是画布高度"这件事直接量给它：old/new 用同一个值 ⇒ 过 4px 闸门。
const fxHeightPx = 320
fx.getBoundingClientRect = () => ({ width: 912, height: fxHeightPx, left: 390, right: 1302, top: 426, bottom: 426 + fxHeightPx })
mod.apply({
  get() {},
  effect(fn, label) {
    // 只跑几何那两条 effect（其余会去碰网络/主题/样式节点, 与本次断言无关）。
    if (label === 'bga-canvas-width' || label === 'bga-canvas-geometry') fn()
  },
})
const inline = fx.style.props

assert.equal(inline['--bga-fx-h'], '320px', '画布高度必须等于卡面高度（用户报的"下半截空白"根因）')
assert.equal(inline['--bga-fx-oy'], '0px', '上偏 = 卡面上沿相对定位祖先的偏移')
assert.equal(inline['--bga-fx-inset-l'], '110px', '左内缩 = 卡面左缘相对定位祖先的偏移')
assert.equal(inline['--bga-fx-inset-r'], '109px', '右内缩 = 定位祖先右缘到卡面右缘')
console.log('PASS 画布几何 = 卡面矩形（height 跟随卡面, 左右各 110/109px）')

// ---- ② 粒子纵向几何随高度放大 ---------------------------------------------
assert.equal(api.canvasScale(90), 1, '基准 90px 不缩放')
assert.equal(api.canvasScale(180), 2, '180px 按比例放大')
assert.equal(api.canvasScale(4000), 200 / 90, '上限 200px（再高只有噪声）')
assert.equal(rootStyle.props['--bga-fx-rise'], '204px', '气泡升程 = 92px × min(200,卡面高)/90')
assert.equal(rootStyle.props['--bga-fx-fall'], '231px', '落樱行程 = 104px × min(200,卡面高)/90')
assert.equal(rootStyle.props['--bga-fx-drop'], '244px', '雨丝行程 = 110px × min(200,卡面高)/90')
const css0 = String(api.staticCss())
const flyPct = [...css0.matchAll(/\.bga-fly\.f\d+\{[^}]*bottom:([\d.]+)%/g)].map((m) => Number(m[1]))
assert.equal(flyPct.length, api.counts().fly, '流萤数量与 CSS 规则条数一致')
assert.ok(flyPct.length > 0 && flyPct.every((p) => p >= 4 && p <= 46), '流萤纵向落点是画布高度的百分比（4~46%）')
assert.match(css0, /--bga-fx-rise,92px/, '升程用变量 + 90px 兜底')
assert.match(css0, /\.bga-dockfx\{position:absolute;top:var\(--bga-fx-oy,0px\)/)
assert.match(css0, /height:var\(--bga-fx-h,90px\)/)
console.log('PASS 粒子纵向几何随卡面高度放大（百分比落点 + rise/fall/drop 变量）')

// ---- ③ 标签气泡 -----------------------------------------------------------
const pill = api.tagPill('重返未来1999')
assert.equal(pill.props.className, 'bga-tagpill')
assert.equal(pill.props.title, '重返未来1999')
assert.deepEqual(pill.children, ['重返未来1999'], '气泡里只放标签名')
for (const k of ['background', 'borderColor', 'color']) {
  assert.match(String(pill.props.style[k]), /^rgba\(/, k + ' 必须是算好的字面量（不许写 theme token）')
}
// 底色是 accent 往浅里混的淡色：alpha 高但不是纯色块
const bgAlpha = Number(/rgba\([^)]+,([\d.]+)\)$/.exec(pill.props.style.background)[1])
assert.ok(bgAlpha > 0.8 && bgAlpha <= 1, '气泡底色要有足够遮盖（0.8~1）')
const pills = api.tagPills(['高清', '线稿风'])
assert.equal(pills.props.className, 'bga-tags')
assert.equal(pills.children[0].length, 2)
assert.equal(api.tagPool([{ tags: ['高清', '线稿风'] }, { tags: ['高清'] }, { tags: ['线稿风', '二次元'] }]).join(','), '二次元,高清,线稿风', '去重 + 按中文名排序')
assert.equal(api.tagPool(Array.from({ length: 30 }, (_, i) => ({ tags: ['t' + i] }))).length, 12, '气泡栏最多 12 个标签')
console.log('PASS 标签气泡（类名/字面量配色/去重排序/上限 12）')

console.log('\n特效画布几何 + 标签气泡：全部通过 ✓')
