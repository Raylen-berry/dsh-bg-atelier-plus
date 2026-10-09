// tools/verify-oracle-geometry.mjs —— 视觉 oracle 的「几何可迁移性」离线回归
//
// 为什么需要（用户第八轮："要可迁移别写死内容，一换就读取不了"）：
// 真机踩到的现场是 —— 装了 Chrome 之后窗口从 CSS 1418 变成 1426、对话框（连里面的面板）
// 整体右移 4px。而我把换算锚点 REF_CSS_WIDTH 和 03 的矩形**写死**成那次测量的绝对值，
// 于是几何核对直接把整个 oracle 判死（exit=4）。
//
// 修法不是把常量改成 1426（那只是押注下一次不变），而是**每次从锚点实测推导几何**，
// 并且基准侧用"录制时实测的那份"、当前侧用"这次实测的那份"分别裁剪。
// 本套件用两张**合成图**证明这一点：可迁移 + 灵敏度没丢。
//
// 用法：node tools/verify-oracle-geometry.mjs
import { compareStableImages, cropStable, cssScale } from './oracle-compare.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ------------------------------------------------------------------ 合成图
// 面板内容 = 只跟"相对面板左上角的坐标"有关的图案 ⇒ 两张图里的面板**内容完全相同**，
// 但面板在整图里的**位置不同**（模拟窗口变宽后整体右移）。
// 面板外的底色是**常量**（对应真实情况：对话框的底色是均匀的）⇒
//   ① 用各自实测几何裁：两边都拿到同一块面板内容 ⇒ 判一致；
//   ② 用写死常量裁：面板相对裁剪框错位 1px ⇒ 内容图案整体平移 ⇒ 必判差异。
const PANEL_W = 560, PANEL_H = 600
const BG = [30, 30, 30]

function panelPixel(px, py) {
  return [(px * 3 + py * 7) & 0xff, (px * 5 + py * 11) & 0xff, (px * 9 + py * 13) & 0xff]
}

function makeShot(cssWidth, cssHeight, panelLeft, panelTop, opts = {}) {
  const w = cssWidth, h = cssHeight
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const inPanel = x >= panelLeft && x < panelLeft + PANEL_W && y >= panelTop && y < panelTop + PANEL_H
      let c = inPanel ? panelPixel(x - panelLeft, y - panelTop) : BG
      if (!inPanel) { data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255; continue }
      // 植入"回归"：面板内部一块区域改色
      if (opts.regressAt) {
        const rx = x - panelLeft, ry = y - panelTop
        if (rx >= opts.regressAt[0] && rx < opts.regressAt[2] && ry >= opts.regressAt[1] && ry < opts.regressAt[3]) {
          c = [7, 200, 7]
        }
      }
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255
    }
  }
  return { width: w, height: h, channels: 4, data }
}

// 录制时：CSS 宽 1418、面板在 (521,78)
const A = makeShot(1418, 776, 521, 78)
// 换浏览器后：CSS 宽 1426、对话框整体右移 4px ⇒ 面板在 (525,78)，**内容一模一样**
const B = makeShot(1426, 807, 525, 78)

// 两次各自"实测锚点"推导出的几何（与 measureLiveGeom 的规则一致：左 −6、右 +4、上 −4）
const geomA = { cssWidth: 1418, rect: { x0: 521 - 6, x1: 521 + PANEL_W + 4, y0: 78 - 4, y1: 78 + PANEL_H }, masks: [] }
const geomB = { cssWidth: 1426, rect: { x0: 525 - 6, x1: 525 + PANEL_W + 4, y0: 78 - 4, y1: 78 + PANEL_H }, masks: [] }

console.log('=== oracle 几何可迁移性回归（合成图，无需浏览器）===')

console.log('\n— ① 窗口变宽 + 面板右移 4px：内容相同 ⇒ 必须判"一致" —')
{
  const r = compareStableImages(A, B, '03-settings-studio', geomA, geomB)
  ok('★ 用各自实测几何裁剪 ⇒ 判无差异（这就是可迁移）', r.same === true,
    'diff=' + r.diff + '/' + r.compared.width * r.compared.height + ' maxΔ=' + r.maxChannelDelta
      + ' compared=' + r.compared.width + '×' + r.compared.height)
}

console.log('\n— ② 反证：沿用写死的绝对常量口径 ⇒ 同一个变化会被裁歪 —')
{
  // 不传 geom ⇒ oracle-compare 回落到表里的常量（x 515–1085 / 锚点 1418），
  // 而 B 的面板实际在 525 ⇒ 左边吃进 10px 背景、右边少掉 10px 面板 ⇒ 必然报差异。
  const r = compareStableImages(A, B, '03-settings-studio')
  ok('★ 写死常量的旧口径**会**报差异（证明 ① 的通过来自实测几何，不是碰巧）',
    r.same === false, 'diff=' + r.diff + ' maxΔ=' + r.maxChannelDelta)
}

console.log('\n— ③ 灵敏度没丢：面板内部真回归仍必须被抓到（即便两次位置不同）—')
{
  const Breg = makeShot(1426, 807, 525, 78, { regressAt: [200, 300, 220, 320] })
  const r = compareStableImages(A, Breg, '03-settings-studio', geomA, geomB)
  ok('★ 面板内 20×20 的改色被抓到', r.same === false && r.diff >= 380,
    'diff=' + r.diff + ' maxΔ=' + r.maxChannelDelta)
}

console.log('\n— ④ 框大小跟随锚点（不是固定像素数）—')
{
  const c1 = cropStable(A, '03-settings-studio', geomA)
  const c2 = cropStable(B, '03-settings-studio', geomB)
  ok('两侧裁剪尺寸一致（都= 面板宽+10 × 面板高+4）', c1.width === c2.width && c1.height === c2.height,
    c1.width + '×' + c1.height + ' vs ' + c2.width + '×' + c2.height)
}

console.log('\n— ⑤ cssScale 用实测 CSS 宽（不是写死的截图宽）—')
{
  ok('cssScale(截图宽 1426, cssWidth 1426) = 1', Math.abs(cssScale({ width: 1426 }, 1426) - 1) < 1e-9)
  ok('cssScale(截图宽 1664, cssWidth 1426) ≈ 1.1666（dpr）',
    Math.abs(cssScale({ width: 1664 }, 1426) - 1664 / 1426) < 1e-9, String(cssScale({ width: 1664 }, 1426)))
  // 传 0 / 非法值 ⇒ 回落到兜底常量，不能算出 Infinity 把裁剪彻底搞坏
  const s = cssScale({ width: 1654 }, 0)
  ok('cssWidth 传 0 时回落兜底（不产生 Infinity）', Number.isFinite(s) && s > 0, String(s))
}

console.log('\n几何回归：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
