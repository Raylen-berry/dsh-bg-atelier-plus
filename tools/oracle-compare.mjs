// tools/oracle-compare.mjs —— 视觉 oracle 的**比对口径**（纯函数，可被 import）
//
// 为什么单独成文件：这条口径原来只住在 visual-baseline.mjs 里，而那个文件是**可执行脚本**
// （顶层有 await，import 它会直接跑起来并 exit）⇒ 审计脚本没法复用，只好自己复制一份
// `crop()` + `wouldDetect()`。审核方指出：两份实现已经漂移 —— 审计脚本还是"先裁剪、再缩放"
// （旧顺序），而真实路径早已改成"先归一尺度、再裁剪"，于是**审计的 11/11 根本没测真实路径**。
//
// 现在把口径抽到这里，visual-baseline 与 audit 都 import 它 ⇒ 只有一份实现，不会漂移。
// 本文件**不执行任何东西**（纯导出），可以安全 import。

import fs from 'node:fs'
import { decodePng, encodePng, resizePixels, comparePngEither } from '../../dsh-browser-live/pixdiff.js'

/** 只比视口上方这么多（底部是宿主状态栏实时计数 + 装饰粒子，天然不可复现）。 */
export const STABLE_KEEP_RATIO = Number(process.env.VB_STABLE_RATIO || 0.80)

/**
 * 每通道允许的抖动。**默认 0 = 严格逐字节**（审核方复核后从 5 改回）。
 *
 * ⚠️ 这里记录一段**被推翻的论证**，后来者别再走一遍：
 *
 * 我一度设成 5，理由是"03 稳定报约 11794 像素差异，分档后 Δ>5 的像素数为 0，所以容差 5 安全"。
 * **这个论证是错的** —— 它只证明了**单点**灵敏度，没证明**大面积低幅变化**会被发现。
 * 审核方把整个保留区 680560 个像素每通道统一 +5，真实比较函数仍报 `same=true, diff=0`。
 * 我复现确认：整区 +1/+2/+5 → same=true（**全部漏掉**）；整区 +6 → 才抓到。
 *
 * `maxDiffRatio=0` 约束的是**超过阈值之后**的差异比例，挡不住"所有像素都恰好没超阈值"。
 * 而"整屏偏色、每通道几级"恰恰是绘制类重构最容易出的错（主题染色/遮罩/透明度算错都这样）
 * ——**正好落在容差盲区里**。
 *
 * 所以默认 0：宁可让 03 因抗锯齿抖动偶发报红（可见、可解释、可重跑），
 * 也不让"整屏偏色"静默通过。要放宽必须显式 `VB_TOLERANCE=5`，
 * 且**结论只能写"在指定容差内一致"**，不能再说成"一致"。
 */
export const PIXEL_TOLERANCE = Number(process.env.VB_TOLERANCE || 0)

/**
 * **容差取舍的实测数据**（给后来者一个明确的两难，而不是含糊的"安全"）：
 *
 * | 设置 | 整屏每通道 +1/+2/+5（绘制类错误的典型形态） | 03 状态的抗锯齿抖动 |
 * |---|---|---|
 * | `0`（当前默认） | **全部抓到** | 实测约 11794 像素、**maxΔ=4**、全部 ≤5 ⇒ 约每 3 次跑挂 1 次 |
 * | `5` | **全部漏掉**（same=true） | 稳定通过 |
 *
 * 选 0 的理由：整屏几级的偏色（主题染色/遮罩/透明度算错）是**绘制核心重构最可能出的错**，
 * 而它正好落在容差盲区里；抗锯齿抖动则是**可见、可解释、可重跑**的。
 * 宁可偶发报红让人看一眼，也不要静默放过整屏偏色。
 *
 * 提交说明里必须写"**严格逐字节**"还是"**在容差内一致**" —— 脚本的结论文案已按此分档。 */

/**
 * 坐标系的**唯一约定**（这一条是被审核方抓出来的严重错误后补的）：
 *
 * ⚠️ **本文件里所有 x/y 数字一律是 CSS 像素**（`getBoundingClientRect()` 那套坐标），
 *    比较前必须乘 devicePixelRatio 换算到截图像素。
 *
 * 原来的错误：我把 CSS 坐标写进表里，而 cropStable 用 `scale = img.width / REF_WIDTH`
 * 换算 —— 而 REF_WIDTH=1654 恰好等于截图宽度 ⇒ scale=1.0 ⇒ **根本没换算**。
 * 于是 CSS 的 1085（面板右边界）被当成截图像素的 1085 用，实际只裁到 CSS x≈930，
 * **整个裁剪范围偏小 16.7%**；「＋图单」「动态壁纸」等按钮全在裁剪外，改色也报 diff=0。
 * 我此前"其余按钮照常严格比较"的说法因此**不成立**，已撤回。
 *
 * 实测本机：innerWidth=1418 CSS、截图宽 1654 px ⇒ dpr = 1654/1418 ≈ 1.1664。
 * 所以基准视口的 CSS 宽度是 **1418**，不是 1654。
 */
