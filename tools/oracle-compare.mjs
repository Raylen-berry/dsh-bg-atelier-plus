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

/** 每个状态比哪一块（理由见 visual-baseline.mjs）。 */
export const STABLE_X_BY_STATE = {
  '01-static-wallpaper': [0, 282],
  '02-fx-nodes': [0, 282],
  // 右边界 **1085**（此前 1300 → 1280 都是错的）。
  // 实测：设置面板 .bga-studio 的实际右边界是 **x=1081**（studioWidth=560）。
  // 原来比到 1280/1300，那段其实落在宿主对话框的遮罩 DIV.wCInkW_mask 上 ——
  // **不是插件画的东西**，而且不稳定（那条带实测 diff=22163、maxΔ=41），
  // 会随宿主的遮罩/滚动条渲染而变，于是 03 反复报差异。
  // 定位手法：document.elementFromPoint(1200, y) 在全高都返回 wCInkW_mask ⇒ 说明越界。
  '03-settings-studio': [340, 1085],
}
const DEFAULT_X = [0, 282]

/** 基准视口宽，用来把竖切坐标按比例换算到别的尺寸。 */
export const REF_WIDTH = 1654

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
  '01-static-wallpaper': [[0, 610, 110, 640]],
  '02-fx-nodes': [[0, 610, 110, 640]],
  // 03 设置页：面板头部的**大图预览框**要屏蔽 —— 见 PREVIEW_BOX 注释。
  // 它不是"宿主的东西"，而是"浏览器对 43MP 图的重采样跨刷新不确定"（实测 diff=11618、maxΔ=3，
  // 而同会话内连截 4 张是 diff=0）。面板其余像素（布局/导航/文字/按钮）照常比较。
  '03-settings-studio': [[515, 148, 1088, 362]],
}

/**
 * 大图预览框的位置（`.bga-hero` 外框 + 余量），仅作说明与文档用（屏蔽已写进 MASK_RECTS）。
 *
 * 实测结论（审核方要求"先定位抖动、别急着下结论"，结论与我原先的猜测**不同**）：
 *   · `.bga-hero-image` 用的是 **`cur.url` 原图**（9744×4500 ≈ 43 MP），CSS `object-fit:cover`
 *     缩到 **558×202**，缩放倍率 **17.46×**；
 *   · **同一会话内连截 4 张** ⇒ 预览区 diff=0（稳定）；
 *   · **刷新页面后再截** ⇒ diff=11618、maxΔ=3（小但非零）。
 *   ⇒ 不稳定来自"超大图跨刷新的重采样"，**不是**抗锯齿、**不是**内容变化、**不是**淡入未完成
 *     （我查过 opacity=1 且 0→15s 完全不变）。
 *   这一段对"绘制逻辑回归"没有信息量（换张超大图就变），所以屏蔽。
 *
 * 若要真正验证预览取景，应**另加一个用中等尺寸图的稳定状态**，而不是放宽容差 ——
 * 放宽容差会连"整屏偏色"一起放过（那个教训见 PIXEL_TOLERANCE 注释）。
 */
export const PREVIEW_BOX = { x0: 515, y0: 148, x1: 1088, y1: 362 }

/** 只保留稳定区（竖切 + 按 STABLE_KEEP_RATIO 裁底部 + 屏蔽宿主随时间变的文字框）。 */
export function cropStable(img, stateName) {
  const keep = Math.max(1, Math.floor(img.height * STABLE_KEEP_RATIO))
  const range = STABLE_X_BY_STATE[stateName] || DEFAULT_X
  const scale = img.width / REF_WIDTH
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(range[0] * scale)))
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(range[1] * scale)))
  const w = x1 - x0
  const out = Buffer.alloc(w * keep * 4)
  for (let y = 0; y < keep; y++) {
    img.data.copy(out, y * w * 4, (y * img.width + x0) * 4, (y * img.width + x0) * 4 + w * 4)
  }
  // 屏蔽（在**裁剪后**的坐标系里，按同样比例换算）；涂中性灰，双方一致 ⇒ 该处永不产生差异
  for (const [mx0, my0, mx1, my1] of (MASK_RECTS[stateName] || [])) {
    const a = Math.max(0, Math.round(mx0 * scale) - x0), b = Math.max(0, Math.round(mx1 * scale) - x0)
    const c = Math.max(0, Math.round(my0 * scale)), d = Math.min(keep, Math.round(my1 * scale))
    for (let y = c; y < d; y++) {
      for (let x = a; x < b && x < w; x++) {
        const o = (y * w + x) * 4
        out[o] = 128; out[o + 1] = 128; out[o + 2] = 128; out[o + 3] = 255
      }
    }
  }
  return { width: w, height: keep, channels: 4, data: out }
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
 * 从"冻结前读到的原始设置 JSON 文本"判断**是否需要还原**。
 *   'skip'      —— 无可还原的原值（当初就没冻结成功）
 *   'not-needed' —— 用户原本就关着轮播，我们从未改动它 ⇒ 无需还原、**也不算失败**
 *   'need'      —— 确实需要还原
 *
 * 为什么要区分后两者：原来只返回布尔，调用方写 `!== true` ⇒ "用户原本就关着"被误报成
 * **还原失败**，一次正常运行的退出码变成 5（审核方模拟复现）。
 */
export function rotationRestoreNeed(beforeRaw) {
  if (!beforeRaw) return 'skip'
  let want = null
  try { want = JSON.parse(beforeRaw) } catch { want = null }
  // ⚠️ 必须排除数组：`typeof [] === 'object'`，但数组不是合法设置对象。
  // 这个漏洞是**离线套件测出来的**（[1,2] 应判 skip 却走到 not-needed）——
  // 正是"把判断逻辑抽成纯函数才测得到"的价值。插件自己的 load() 也是这么判的
  // （它写 `Array.isArray(saved)` 显式排除）。
  if (!want || typeof want !== 'object' || Array.isArray(want)) return 'skip'
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