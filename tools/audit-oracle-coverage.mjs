// tools/audit-oracle-coverage.mjs —— oracle 覆盖边界审计（不改基准，只读）
//
// 为什么要这个：`diffRatio=0` 只证明"参与比较的像素一致"。被裁掉、屏蔽、归一化损失的
// 信息**没有验收覆盖** —— 审核方要求把这个能力缺口明确写出来，而不是含糊过去。
//
// 本脚本做三件事（全部只读，不触碰 baselines/before-refactor）：
//   ① 打印每个状态实际比较的区域（坐标 + 尺寸），以及**被排除**的区域；
//   ② 逐区域**植入已知变化**，验证 oracle 的检出能力边界：
//      · 保留区内的小变化是否抓得到（应抓到）
//      · 各排除区内植入大变化是否**抓不到**（诚实地记录这个缺口）
//   ③ 输出一份可交给审核方的覆盖报告。
//
// 用法：node tools/audit-oracle-coverage.mjs [基准目录名，默认 before-refactor]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, comparePngEither } from '../../dsh-browser-live/pixdiff.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.join(HERE, '..', 'baselines', process.argv[2] || 'before-refactor')
const manifest = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'))

// 与 visual-baseline.mjs 保持一致的口径（改那边要同步改这里）
const KEEP_RATIO = Number(process.env.VB_STABLE_RATIO || 0.80)
const X_BY_STATE = {
  '01-static-wallpaper': [0, 282],
  '02-fx-nodes': [0, 282],
  '03-settings-studio': [340, 1300],
}

/** 复刻 visual-baseline 的裁剪口径。 */
function crop(img, stateName) {
  const keep = Math.max(1, Math.floor(img.height * KEEP_RATIO))
  const range = X_BY_STATE[stateName] || [0, 282]
  const scale = img.width / 1654
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(range[0] * scale)))
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(range[1] * scale)))
  const w = x1 - x0
  const out = Buffer.alloc(w * keep * 4)
  for (let y = 0; y < keep; y++) img.data.copy(out, y * w * 4, (y * img.width + x0) * 4, (y * img.width + x0) * 4 + w * 4)
  return { width: w, height: keep, channels: 4, data: out }
}

/** 在图上涂一块纯色（模拟"这里有真实变化"）。 */
function paint(img, x0, y0, x1, y1, rgb) {
  const out = { width: img.width, height: img.height, channels: 4, data: Buffer.from(img.data) }
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * 4
      out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = 255
    }
  }
  return out
}

