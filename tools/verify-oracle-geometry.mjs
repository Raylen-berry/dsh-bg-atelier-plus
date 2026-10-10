// tools/verify-oracle-geometry.mjs —— 视觉 oracle 的「几何可迁移性」离线回归
//
// 为什么需要（用户第八轮："要可迁移别写死内容，一换就读取不了"）：
// 真机踩到的现场是 —— 装了 Chrome 之后窗口从 CSS 1418 变成 1426、对话框（连里面的面板）
// 整体右移 4px。而我把换算锚点 REF_CSS_WIDTH 和 03 的矩形**写死**成那次测量的绝对值，
// 于是几何核对直接把整个 oracle 判死（exit=4）。
//
// 修法不是把常量改成 1426（那只是押注下一次不变），而是**每次从锚点实测推导几何**。
//
// ⚠️ 但"跟着插件锚点走"又引入了第八轮之后被审核方抓到的**两条新漏检**，本套件把它们
//    钉成坏例（正常例通过 + 故意弄坏后必须失败）：
//      ① 插件自身横移 12px（视口与宿主对话框都不变）⇒ 裁剪框跟着插件走 ⇒ 被自动对齐吃掉。
//         修法：**裁剪框锚在宿主上**（对话框/侧栏列），插件相对宿主的偏移变成**断言对象**
//         （assertLayoutContract）。本文件 ⑦ 节给出正例与坏例。
//      ② 比较范围大幅缩水 ⇒ 只比交集、丢掉基准若干行 ⇒ 原本能检出的变化变 diff=0。
//         修法：compareStableImages 的**覆盖校验**（两侧框不齐 / 与录制尺寸不符 ⇒
//         coverage.ok=false ⇒ 调用方按"覆盖不足"失败）。本文件 ⑧ 节给出正例与坏例。
//
// 用法：node tools/verify-oracle-geometry.mjs
import {
  compareStableImages, cropStable, cssScale, deriveGeom,
  pluginRectRel, assertLayoutContract,
} from './oracle-compare.mjs'

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

console.log('\n— ⑥ deriveGeom：侧栏必须**以插件自己的元素为锚**，且排除随时间变的那一列 —')
{
  // 真机查出来的覆盖缺陷：01/02 原来写"y 0..innerHeight-156"（纯粹按视口切），
  // 而插件自己的 orb 实测在 CSS y724–751 ⇒ **完全在区域之外**，那两张状态比的全是宿主装饰。
  // 同时会话行的"进行中"旋转指示器（宿主 SVG 动画，CSS x21–35 y361–375）被圈进来，
  // 每轮报 ~130px、maxΔ 高达 99 的假差异。
  const anchors = {
    w: 1426, h: 807,
    sidebar: { l: 0, t: 0, r: 280, b: 807 },
    volatile: [{ l: 234, r: 261, t: '6分钟' }, { l: 229, r: 233, t: '' }],
    plugin: [{ l: 12, t: 724, r: 40, b: 751 }],          // .bga-orb 实测位置
  }
  const g = deriveGeom('01-static-wallpaper', anchors)
  ok('★ 右边界取时间标签左沿−1（228），不是侧栏右−8（272）',
    g && g.rect.x1 === 228, g ? 'x1=' + g.rect.x1 : 'null')
  ok('★ 纵向覆盖到插件的 orb（y724–751 落在区域内）',
    g && g.rect.y0 <= 724 && g.rect.y1 >= 751, g ? 'y' + g.rect.y0 + '–' + g.rect.y1 : 'null')
  ok('★ 不再按视口高度写死（旧规则 y1 会是 651 < 724）',
    g && g.rect.y1 > 651, g ? 'y1=' + g.rect.y1 : 'null')
  ok('★ 会话行的旋转指示器（y361–375）落在区域之外',
    g && g.rect.y0 > 375, g ? 'y0=' + g.rect.y0 : 'null')

  // 没有 volatile 时确实退到侧栏右−8（反证：上面那条不是巧合）
  const gNo = deriveGeom('01-static-wallpaper', { ...anchors, volatile: [] })
  ok('反证：探测不到时间标签时才退到侧栏右−8=272', gNo.rect.x1 === 272, 'x1=' + gNo.rect.x1)

  // 锚点缺失 ⇒ null（大声失败，不回落常量）
  ok('插件元素测不到 ⇒ null（不比宿主装饰冒充覆盖）',
    deriveGeom('01-static-wallpaper', { ...anchors, plugin: [] }) === null)
  ok('侧栏锚点也没有 ⇒ null', deriveGeom('01-static-wallpaper', { w: 1426, h: 807, plugin: [] }) === null)
  ok('03 缺 dlg ⇒ null', deriveGeom('03-settings-studio', { w: 1426, h: 807 }) === null)

  // 03 的屏蔽框 = 壁纸位图表面（hero + 图库缩略图），且**存成相对裁剪框的偏移**
  const g3 = deriveGeom('03-settings-studio', {
    w: 1426, h: 807, dlg: { l: 313, t: 24, r: 1113, b: 783 },
    hero: { l: 545, t: 148, r: 1059, b: 360 },
    imgSurfaces: [{ l: 683, t: 748, r: 869, b: 776 }],
  })
  ok('03 裁剪框 = 对话框内缩 6/4/6/7（锚在宿主上）',
    JSON.stringify(g3.rect) === JSON.stringify({ x0: 319, y0: 28, x1: 1107, y1: 776 }),
    JSON.stringify(g3.rect))
  ok('03 屏蔽框 = hero ±2 + 图库缩略图（共 2 个）', g3.masks.length === 2,
    JSON.stringify(g3.masks))
  ok('03 屏蔽框是**相对裁剪框**的偏移（宿主移动时跟着走）',
    JSON.stringify(g3.masks[0]) === JSON.stringify([224, 118, 742, 334]), JSON.stringify(g3.masks[0]))
}

