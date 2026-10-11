// tools/diagnose-baseline-drift.mjs —— 基线漂移的**单变量定位工具**（只读，不改任何东西）
//
// 背景：跨会话空转 compare 得到 0 一致 / 8 有差异，每态 1.2~1.5%。此前我把原因说成"动效相位"，
// 被审核方以三条证据驳回（已注 animation:none、orb 无持续动画、差异还涉及宿主文字图标），
// 而且我拿的是**整页**差异图去论证**裁剪框内**的判定 —— 张冠李戴。这个脚本只做一件事：
// 把差异**限制在每个状态真正的判定裁剪矩形内**，并按"屏蔽区内/外"分开，给出可核查的数字。
//
// 用法：node tools/diagnose-baseline-drift.mjs <基准A> <基准B> [--out <目录>]
//   · 裁剪框 = manifest.states[i].geom.rect（CSS px）× DPR，四舍五入 —— 与 oracle 的
//     expectCompared{width,height} 对齐（对不上就报错，不猜）。
//   · 屏蔽区 = geom.masks（CSS px，绝对坐标）× DPR。
//   · 输出每态：裁剪框内差异像素数、**屏蔽区内/外各多少**、差异包围盒（裁剪框内相对坐标）、
//     通道差直方图（±1 = 抗锯齿/取整；≥9 基本是真实内容差）、以及一张把差异涂红的裁剪图。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng } from '../../dsh-browser-live/pixdiff.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const [baseA, baseB] = process.argv.slice(2)
const outIdx = process.argv.indexOf('--out')
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : path.join(REPO, 'baselines', '_drift')
if (!baseA || !baseB) { console.error('用法: node tools/diagnose-baseline-drift.mjs <基准A> <基准B> [--out 目录]'); process.exit(2) }

const DPR = 1.1666666269302368          // 与 VB_VIEWPORT 一致；assert 会用 expectCompared 反验
const dirA = path.join(REPO, 'baselines', baseA)
const dirB = path.join(REPO, 'baselines', baseB)
const mA = JSON.parse(readFileSync(path.join(dirA, 'manifest.json'), 'utf8'))
if (!existsSync(dirB)) { console.error('✗ 找不到 ' + dirB); process.exit(2) }

mkdirSync(OUT, { recursive: true })
const px = (css) => Math.round(css * DPR)

let totalOutside = 0, totalInside = 0, mismatched = 0
console.log('=== 基线漂移定位：' + baseA + ' vs ' + baseB + ' ===')
console.log('  裁剪框与屏蔽区都按 CSS×DPR 换算；只有**框内且屏蔽区外**的像素才本该影响判定\n')

for (const s of mA.states) {
  const fa = path.join(dirA, s.file)
  const fb = path.join(dirB, s.file)
  if (!existsSync(fb)) { console.log('  ⚠️ ' + s.name + '：B 里没有同名文件，跳过'); continue }
  const a = decodePng(readFileSync(fa))
  const b = decodePng(readFileSync(fb))
  if (a.width !== b.width || a.height !== b.height) { console.log('  ✗ ' + s.name + '：尺寸不同 ' + a.width + 'x' + a.height + ' vs ' + b.width + 'x' + b.height); mismatched++; continue }

  const r = s.geom.rect
  const x0 = px(r.x0), x1 = px(r.x1), y0 = px(r.y0), y1 = px(r.y1)
  const cw = x1 - x0, ch = y1 - y0
  const exp = s.expectCompared
  const align = exp && exp.width === cw && exp.height === ch
  if (exp && !align) mismatched++
  // 屏蔽区（绝对 CSS → 设备像素），转成裁剪框内相对坐标
  const masks = (s.geom.masks || []).map((m) => [px(m[0]) - x0, px(m[1]) - y0, px(m[2]) - x0, px(m[3]) - y0])
  const inMask = (x, y) => masks.some((m) => x >= m[0] && x < m[2] && y >= m[1] && y < m[3])

  const cA = a.channels, cB = b.channels
  let inside = 0, outside = 0
  let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1
  const hist = { d1: 0, d2_8: 0, d9_32: 0, d33p: 0 }
  const crop = Buffer.alloc(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const oa = ((y + y0) * a.width + (x + x0)) * cA
      const ob = ((y + y0) * b.width + (x + x0)) * cB
      let d = 0
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[oa + c] - b.data[ob + c]))
      const oc = (y * cw + x) * 4
      if (d > 0) {
        if (inMask(x, y)) inside++; else {
          outside++
          if (x < bx0) bx0 = x; if (y < by0) by0 = y
          if (x > bx1) bx1 = x; if (y > by1) by1 = y
          if (d === 1) hist.d1++; else if (d <= 8) hist.d2_8++; else if (d <= 32) hist.d9_32++; else hist.d33p++
        }
        // 差异涂红（保留亮度信息），屏蔽区内的用黄色区分
        const base = a.data[oa], other = a.data[oa + 1], third = a.data[oa + 2]
        crop[oc] = inMask(x, y) ? 255 : 255
        crop[oc + 1] = inMask(x, y) ? 215 : Math.min(255, Math.round((base + other + third) / 6))
        crop[oc + 2] = inMask(x, y) ? 0 : 255
        crop[oc + 3] = 255
      } else {
        crop[oc] = 24; crop[oc + 1] = 24; crop[oc + 2] = 24; crop[oc + 3] = 255
      }
    }
  }
  totalOutside += outside; totalInside += inside
  const outFile = path.join(OUT, s.name + '.diffcrop.png')
  writeFileSync(outFile, encodePng({ width: cw, height: ch, channels: 4, data: crop }))
  const bbox = bx1 >= 0 ? ('[' + bx0 + ',' + by0 + ' → ' + bx1 + ',' + by1 + '] 大小 ' + (bx1 - bx0 + 1) + 'x' + (by1 - by0 + 1)) : '（无）'
  console.log('  ' + s.name + '  框 ' + cw + 'x' + ch + (align ? '（与 expectCompared 对齐 ✓）' : ' ⚠️ 与 expectCompared 不一致'))
  console.log('      框内差异：**屏蔽区外 ' + outside + '** ／ 屏蔽区内 ' + inside + '   （框共 ' + (cw * ch) + ' 像素）')
  console.log('      屏蔽区外差异包围盒（框内坐标）：' + bbox)
  console.log('      通道差分布：±1 ' + hist.d1 + ' ／ 2-8 ' + hist.d2_8 + ' ／ 9-32 ' + hist.d9_32 + ' ／ >32 ' + hist.d33p)
  console.log('      差异图（红=屏蔽区外，黄=屏蔽区内）：' + path.relative(REPO, outFile))
  if (s.geom.masks && s.geom.masks.length) console.log('      masks: ' + JSON.stringify(s.geom.masks))
}

console.log('\n汇总：屏蔽区外差异 ' + totalOutside + ' ／ 屏蔽区内 ' + totalInside
  + (mismatched ? '   ⚠️ ' + mismatched + ' 个状态裁剪框与 expectCompared 对不上' : ''))
console.log(totalOutside === 0
  ? '⇒ 若屏蔽区外为 0，则"跨会话差异"全部落在 oracle 本就打算屏蔽的区域（属屏蔽未生效或换算错误，不是内容变化）'
  : '⇒ 屏蔽区外仍有差异，需要继续单变量定位（把这些像素对应到具体元素）')