/** 基准视口的 **CSS** 宽度（截图宽 = 它 × dpr）。换算锚点用它，不用截图像素数。 */
export const REF_CSS_WIDTH = Number(process.env.VB_REF_CSS_WIDTH || 1418)
/** 基准视口的 **CSS** 高度（用于纵向比例）。 */
export const REF_CSS_HEIGHT = Number(process.env.VB_REF_CSS_HEIGHT || 776)

/**
 * 每个状态比哪一块 —— **全部是 CSS 坐标**（矩形，不是只有 x）。
 *
 * 为什么从"只有 x 范围 + 固定保留比例"改成"完整矩形"：
 *   03 状态的面板在对话框里，对话框 CSS rect = [309,24,1109,752]。
 *   原来纵向用的是 `STABLE_KEEP_RATIO=0.80`（截图 y0–723 ⇒ CSS y0–620），于是
 *     · **多比了**对话框之上的宿主背景（截图 y0–27 是 modal 遮罩盖在对话上，会变）
 *     · **漏比了**插件面板的下半部分（面板可见到 CSS y752，原来只到 620）
 *   矩形化之后两个毛病一起没有了。各状态矩形都由**实测 getBoundingClientRect** 得出。
 *
 * ⚠️ **这些只是兜底默认值，不是比对口径的真相来源。**
 * 真相来自运行时的 `measureLiveGeom()`（visual-baseline.mjs）—— 从实测锚点推导矩形。
 * 教训（用户第八轮："要可迁移别写死内容，一换就读取不了"）：把绝对坐标写死后，
 * 换个浏览器（Edge→Chrome）窗口 CSS 宽 1418→1426、对话框右移 4px ⇒ 整套失准。
 * 下面的数字保留是为了：① 文档（当初怎么定的）；② 锚点测不到时**明确拒绝**而不是静默用它。
 */
export const STABLE_RECT_BY_STATE = {
  // 侧边栏：CSS x 0–242（x≥243 起是宿主会话列表的"X天前"日期文字，会随时间变）
  // 纵向 0–620：再往下是宿主底部状态栏（"N 轮 M 步 · tok/s"）与装饰粒子，天然在变
  '01-static-wallpaper': { x0: 0, x1: 242, y0: 0, y1: 620 },
  '02-fx-nodes': { x0: 0, x1: 242, y0: 0, y1: 620 },
  // 03：面板 .bga-studio 实测 CSS [521,78,1081,1419]（可滚动，超出视口），
  // 对话框 [309,24,1109,752] 把它裁到 y≤752 ⇒ 取 x 515–1085、y 74–745。
  // y 下沿留 7px：实测 127 个差异像素全落在对话框裁剪底边那两行（宿主取整碎行，非插件内容）。
  '03-settings-studio': { x0: 515, x1: 1085, y0: 74, y1: 745 },
}

/** 兼容旧的只取 x 的用法（审计脚本曾用）。 */
export const STABLE_X_BY_STATE = Object.fromEntries(
  Object.entries(STABLE_RECT_BY_STATE).map(([k, v]) => [k, [v.x0, v.x1]]))
const DEFAULT_RECT = { x0: 0, x1: 242, y0: 0, y1: 620 }

/**
 * **运行时几何核对**：只断言**与窗口尺寸无关的量**——元素自己的宽高（插件的固有布局）。
 * ⚠️ 原来这里断言的是绝对位置 l/t/r，于是换个浏览器窗口一偏 4px 就把整个 oracle 判死；
 *    位置本来就该由 measureLiveGeom() 实测跟随，不是契约。
 *    宽度变了才说明布局真的坏了。容差 ±3 CSS px 吸收亚像素/滚动条抖动。
 */
export const EXPECT_GEOMETRY = {
  // 只约定**与窗口无关**的量：面板自己的宽度（插件固有布局，实测 560 CSS px）。
  // 不再约定 l/t/r —— 位置随窗口尺寸变，由 measureLiveGeom() 每次实测跟随。
  '03-settings-studio': { sel: '.bga-studio', w: 560 },
}

