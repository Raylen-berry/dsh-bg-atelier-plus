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
 */
export const STABLE_RECT_BY_STATE = {
  // 侧边栏：CSS x 0–242（x≥243 起是宿主会话列表右侧的"X天前"标签列，会随时间变）
  // 纵向 0–620：再往下是宿主底部状态栏（"N 轮 M 步 · tok/s"）与装饰粒子，天然在变
  '01-static-wallpaper': { x0: 0, x1: 242, y0: 0, y1: 620 },
  '02-fx-nodes': { x0: 0, x1: 242, y0: 0, y1: 620 },
  // 03：插件面板 .bga-studio 实测 CSS [521,78,1081,1419]（可滚动，超出视口），
  // 对话框 [309,24,1109,752] 把它裁到 y≤752。取 x 515–1085（含面板边缘余量）、
  // y 74–750（面板可见区，且不含对话框之上的宿主背景）。
  '03-settings-studio': { x0: 515, x1: 1085, y0: 74, y1: 750 },
}

/** 兼容旧的只取 x 的用法（审计脚本曾用）。 */
export const STABLE_X_BY_STATE = Object.fromEntries(
  Object.entries(STABLE_RECT_BY_STATE).map(([k, v]) => [k, [v.x0, v.x1]]))
const DEFAULT_RECT = { x0: 0, x1: 242, y0: 0, y1: 620 }

/**
 * **实测几何**：运行时要核对的元素位置（CSS）。与上表不符 ⇒ 说明面板挪了/没打开，
 * 那时硬编码的裁剪区域就失去意义，必须**大声失败**而不是静默比错地方。
 * 容差 ±3 CSS px 用于吸收亚像素/滚动条出现的抖动。
 */
export const EXPECT_GEOMETRY = {
  '03-settings-studio': { sel: '.bga-studio', l: 521, t: 78, r: 1081 },
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

/** CSS 坐标 → 截图像素的比例（截图宽 / 基准 **CSS** 宽）。 */
export function cssScale(img) { return img.width / REF_CSS_WIDTH }

/** 只保留稳定区（按状态矩形裁剪 + 屏蔽随时间变的框）。
 *  表里数字是 **CSS 坐标**，这里统一乘 cssScale() 换算到截图像素。 */
export function cropStable(img, stateName) {
  const scale = cssScale(img)          // ← 关键：锚点是 CSS 宽度(1418)，不是截图宽度
  const r = STABLE_RECT_BY_STATE[stateName] || DEFAULT_RECT
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(r.x0 * scale)))
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(r.x1 * scale)))
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(r.y0 * scale)))
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.round(r.y1 * scale)))
  const w = x1 - x0, h = y1 - y0
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, ((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0) * 4 + w * 4)
  }
  // 屏蔽（换算到**裁剪后**的局部坐标）；涂中性灰，双方一致 ⇒ 该处永不产生差异
  for (const [mx0, my0, mx1, my1] of (MASK_RECTS[stateName] || [])) {
    const a = Math.max(0, Math.round(mx0 * scale) - x0), b = Math.max(0, Math.round(mx1 * scale) - x0)
    const c = Math.max(0, Math.round(my0 * scale) - y0), d = Math.min(h, Math.round(my1 * scale) - y0)
    for (let y = c; y < d; y++) {
      for (let x = a; x < b && x < w; x++) {
        const o = (y * w + x) * 4
        out[o] = 128; out[o + 1] = 128; out[o + 2] = 128; out[o + 3] = 255
      }
    }
  }
  return { width: w, height: h, channels: 4, data: out }
}

/** 读 PNG → 裁稳定区。 */
export function stableFrom(file, stateName) {
  return cropStable(decodePng(fs.readFileSync(file)), stateName)
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
export function compareStableImages(imgA, imgB, stateName) {
  const opts = { tolerance: PIXEL_TOLERANCE, maxDiffRatio: 0, allowScale: false }
  if (imgA.width === imgB.width && imgA.height === imgB.height) {
    const cmp = comparePngEither(
      encodePng(cropStable(imgA, stateName)), encodePng(cropStable(imgB, stateName)), opts)
    return { ...cmp, resampled: false, tolerance: PIXEL_TOLERANCE }
  }
  const W = Math.max(imgA.width, imgB.width)
  const H = Math.max(imgA.height, imgB.height)
  const upA = resizePixels(imgA, W, H)
  const upB = resizePixels(imgB, W, H)
  const cmp = comparePngEither(
    encodePng(cropStable(upA, stateName)), encodePng(cropStable(upB, stateName)), opts)
  return {
    ...cmp, resampled: true, tolerance: PIXEL_TOLERANCE,
    normalizedTo: { width: W, height: H },
    sizedFrom: {
      a: { width: imgA.width, height: imgA.height },
      b: { width: imgB.width, height: imgB.height },
    },
  }
}

/** 便捷：直接吃两个文件路径。 */
export function compareStableFiles(baseFile, nowFile, stateName) {
  return compareStableImages(
    decodePng(fs.readFileSync(baseFile)), decodePng(fs.readFileSync(nowFile)), stateName)
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