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
import { decodePng, resizePixels } from '../../dsh-browser-live/pixdiff.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.join(HERE, '..', 'baselines', process.argv[2] || 'before-refactor')
const manifest = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'))

// 口径**直接从真实实现 import**，不再自己复制一份。
// 审核方指出：本脚本原来自己写了 crop()/wouldDetect()，而且已经与真实路径漂移
// （它还是旧的"先裁剪、再缩放"顺序，真实 compareStable 早已改成"先归一尺度、再裁剪"）
// ⇒ 那句 11/11 **根本没测到真实比对路径**。现在两边共用 tools/oracle-compare.mjs。
import {
  STABLE_KEEP_RATIO as KEEP_RATIO,
  STABLE_X_BY_STATE as X_BY_STATE,
  PIXEL_TOLERANCE, MASK_RECTS,
  compareStableImages,
  paint,
} from './oracle-compare.mjs'

/** 按**真实** oracle 口径比两张图（走 compareStableImages），返回是否判"有差异"。 */
function wouldDetect(baseImg, changedImg, stateName) {
  const r = compareStableImages(baseImg, changedImg, stateName)
  return { detected: !r.same, diff: r.diff, ratio: r.ratio }
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

console.log('=== oracle 覆盖边界审计 ===')
console.log('基准目录: ' + BASE)
console.log('口径（从 oracle-compare.mjs import）：保留高度 ' + (KEEP_RATIO * 100) + '%，竖切 '
  + JSON.stringify(X_BY_STATE) + '，每通道容差 ' + PIXEL_TOLERANCE)

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
  // 屏蔽框（MASK_RECTS）也是"看不见的区域"，必须一并列出来 —— 否则"能力缺口"清单不完整
  const masked = MASK_RECTS[s.name] || []
  for (const [mx0, my0, mx1, my1] of masked) {
    console.log('      · **屏蔽框** x[' + mx0 + ',' + mx1 + '] y[' + my0 + ',' + my1 + ']（'
      + ((mx1 - mx0) * (my1 - my0)) + ' 像素）—— 见 oracle-compare.mjs 的 MASK_RECTS 注释')
  }

  // ① 保留区内的小变化：必须抓到（这是"不放水"的核心证据）
  const midX = Math.round((rx0 + rx1) / 2), midY = Math.round(keptH / 2)
  const small = paint(img, midX, midY, midX + 10, midY + 10, [255, 0, 255])
  const rSmall = wouldDetect(img, small, s.name)
  ok('保留区内 10×10 小变化被抓到', rSmall.detected, rSmall.diff + ' 像素')

  // ①b 屏蔽框内植入变化 ⇒ **应抓不到**（如实记录这个缺口，别假装没有）
  // ⚠️ 补丁必须**完全落在框内**。第一版固定涂 60×40 并以框心为中心，遇到 01/02 那个
  // 只有 30px 高的窄条（y610-640）时就溢出去了 —— 溢出部分被正常检出，测试反而报
  // "意外抓到了"。那是**测试自己写错**，不是 oracle 的问题。现在按框尺寸自适应缩小。
  for (const [mx0, my0, mx1, my1] of masked) {
    const bw = mx1 - mx0, bh = my1 - my0
    const pw = Math.max(2, Math.min(60, Math.floor(bw * 0.5)))
    const ph = Math.max(2, Math.min(40, Math.floor(bh * 0.5)))
    const cx = mx0 + Math.floor(bw / 2), cy = my0 + Math.floor(bh / 2)
    const inMask = paint(img, cx - Math.floor(pw / 2), cy - Math.floor(ph / 2),
      cx - Math.floor(pw / 2) + pw, cy - Math.floor(ph / 2) + ph, [255, 0, 255])
    const rMask = wouldDetect(img, inMask, s.name)
    ok('【能力缺口·预期抓不到】屏蔽框内 ' + pw + 'x' + ph + ' 变化（x' + mx0 + '-' + mx1 + ' y' + my0 + '-' + my1 + '）',
      rMask.detected === false, rMask.detected ? '意外抓到了 ' + rMask.diff : '如预期未检出')
  }

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
// 正确测法：**整个比对走真实 compareStableImages**（它自己会先归一尺度再裁剪），
// 我们只负责造"另一台机器倍率下的同一画面"这一点输入，不再自己复制裁剪/缩放顺序。
console.log('\n— 跨 DPI 归一化的检出能力（走**真实** compareStableImages）—')
{
  const s0 = manifest.states[0]
  const img = decodePng(fs.readFileSync(path.join(BASE, s0.file)))
  const factor = 1.25
  const upscale = (p) => resizePixels(p, Math.round(p.width * factor), Math.round(p.height * factor))

  // 参照组：同一张图、只是倍率不同 ⇒ **必须**判"无差异"（否则就是跨 DPI 误报）
  const rClean = wouldDetect(img, upscale(img), s0.name)
  ok('同一内容仅换倍率 ⇒ 判无差异（不再误报 70.81%）', rClean.detected === false,
    rClean.detected ? '**误报** ' + rClean.diff + ' 像素（' + (rClean.ratio * 100).toFixed(2) + '%）' : 'diff=0')

  // 实验组：先涂补丁 → 再按同一套算法缩放 ⇒ 应仍抓得到
  const keptH2 = Math.floor(img.height * KEEP_RATIO)
  const [rx0, rx1] = X_BY_STATE[s0.name] || [0, 282]
  const midX = Math.round((rx0 + rx1) / 2), midY = Math.round(keptH2 / 2)
  const findings = []
  for (const [label, w, h] of [['10×10', 10, 10], ['6×6', 6, 6], ['3×3', 3, 3], ['1×1', 1, 1]]) {
    const patched = paint(img, midX, midY, midX + w, midY + h, [255, 0, 255])
    const r = wouldDetect(img, upscale(patched), s0.name)
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