/** @deprecated 保留导出名兼容旧引用；换算锚点改用 REF_CSS_WIDTH（见坐标系约定）。 */
export const REF_WIDTH = REF_CSS_WIDTH

/**
 * 会话列表里**随时间变化的文字**——要屏蔽掉，但不能整块不要。
 *
 * 踩过两次同一个坑（两次都是"跨天之后 oracle 天天报红，且与改动无关"）：
 *   · 第一次：x283–300 那列是列表右侧的"X天前"标签 ⇒ 收右边界到 282 解决。
 *   · 第二次（隔了两天再跑）：列表项里还有**日期文字本身**（"1天"→"3天"），
 *     位置在 x24–97、y616–631 —— 那**在裁剪区内**，收边界解决不了。
 * 会话列表是宿主画的，它的相对时间必然随时间变 ⇒ 这些像素**不该参与**视觉回归。
 * 但整块排除会连带丢掉底图插件的 orb 与主题染色（它们就在同一列区域）。
 * 所以按**坐标框**屏蔽（不是整块不要）：只把那几行文字所在的窄条涂成中性色，
 * 两侧与底部的插件像素照常比较。
 *
 * 增加新框的判据：若某次差异全部落在一个与插件无关的固定小矩形里、且跨天/跨时段复现，
 * 就在这里加一条，并写清"是什么元素、为什么与插件无关"。
 */
export const MASK_RECTS = {
  // 会话列表项里的日期/时间文字（宿主），随日期变（实测 "1天"→"3天"）
  // **CSS 坐标**：x 0–94、y 523–549（截图值 ÷ dpr 1.1664 换算而来）
  '01-static-wallpaper': [[0, 523, 94, 549]],
  '02-fx-nodes': [[0, 523, 94, 549]],
  // 03 设置页：面板头部的**大图预览框**要屏蔽 —— 见 PREVIEW_BOX 注释。
  // .bga-hero 实测 CSS rect=[521,152,560,204]，这里取 x 515–1088、y 148–362（含余量）。
  '03-settings-studio': [[515, 148, 1088, 362]],
}

/**
 * 大图预览框的位置（**CSS 坐标**；`.bga-hero` 实测 rect=[521,152,560,204] + 余量）。
 *
 * 实测观察（审核方要求"先定位抖动、别急着下结论"）：
 *   · `.bga-hero-image` 用的是 **`cur.url` 原图**（9744×4500 ≈ 43 MP），CSS `object-fit:cover`
 *     缩到 **558×202 CSS**，缩放倍率 **17.46×**；
 *   · **同一会话内连截 4 张** ⇒ 预览区 diff=0；
 *   · **刷新页面后再截** ⇒ diff=11618、maxΔ=3（小但非零）。
 *   ⇒ 差异与"刷新"相关。**目前只能列为候选原因**（审核方指出：尚不足以排除其他绘制差异）。
 *     要坐实需补一个用中等尺寸图的对照状态。
 *
 * 若要真正验证预览取景，应**另加一个用中等尺寸图的稳定状态**做对照，而不是放宽容差 ——
 * 放宽容差会连"整屏偏色"一起放过（那个教训见 PIXEL_TOLERANCE 注释）。
 */
export const PREVIEW_BOX = { x0: 515, y0: 148, x1: 1088, y1: 362 }

/**
 * CSS 坐标 → 截图像素的比例。
 *
 * ⚠️ cssWidth **必须由调用方实测传入**（页面的 innerWidth），别只吃 REF_CSS_WIDTH。
 * 教训（审核方第八轮 / 用户指出"要可迁移别写死"）：我把 1418 写死后，
 * 换浏览器（Edge→Chrome）窗口变成 CSS 1426 / 截图 1664，绝对坐标整套失准。
 * REF_CSS_WIDTH 只作为"没传时"的兜底默认，不是真相来源。
 */
export function cssScale(img, cssWidth = REF_CSS_WIDTH) {
  const w = Number(cssWidth) > 0 ? Number(cssWidth) : REF_CSS_WIDTH
  return img.width / w
}

