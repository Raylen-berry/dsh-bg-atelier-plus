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
 * 每通道允许的抖动（默认 5）。
 *
 * ⚠️ 这是**唯一一条容差**，来历见 visual-baseline.mjs 里的长注释：把滚动条排除后 03 仍稳定
 * 报约 11794 像素差异，分档后 Δ>5 的像素数为 **0**（全是文字抗锯齿抖动）。
 * 只按**每通道幅度**限制，`maxDiffRatio` 仍为 0 —— 不用比例型容差（那会放过一大片同时
 * 变 1 级的像素）。实测不掩盖真回归：Δ=2 放过；Δ=6（刚超）抓到；Δ=20 抓到。
 * `VB_TOLERANCE=0` 回到严格逐字节。
 */
export const PIXEL_TOLERANCE = Number(process.env.VB_TOLERANCE || 5)

/** 每个状态比哪一块（理由见 visual-baseline.mjs）。 */
export const STABLE_X_BY_STATE = {
  '01-static-wallpaper': [0, 282],
  '02-fx-nodes': [0, 282],
  '03-settings-studio': [340, 1280],
}
const DEFAULT_X = [0, 282]

/** 基准视口宽，用来把竖切坐标按比例换算到别的尺寸。 */
export const REF_WIDTH = 1654

/** 只保留稳定区（竖切 + 按 STABLE_KEEP_RATIO 裁底部）。 */
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