console.log('\n— ⑦ 插件自身横移必须被检出（不能靠"跟着插件锚点走"自动对齐掉）—')
{
  // 审核方第十轮第一条：视口与宿主对话框**都不变**，只让插件横移 12 CSS px ⇒
  // 上一版把裁剪框锚在插件上，两边各自跟着插件 ⇒ 内容重新对齐 ⇒ same=true、diff=0（漏检）。
  const DLG = { l: 313, t: 24, r: 1113, b: 783 }
  const aBase = { w: 1426, h: 807, dlg: DLG, studio: { l: 525, t: 78, r: 1085, b: 1419 },
    hero: { l: 545, t: 148, r: 1059, b: 360 } }
  const aShift = { ...aBase, studio: { l: 537, t: 78, r: 1097, b: 1419 } }   // 宿主没动，插件右移 12

  const gBase = deriveGeom('03-settings-studio', aBase)          // 录制：定下 rel
  ok('录制时记下了相对宿主的内缩量 rel', !!(gBase && gBase.rel), JSON.stringify(gBase && gBase.rel))

  // 比对时用**录制时的 rel** + 当前宿主 ⇒ 框钉在宿主上，不跟插件走
  const gNowBase = deriveGeom('03-settings-studio', aBase, gBase.rel)
  const gNowShift = deriveGeom('03-settings-studio', aShift, gBase.rel)
  ok('★ 宿主不变时，两侧裁剪框**完全一致**（框锚在宿主上，不跟插件漂）',
    gNowBase.rect.x0 === gNowShift.rect.x0 && gNowBase.rect.x1 === gNowShift.rect.x1,
    '基准 ' + JSON.stringify(gNowBase.rect) + ' 横移后 ' + JSON.stringify(gNowShift.rect))

  // 像素层面：真实比较函数必须检出这 12px 横移
  const A = makeShot(1426, 807, 525, 78)      // 面板在 525
  const B = makeShot(1426, 807, 537, 78)      // 面板挪到 537（同一套图案内容）
  const r = compareStableImages(A, B, '03-settings-studio', gNowBase, gNowShift)
  ok('★ 插件横移 12px ⇒ **判有差异**（上一版这里是 diff=0 的漏检）', r.same === false,
    'same=' + r.same + ' diff=' + r.diff)

  // 反证：手工构造**上一版那种"框跟着插件锚点走"**的几何 ⇒ 就会漏检。
  // （现在 deriveGeom 无论传不传 rel 都不再跟插件走，所以这里必须手写旧口径才能复现旧行为。）
  const gFollowA = { cssWidth: 1426, rect: { x0: aBase.studio.l - 6, x1: aBase.studio.r + 4, y0: 74, y1: 678 }, masks: [] }
  const gFollowB = { cssWidth: 1426, rect: { x0: aShift.studio.l - 6, x1: aShift.studio.r + 4, y0: 74, y1: 678 }, masks: [] }
  const rFollow = compareStableImages(A, B, '03-settings-studio', gFollowA, gFollowB)
  ok('反证：框跟着插件走 ⇒ diff=0 漏检（这正是上一版的行为）', rFollow.same === true, 'diff=' + rFollow.diff)

  // 布局契约：插件相对宿主的偏移漂了 12px ⇒ 必须报出来（带数字）
  const rec = pluginRectRel('studio', aBase)
  const drift = assertLayoutContract(rec, pluginRectRel('studio', aShift))
  ok('★ 布局契约抓到"左偏移 212→224（Δ+12）"', typeof drift === 'string' && drift.includes('12'),
    String(drift))
  // 正常例：宿主与插件一起随窗口移动 ⇒ 契约不该误报（这正是可迁移要放行的）
  const aMovedTogether = { ...aBase, dlg: { l: 321, t: 24, r: 1121, b: 783 },
    studio: { l: 533, t: 78, r: 1093, b: 1419 }, hero: { l: 553, t: 148, r: 1067, b: 360 } }
  ok('正常例：宿主与插件**一起**右移 8px ⇒ 契约通过（不误报）',
    assertLayoutContract(rec, pluginRectRel('studio', aMovedTogether)) === null,
    String(assertLayoutContract(rec, pluginRectRel('studio', aMovedTogether))))
}