/**
 * **纯函数**：从实测锚点推导这一次的比较几何（可离线单测，不依赖页面）。
 *
 * ⚠️ 核心设计（审核方第十轮两条漏检的根因都在这里）：
 *   **裁剪框必须锚在"宿主容器"上，不能锚在插件自己身上。**
 *   锚在插件上会发生这种事：视口与宿主对话框都没动、只有插件自己横移 12px ⇒
 *   两边的裁剪框各自跟着插件走 ⇒ 内容被重新对齐 ⇒ **same=true、diff=0（漏检）**。
 *   离线复现：跟着插件锚点 diff=0；把框钉在宿主上、同一份图 diff=338400。
 *
 *   所以规则是：
 *     · `rect` = 宿主锚点（对话框 / 左侧栏列）四边**按 rel 内缩**；`rel` 在录制时定下并记进基准；
 *     · 插件自己的位置/尺寸**不参与裁剪**，而是当作**断言对象**（见 assertLayoutContract）。
 *   这样"宿主随窗口移动"被 rel 吸收（可迁移成立），"插件自身布局错了"会露成像素差异 +
 *   布局契约报错，两条都不会被静默吃掉。
 *
 * 另：锚点缺失 ⇒ 返回 null，由调用方大声失败，绝不静默回落到常量去比错地方。
 *
 * @param stateName 状态名
 * @param a         本次实测锚点 {w,h,dlg,studio,hero,sidebar,volatile,plugin}
 * @param rel       **基准录制时**记下的内缩量（比对时传它；录制时传 undefined）
 *                  形状 {left,top,right,bottom,masks}，masks 是相对裁剪框左上角的 CSS 偏移
 */
export function deriveGeom(stateName, a, rel) {
  if (!a || !(a.w > 0)) return null
  const cssWidth = a.w
  if (stateName === '03-settings-studio') {
    if (!a.dlg) return null
    const host = a.dlg
    if (rel) {
      return {
        cssWidth, hostKind: 'dialog', host, rel,
        rect: { x0: host.l + rel.left, y0: host.t + rel.top, x1: host.r - rel.right, y1: host.b - rel.bottom },
        masks: rel.masks || [],
      }
    }
    // 录制：在对话框内缩 6/4/6/7 —— bottom 那 7px 是宿主裁剪边的取整碎行
    //（实测 127 个 Δ≤2 差异全落在 min(面板底,对话框底) 那两行，属宿主几何边界、非插件内容）
    const rect = { x0: host.l + 6, y0: host.t + 4, x1: host.r - 6, y1: host.b - 7 }
    // 屏蔽框 = **壁纸位图表面**（大图预览 hero + 图库缩略图）。
    // 为什么必须屏蔽：它们把几 MP~43MP 的原图缩到几百 px，**跨刷新重采样不完全可复现** ——
    // 实测 hero 刷新后 diff=11618/Δ3；图库缩略图带 diff=2185/Δ≤7。这属于浏览器缩放位图的
    // 非确定性，不是插件逻辑（插件逻辑的变化是几十~几万像素、Δ 常常 >20）。
    // ⚠️ 这是**明确的盲区**，必须记进文档：屏蔽区内的变化看不见（要覆盖只能另加稳定状态）。
    const absMasks = []
    if (a.hero) absMasks.push([a.hero.l - 2, a.hero.t - 2, a.hero.r + 2, a.hero.b + 2])
    for (const s of (Array.isArray(a.imgSurfaces) ? a.imgSurfaces : [])) {
      absMasks.push([s.l, s.t, s.r, s.b])
    }
    // 屏蔽框存成**相对裁剪框**的偏移 ⇒ 宿主移动时它跟着走，不会因为绝对坐标漂移而遮错地方
    const relMasks = absMasks.map(([x0, y0, x1, y1]) => [x0 - rect.x0, y0 - rect.y0, x1 - rect.x0, y1 - rect.y0])
    return {
      cssWidth, hostKind: 'dialog', host, rect, masks: relMasks,
      rel: { left: rect.x0 - host.l, top: rect.y0 - host.t, right: host.r - rect.x1, bottom: host.b - rect.y1, masks: relMasks },
    }
  }
  // 01/02：宿主锚点 = 左侧栏列
  if (!a.sidebar) return null
  const host = a.sidebar
  if (rel) {
    return {
      cssWidth, hostKind: 'sidebar', host, rel,
      rect: { x0: host.l + rel.left, y0: host.t + rel.top, x1: host.r - rel.right, y1: host.b - rel.bottom },
      masks: rel.masks || [],
    }
  }
  // 录制：右边界要避开**随时间变**的那一列
  // ⚠️ volatile 标签实测文本是 "6分钟"（**没有"前"字**）。按"X天前"匹配会漏掉整列，
  //    回落到"侧栏右−8"就会把时间列圈进比较区 ⇒ "6分钟"→"7分钟" 报 397 像素假回归。
  const vol = Array.isArray(a.volatile) ? a.volatile : []
  const volLeft = vol.length ? Math.min(...vol.map((v) => v.l)) : null
  const x1 = volLeft != null ? Math.min(volLeft - 1, host.r - 8) : host.r - 8
  // 纵向覆盖到插件自己画的东西（orb / dock 特效），上下各留 24px 把周围透出壁纸的区域也带上。
  // ⚠️ 以前按视口高度切 y0..h-156 ⇒ 插件 orb（实测 CSS y724–751）整个落在区域**之外**，
  //    那两张状态比的全是宿主装饰（审核方第九/十轮都点到这个覆盖问题）。
  //    注意：这里用插件元素**决定覆盖范围**，但**比对时**框由 rel 重建 —— 覆盖范围不是锚点。
  const plug = Array.isArray(a.plugin) ? a.plugin : []
  if (!plug.length) return null
  const pTop = Math.min(...plug.map((p) => p.t))
  const pBot = Math.max(...plug.map((p) => p.b))
  const rect = {
    x0: host.l, x1: Math.max(host.l + 40, Math.round(x1)),
    y0: Math.max(0, pTop - 24), y1: Math.min(host.b, pBot + 24),
  }
  if (rect.y1 - rect.y0 < 8) return null
  return {
    cssWidth, hostKind: 'sidebar', host, rect, masks: [],
    rel: { left: rect.x0 - host.l, top: rect.y0 - host.t, right: host.r - rect.x1, bottom: host.b - rect.y1, masks: [] },
  }
}