/** 按 oracle 的口径比两张图，返回是否判"有差异"。 */
function wouldDetect(baseImg, changedImg, stateName) {
  const a = encodePng(crop(baseImg, stateName))
  const b = encodePng(crop(changedImg, stateName))
  const r = comparePngEither(a, b, { allowScale: true, tolerance: 0, maxDiffRatio: 0 })
  return { detected: !r.same, diff: r.diff, ratio: r.ratio }
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

console.log('=== oracle 覆盖边界审计 ===')
console.log('基准目录: ' + BASE)
console.log('口径: 保留高度 ' + (KEEP_RATIO * 100) + '%，竖切 ' + JSON.stringify(X_BY_STATE))

const W = 1654, H = 905
const keptH = Math.floor(H * KEEP_RATIO)

for (const s of manifest.states) {
  const file = path.join(BASE, s.file)
  if (!fs.existsSync(file)) { console.log('\n[' + s.name + '] 缺图，跳过'); continue }
  const img = decodePng(fs.readFileSync(file))
  const [rx0, rx1] = X_BY_STATE[s.name] || [0, 282]

  console.log('\n— ' + s.name + ' —')
  console.log('  整图         : ' + img.width + '×' + img.height + ' = ' + (img.width * img.height) + ' 像素')
  console.log('  参与比较     : x[' + rx0 + ',' + rx1 + '] × y[0,' + (keptH - 1) + '] = ' + ((rx1 - rx0) * keptH) + ' 像素'
    + '（占整图 ' + (((rx1 - rx0) * keptH) / (img.width * img.height) * 100).toFixed(1) + '%）')
  console.log('  **排除**     :')
  console.log('      · x[' + rx1 + ',' + img.width + '] 整高（' + (img.width - rx1) + 'px 宽）—— 会话区/右侧')
  console.log('      · y[' + keptH + ',' + (H - 1) + '] 整宽（' + (H - keptH) + 'px 高）—— 宿主状态栏/装饰粒子')
  if (rx0 > 0) console.log('      · x[0,' + rx0 + '] 整高 —— 设置页状态里的左侧栏')

  // ① 保留区内的小变化：必须抓到（这是"不放水"的核心证据）
  const midX = Math.round((rx0 + rx1) / 2), midY = Math.round(keptH / 2)
  const small = paint(img, midX, midY, midX + 10, midY + 10, [255, 0, 255])
  const rSmall = wouldDetect(img, small, s.name)
  ok('保留区内 10×10 小变化被抓到', rSmall.detected, rSmall.diff + ' 像素')

  // ② 排除区①：右边界之外（会话区）—— 记录缺口
  const outsideX = paint(img, rx1 + 40, midY, rx1 + 140, midY + 100, [255, 0, 255])
  const rOutX = wouldDetect(img, outsideX, s.name)
  ok('【能力缺口·预期抓不到】右边界外 100×100 变化', rOutX.detected === false,
    rOutX.detected ? '意外抓到了 ' + rOutX.diff : '如预期未检出')

  // ③ 排除区②：底部带 —— 记录缺口
  const outsideY = paint(img, midX, keptH + 20, midX + 100, Math.min(H - 1, keptH + 120), [255, 0, 255])
  const rOutY = wouldDetect(img, outsideY, s.name)
  ok('【能力缺口·预期抓不到】底带 100×100 变化', rOutY.detected === false,
    rOutY.detected ? '意外抓到了 ' + rOutY.diff : '如预期未检出')
}

// ④ 跨 DPI 归一化的检出能力：真实变化在跨 DPI 比对下还抓得到吗？
//
// ⚠️ 这里连踩两个坑，都写下来（它们说明"造测试数据"本身就能造出假结论）：
//
// 坑一：**不能自己写一个放大函数**。第一版我用最近邻，而 pixdiff 用双线性 ——
//   两种重采样对同一张源图给出 74% 的差异，"检测到变化"根本不是补丁带来的。
//
// 坑二：**裁剪与缩放谁先谁后，结果不同**。实测同源图像：
//     crop(原图) → 放大 1.25        → 353×905
//     放大 1.25 → crop(放大图)      → 353×904   ← 且内容差 58%、maxΔ=50
//   原因：resizePixels 的采样式 `sx=(x+0.5)*xRatio-0.5` 对"先裁后缩"（xRatio=0.799）
//   与"先缩后裁"（xRatio=0.800）给出**不同相位**，差 0.3 像素；在壁纸纹理这类高频区域，
//   0.3 像素偏移就是几十级色差。⇒ **两种顺序不是同一个变换**，不能混用来造对照。
//
// 正确测法：**裁剪固定在原尺度做一次，缩放只作为最后一步**，这样唯一变量才是补丁本身。
console.log('\n— 跨 DPI 归一化的检出能力（关键：归一化会不会把真实变化抹掉）—')
{
  const { resizePixels } = await import('../../dsh-browser-live/pixdiff.js')
  const s0 = manifest.states[0]
  const img = decodePng(fs.readFileSync(path.join(BASE, s0.file)))
  const factor = 1.25
  // 约定：先在原尺度裁好，再决定是否缩放。整条链路只有一次 resize。
  const cropped = crop(img, s0.name)
  const upscale = (p) => resizePixels(p, Math.round(p.width * factor), Math.round(p.height * factor))

  // 参照组：同一块内容，一处不缩放、一处缩放 ⇒ 应判"无差异"
  const rClean = (() => {
    const a = encodePng(cropped)
    const b = encodePng(upscale(cropped))
    const r = comparePngEither(a, b, { allowScale: true, tolerance: 0, maxDiffRatio: 0 })
    return { detected: !r.same, diff: r.diff, ratio: r.ratio }
  })()
  ok('同一内容仅换倍率（单次重采样）⇒ 判无差异', rClean.detected === false,
    rClean.detected ? '**误报** ' + rClean.diff + ' 像素（' + (rClean.ratio * 100).toFixed(2) + '%）' : 'diff=0')

  // 实验组：先在原尺度涂补丁 → 裁剪 → 缩放。两图都只经过一次 resize。
  const keptH = Math.floor(img.height * KEEP_RATIO)
  const [rx0, rx1] = X_BY_STATE[s0.name] || [0, 282]
  const midX = Math.round((rx0 + rx1) / 2), midY = Math.round(keptH / 2)
  const findings = []
  for (const [label, w, h] of [['10×10', 10, 10], ['6×6', 6, 6], ['3×3', 3, 3], ['1×1', 1, 1]]) {
    const patched = crop(paint(img, midX, midY, midX + w, midY + h, [255, 0, 255]), s0.name)
    const r = (() => {
      const a = encodePng(cropped)
      const b = encodePng(upscale(patched))
      const rr = comparePngEither(a, b, { allowScale: true, tolerance: 0, maxDiffRatio: 0 })
      return { detected: !rr.same, diff: rr.diff }
    })()
    findings.push({ label, detected: r.detected, diff: r.diff })
  }
  for (const f of findings) console.log('    ' + f.label.padEnd(7) + ' 变化 → ' + (f.detected ? '抓到' : '**漏掉**') + '（' + f.diff + ' 像素）')
  const lost = findings.filter((f) => !f.detected).map((f) => f.label)
  ok('跨 DPI 下 10×10 的变化仍能抓到', findings.find((f) => f.label === '10×10').detected,
    findings.map((f) => f.label + '=' + (f.detected ? 'Y' : 'N')).join(' '))
  if (lost.length) console.log('    ⚠️ 归一化后漏掉的最小变化: ' + lost.join(', ')
    + '（归一化的信息损失边界，如实记录，不放宽容差去掩盖）')
}

console.log('\n覆盖审计：' + pass + ' 通过 / ' + fail + ' 失败')
console.log('\n注意：标「能力缺口」的项**故意**断言"抓不到" —— 它们记录的是 oracle 的已知盲区，')
console.log('不是缺陷。要覆盖那些区域需要**另加状态**，不能靠放宽容差（放容差会把真回归一起放过）。')
process.exit(fail === 0 ? 0 : 1)