console.log('\n— ⑧ 比较范围缩水必须报"覆盖不足"，不能继续宣称一致 —')
{
  // 审核方第十轮第二条：把比较高度缩到 31 个截图像素、丢掉基准 789 行之后，
  // 原本能检出的 1600 像素变化变成 diff=0、same=true。
  const A = makeShot(1426, 807, 521, 78)
  const B = makeShot(1426, 807, 521, 78, { regressAt: [40, 300, 80, 340] })   // 回归点在 ry≈300
  const gFull = { cssWidth: 1426, rect: { x0: 515, x1: 1085, y0: 74, y1: 678 }, masks: [] }
  const rFull = compareStableImages(A, B, '03-settings-studio', gFull, gFull, { expectCompared: { width: 570, height: 604 } })
  ok('正常例：完整范围下 1600 像素变化被检出，且 coverage.ok=true',
    rFull.same === false && rFull.coverage.ok === true, 'diff=' + rFull.diff)

  // 坏例：当前侧框被缩到 31 行 ⇒ 丢基准 573 行
  const gShrunk = { cssWidth: 1426, rect: { x0: 515, x1: 1085, y0: 74, y1: 105 }, masks: [] }
  const rShrunk = compareStableImages(A, B, '03-settings-studio', gFull, gShrunk, { expectCompared: { width: 570, height: 604 } })
  ok('★ 缩水 ⇒ coverage.ok=false（不再静默判一致）', rShrunk.coverage.ok === false,
    'reason=' + (rShrunk.coverage.reason || ''))
  ok('★ 缩水 ⇒ same=false（不会输出"一致"）', rShrunk.same === false, 'same=' + rShrunk.same)
  ok('★ 缩水原因里写明了高度差与录制尺寸',
    /高度/.test(rShrunk.coverage.reason || '') && /604/.test(rShrunk.coverage.reason || ''),
    rShrunk.coverage.reason)

  // 坏例②：两侧**一起**缩水（上面那条查不出来）⇒ 靠"与录制尺寸比"兜住
  const rBoth = compareStableImages(A, B, '03-settings-studio', gShrunk, gShrunk, { expectCompared: { width: 570, height: 604 } })
  ok('★ 两侧一起缩水 ⇒ 仍被判覆盖不足（与录制尺寸不符）',
    rBoth.coverage.ok === false && /录制时 604/.test(rBoth.coverage.reason || ''),
    rBoth.coverage.reason)
}

console.log('\n几何回归：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