/**
 * 把"插件自己"的矩形换算成**相对宿主**的量（尺寸 + 左/上/下偏移）——布局契约的断言对象。
 * pluginKind='studio' 用对话框作宿主；'sidebar' 用侧栏列。
 */
export function pluginRectRel(pluginKind, a) {
  const host = pluginKind === 'studio' ? a.dlg : a.sidebar
  if (!host) return null
  if (pluginKind === 'studio') {
    if (!a.studio) return null
    return {
      w: a.studio.r - a.studio.l, h: a.studio.b - a.studio.t,
      left: a.studio.l - host.l, top: a.studio.t - host.t, bottom: host.b - a.studio.b,
    }
  }
  const plug = Array.isArray(a.plugin) ? a.plugin : []
  if (!plug.length) return null
  const l = Math.min(...plug.map((p) => p.l)), r = Math.max(...plug.map((p) => p.r))
  const t = Math.min(...plug.map((p) => p.t)), b = Math.max(...plug.map((p) => p.b))
  return { w: r - l, h: b - t, left: l - host.l, top: t - host.t, bottom: host.b - b }
}

/**
 * 布局契约断言：插件自己相对宿主的偏移与录制时相比不许漂（容差 tol CSS px）。
 * 返回 null=通过；字符串=失败原因（带数字，便于定位）。
 * 这条是"可迁移性不许把真错误吃掉"的另一半：rel 负责吸收宿主移动，本函数负责抓住插件移动。
 */
export function assertLayoutContract(recorded, current, tol = 3) {
  if (!current) return '当前测不到插件自己的元素，无法核对布局契约'
  if (!recorded) return null   // 旧基准没记 ⇒ 不因此失败（调用方另行提示）
  const bad = []
  for (const k of ['w', 'h', 'left', 'top', 'bottom']) {
    const d = (current[k] ?? 0) - (recorded[k] ?? 0)
    if (Math.abs(d) > tol) bad.push(`${k} ${recorded[k]}→${current[k]}（Δ${d > 0 ? '+' : ''}${d}）`)
  }
  return bad.length ? `插件相对宿主的布局漂移：${bad.join('、')}` : null
}

/** 取本次比对用的几何：调用方实测的 geom 优先，表里常量兜底。 */
function resolveGeom(stateName, geom) {
  return {
    rect: (geom && geom.rect) || STABLE_RECT_BY_STATE[stateName] || DEFAULT_RECT,
    // masks 用 "!== undefined" 判断：实测"这个状态没有需要屏蔽的框"是合法结果，
    // 不能被 `||` 误当成"没传"而回落到表里的常量框。
    masks: geom && geom.masks !== undefined ? geom.masks : (MASK_RECTS[stateName] || []),
    cssWidth: geom && geom.cssWidth ? geom.cssWidth : REF_CSS_WIDTH,
  }
}

/** CSS 矩形 → 该图的设备像素框（含 clamp）。 */
function deviceBox(img, rect, cssWidth) {
  const s = cssScale(img, cssWidth)
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(rect.x0 * s)))
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(rect.x1 * s)))
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(rect.y0 * s)))
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.round(rect.y1 * s)))
  return { x0, y0, w: x1 - x0, h: y1 - y0 }
}

/** 按设备像素框取数据，并把 masks（CSS 坐标）涂成中性灰 —— 双方一致 ⇒ 该处永不产生差异。 */
function extract(img, box, masks, cssWidth) {
  const s = cssScale(img, cssWidth)
  const out = Buffer.alloc(box.w * box.h * 4)
  for (let y = 0; y < box.h; y++) {
    img.data.copy(out, y * box.w * 4, ((y + box.y0) * img.width + box.x0) * 4,
      ((y + box.y0) * img.width + box.x0) * 4 + box.w * 4)
  }
  for (const [mx0, my0, mx1, my1] of masks) {
    const a = Math.max(0, Math.round(mx0 * s) - box.x0), b = Math.min(box.w, Math.round(mx1 * s) - box.x0)
    const c = Math.max(0, Math.round(my0 * s) - box.y0), d = Math.min(box.h, Math.round(my1 * s) - box.y0)
    for (let y = c; y < d; y++) {
      for (let x = a; x < b; x++) {
        const o = (y * box.w + x) * 4
        out[o] = 128; out[o + 1] = 128; out[o + 2] = 128; out[o + 3] = 255
      }
    }
  }
  return { width: box.w, height: box.h, channels: 4, data: out }
}

/**
 * 只保留稳定区（按状态矩形裁剪 + 屏蔽随时间变的框）。
 *
 * `geom`（可选，**优先于表里的常量**）：{ rect:{x0,x1,y0,y1}, masks:[[x0,y0,x1,y1]…], cssWidth }
 * —— 由调用方在**运行时从实测锚点导出**（见 visual-baseline.mjs 的 measureLiveGeom）。
 * 表里的常量只是兜底/文档；真正比对用实测值，这样**换窗口尺寸/换浏览器仍然成立**。
 */
export function cropStable(img, stateName, geom) {
  const g = resolveGeom(stateName, geom)
  return extract(img, deviceBox(img, g.rect, g.cssWidth), g.masks, g.cssWidth)
}

/** 读 PNG → 裁稳定区。 */
export function stableFrom(file, stateName, geom) {
  return cropStable(decodePng(fs.readFileSync(file)), stateName, geom)
}

/**
 * 跨 DPI 比对：**先把两张图归一到同一尺度、再各自裁剪**，最后逐像素比。
 *
 * 为什么不沿用"各自裁剪 → 交给归一化"（那会误报）：实测同一张图，基准 1.0x、当前 1.25x，
 * 各自裁剪得 282×724 与 353×904（宽高比 0.38950 vs 0.39049 已不同），再归一 ⇒ 报
 * **70.81% 差异、maxΔ=88**，而两张图内容完全一样。根因是 resizePixels 的采样式
 * `sx=(x+0.5)*xRatio-0.5` 对两条路径给出不同相位（0.799 vs 0.800）、加上宽高各自 round
 * 的比例漂移，在壁纸纹理这类高频区域就是几十级色差。
 * 同尺寸时退回精确比（不重采样）。
 *
 * 接受**内存里的图像对象**（不是文件），这样调用方可以先改像素再比 —— 审计脚本要植入变化。
 */
/**
 * 跨 DPI / 跨窗口比对。
 *
 * ⚠️ **覆盖不许静默缩水**（审核方第十轮第二条漏检）：
 *   上一版直接 `w=min(boxA.w,boxB.w), h=min(boxA.h,boxB.h)` 拿交集比，
 *   且没有任何下限 ⇒ 把当前比较高度缩到 31 个截图像素、丢掉基准 789 行之后，
 *   原本能检出的 1600 像素变化变成 **diff=0、same=true**，还照样宣称"一致"。
 *   离线复现：正常范围 diff=1600（检出）；缩到 31 行 diff=0（漏检），dropped 记了 573 行却没人看。
 *
 *   现在：两侧框不齐 ⇒ 直接判 `coverage.ok=false` 并**列出缺在哪**；
 *   再由调用方把"覆盖不足"当**失败**报出去（非零退出），而不是当"一致"。
 */
export function compareStableImages(imgA, imgB, stateName, geomA, geomB, opts2 = {}) {
  const opts = { tolerance: PIXEL_TOLERANCE, maxDiffRatio: 0, allowScale: false }
  const gA = resolveGeom(stateName, geomA)
  const gB = resolveGeom(stateName, geomB)
  const scA = cssScale(imgA, gA.cssWidth)
  const scB = cssScale(imgB, gB.cssWidth)
  let A = imgA, B = imgB, resampled = false
  if (Math.abs(scA - scB) > 1e-6) {
    // 归一到**同一个"每 CSS 像素的设备像素数"**，再各自裁剪。
    // 顺序不能反：先裁后缩会让两条路径的采样相位不同 ⇒ 实测误报 70.81%（见上方注释）。
    const S = Math.max(scA, scB)
    A = resizePixels(imgA, Math.max(1, Math.round(gA.cssWidth * S)), Math.max(1, Math.round(imgA.height * S / scA)))
    B = resizePixels(imgB, Math.max(1, Math.round(gB.cssWidth * S)), Math.max(1, Math.round(imgB.height * S / scB)))
    resampled = true
  }
  const boxA = deviceBox(A, gA.rect, gA.cssWidth)
  const boxB = deviceBox(B, gB.rect, gB.cssWidth)

  // —— 覆盖校验（三条，任何一条不过就是"覆盖不足"，不是"一致"）——
  const COVER_TOL = Number(opts2.coverTol || 2)          // 允许的像素级抖动
  const problems = []
  if (Math.abs(boxA.w - boxB.w) > COVER_TOL) problems.push(`宽度 ${boxA.w} vs ${boxB.w}`)
  if (Math.abs(boxA.h - boxB.h) > COVER_TOL) problems.push(`高度 ${boxA.h} vs ${boxB.h}`)
  // 与基准**录制时记下的**比较尺寸比（防止两侧一起缩水 —— 那种情况上面两条查不出来）
  const exp = opts2.expectCompared
  if (exp && exp.width > 0 && exp.height > 0) {
    if (Math.abs(boxA.w - exp.width) > COVER_TOL) problems.push(`基准侧宽度 ${boxA.w} ≠ 录制时 ${exp.width}`)
    if (Math.abs(boxA.h - exp.height) > COVER_TOL) problems.push(`基准侧高度 ${boxA.h} ≠ 录制时 ${exp.height}`)
  }
  if (problems.length) {
    return {
      same: false, diff: -1, total: -1, ratio: 0, maxChannelDelta: 0,
      resampled, tolerance: PIXEL_TOLERANCE,
      coverage: { ok: false, reason: problems.join('；'), boxA, boxB, expected: exp || null },
      compared: { width: Math.min(boxA.w, boxB.w), height: Math.min(boxA.h, boxB.h) },
      dropped: { a: { w: boxA.w - Math.min(boxA.w, boxB.w), h: boxA.h - Math.min(boxA.h, boxB.h) },
                 b: { w: boxB.w - Math.min(boxA.w, boxB.w), h: boxB.h - Math.min(boxA.h, boxB.h) } },
      sizedFrom: { a: { width: imgA.width, height: imgA.height }, b: { width: imgB.width, height: imgB.height } },
    }
  }

  const w = boxA.w, h = boxA.h
  const cropA = extract(A, { x0: boxA.x0, y0: boxA.y0, w, h }, gA.masks, gA.cssWidth)
  const cropB = extract(B, { x0: boxB.x0, y0: boxB.y0, w, h }, gB.masks, gB.cssWidth)
  const cmp = comparePngEither(encodePng(cropA), encodePng(cropB), opts)
  return {
    ...cmp, resampled, tolerance: PIXEL_TOLERANCE,
    coverage: { ok: true, boxA, boxB, expected: exp || null },
    compared: { width: w, height: h },
    dropped: { a: { w: 0, h: 0 }, b: { w: 0, h: 0 } },
    sizedFrom: { a: { width: imgA.width, height: imgA.height }, b: { width: imgB.width, height: imgB.height } },
  }
}

/** 便捷：直接吃两个文件路径。geomA/geomB 分别是**各自那一次运行**实测出的几何。 */
export function compareStableFiles(baseFile, nowFile, stateName, geomA, geomB, opts2) {
  return compareStableImages(
    decodePng(fs.readFileSync(baseFile)), decodePng(fs.readFileSync(nowFile)), stateName, geomA, geomB, opts2)
}

/** 在图上涂一块纯色（审计用来"植入一个已知变化"）。 */
export function paint(img, x0, y0, x1, y1, rgb) {
  const out = { width: img.width, height: img.height, channels: 4, data: Buffer.from(img.data) }
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * 4
      out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = 255
    }
  }
  return out
}

// ---------------------------------------------------------------- 纯决策函数（可离线单测）
//
// 这两个原本写在 visual-baseline.mjs 里，而那个文件是**可执行脚本**（顶层有 await，
// import 会直接跑起来并 exit）⇒ 没法单测。审核方要求"把这两个场景补进离线回归测试"，
// 所以把判断逻辑抽到这里（纯函数、无副作用），由 visual-baseline 调用、由离线测试覆盖。

/**
 * 合法设置对象的判据（宿主读失败会返回 `{}` 且 HTTP 仍是 200 —— 见 host 的 readSettings：
 * `catch { return {} }`。所以**只检查"是对象"远远不够**，`{}` 恰好是对象）。
 *
 * 判据：非 null、是对象、不是数组、且**至少含一个已知设置键**。
 * "至少一个已知键"这条与插件自己的 load() 闸门同思路（它写 `patch.effect !== undefined`）。
 *
 * 审核方用真实 readSettings 复现过两条丢设置路径，都因 `{}` 骗过了"是对象"检查：
 *   ① 首次 GET 返回 `{}`（读失败）⇒ 被当合法原值 ⇒ 钉图写入 autoOn=false ⇒
 *      还原时 `{}`.autoOn !== true 判"无需还原" ⇒ **exit=0，轮播被留在关**。
 *   ② 原本关着轮播 + 钉图自己的 GET 返回 `{}` ⇒ `{...{}, autoOn:false, wallpaper}` ⇒
 *      **26 字段被写成 2 字段**，exit=0。
 */
const SETTINGS_KEYS = [
  'autoOn', 'autoMin', 'wallpaper', 'effect', 'accent', 'deep', 'veil', 'glass',
  'cardA', 'cardBlur', 'cardShadow', 'focus', 'zoom', 'preset',
  'fadeOn', 'fadeDelayMs', 'fadeMs',
  'playbackSource', 'playbackMode', 'playlists', 'recent', 'imageFraming',
  'weId', 'weMode', 'weQuality', 'styles',
]
export function isValidSettings(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  let known = 0
  for (const k of SETTINGS_KEYS) if (k in v) known++
  return known >= 1
}

/**
 * 从"冻结前读到的原始设置 JSON 文本"判断**是否需要还原**。
 *   'skip'      —— 无可还原的原值（当初就没冻结成功，**或读到的不是合法设置**）
 *   'not-needed' —— 用户原本就关着轮播，我们从未改动它 ⇒ 无需还原、**也不算失败**
 *   'need'      —— 确实需要还原
 *
 * 为什么要区分后两者：原来只返回布尔，调用方写 `!== true` ⇒ "用户原本就关着"被误报成
 * **还原失败**，一次正常运行的退出码变成 5（审核方模拟复现）。
 *
 * ⚠️ `{}`（宿主读失败的样子）在这里判 'skip' 而不是 'not-needed'：读不到 ⇒ 没有可靠原值
 * ⇒ 什么也别说。配合 isValidSettings 守卫（拿不到合法原值就不许写），这条路径上我们
 * **从未写入**，所以 'skip' 是事实陈述。
 */
export function rotationRestoreNeed(beforeRaw) {
  if (!beforeRaw) return 'skip'
  let want = null
  try { want = JSON.parse(beforeRaw) } catch { want = null }
  // 数组也要排除：`typeof [] === 'object'`。这个漏洞是离线套件测出来的。
  if (!isValidSettings(want)) return 'skip'
  if (want.autoOn !== true) return 'not-needed'
  return 'need'
}

/**
 * 还原结果判定：把"是否需要还原"与"磁盘/内存的实测状态"合成三态结论。
 *   'restored' —— 已还原，或本来就不需要还原（都算成功）
 *   'skipped'  —— 无可还原（当初没冻结成功）—— 不算失败
 *   'failed'   —— 需要还原但没成功（磁盘或内存不符、或刷新失败）—— **调用方须置失败码**
 */
export function judgeRotationRestore(need, { diskOk, memKnown, memOk, reloadFailed } = {}) {
  if (need === 'skip') return 'skipped'
  if (need === 'not-needed') return 'restored'
  const ok = diskOk === true && reloadFailed !== true && memOk === true && memKnown !== false
  return ok ? 'restored' : 'failed'
}