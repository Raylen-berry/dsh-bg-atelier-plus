// tools/make-marker-wallpaper.mjs —— 生成"中等尺寸标记图"并安装到用户底图目录
//
// 为什么需要（验收约定第 5 项 / 审核方第十轮）：
//   预览与取景此前是**盲区** —— `hero ±2` 与图库缩略图被屏蔽，理由是它们把几 MP~43MP
//   的原图缩到几百 px，**跨刷新重采样不完全可复现**（实测 hero 刷新后 diff=11618/Δ3）。
//   审核方的要求是：用**中等尺寸标记图**验证预览/缩放/焦点，且**该状态不屏蔽预览框**。
//   中等尺寸 ⇒ 缩放倍率接近 1 ⇒ 重采样稳定 ⇒ 预览框可以不被屏蔽、真正参与比较。
//
// 标记图的设计（让"错图/错缩放/焦点无效"都能被看出来）：
//   · 四角 + 四边中点各一个**不同颜色**的方块（顺序/颜色错 ⇒ 说明图反了或换了图）
//   · 一条细网格（缩放比例错 ⇒ 网格间距变 ⇒ 大面积差异）
//   · 中心一个十字（focus 设置无效 ⇒ 中心标记位置不变但周围内容错位）
//   · 左上角一条"刻度条"（每 10px 一个不同灰阶，用来量缩放）
//
// 用法：
//   node tools/make-marker-wallpaper.mjs            # 生成并安装
//   node tools/make-marker-wallpaper.mjs --remove   # 卸载（验收后清理）
import fs from 'node:fs'
import path from 'node:path'
import { encodePng } from '../../dsh-browser-live/pixdiff.js'

export const MARKER_CAT = '_验收标记图'
export const MARKER_FILE = 'marker-960x540.png'
const W = 960, H = 540

function buildMarker() {
  const data = Buffer.alloc(W * H * 4)
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const o = (y * W + x) * 4
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255
  }
  const fill = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, c[0], c[1], c[2]) }
  // 底：中等灰（保证任何位置都不是纯黑，便于看差异）
  fill(0, 0, W, H, [96, 96, 104])
  // 细网格：每 24px 一条深色，每 96px 一条更深的（缩放比例错会立刻显形）
  for (let x = 0; x < W; x += 24) { const c = x % 96 === 0 ? [40, 40, 48] : [78, 78, 86]; for (let y = 0; y < H; y++) put(x, y, c[0], c[1], c[2]) }
  for (let y = 0; y < H; y += 24) { const c = y % 96 === 0 ? [40, 40, 48] : [78, 78, 86]; for (let x = 0; x < W; x++) put(x, y, c[0], c[1], c[2]) }
  // 四角 + 四边中点：八个不同颜色方块（40×40）
  const marks = [
    [0, 0, [255, 0, 0]],           // 左上 红
    [W - 40, 0, [0, 255, 0]],      // 右上 绿
    [0, H - 40, [0, 0, 255]],      // 左下 蓝
    [W - 40, H - 40, [255, 255, 0]], // 右下 黄
    [W / 2 - 20, 0, [255, 0, 255]],  // 上中 品红
    [W / 2 - 20, H - 40, [0, 255, 255]], // 下中 青
    [0, H / 2 - 20, [255, 128, 0]],  // 左中 橙
    [W - 40, H / 2 - 20, [128, 0, 255]], // 右中 紫
  ]
  for (const [x, y, c] of marks) fill(x, y, 40, 40, c)
  // 中心十字（focus 无效时会与网格错位）
  fill(W / 2 - 60, H / 2 - 2, 120, 5, [255, 255, 255])
  fill(W / 2 - 2, H / 2 - 60, 5, 120, [255, 255, 255])
  // 左上刻度条：每 10px 一阶灰，用来量横向缩放
  for (let i = 0; i < 60; i++) { const v = 30 + i * 3; fill(60 + i * 10, 60, 10, 14, [v, v, v]) }
  return { width: W, height: H, channels: 4, data }
}

function userWallpaperDir() {
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh')
  return path.join(dshHome, 'dsh-bg-atelier', 'wallpapers')
}

const arg = process.argv[2]
const dir = path.join(userWallpaperDir(), MARKER_CAT)
if (arg === '--remove') {
  try { fs.rmSync(dir, { recursive: true, force: true }); console.log('已卸载标记图目录: ' + dir) }
  catch (e) { console.log('卸载失败: ' + e.message) }
  process.exit(0)
}
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, MARKER_FILE)
fs.writeFileSync(file, encodePng(buildMarker()))
console.log('已安装中等尺寸标记图: ' + file)
console.log('  尺寸 ' + W + '×' + H + '（缩放倍率接近 1 ⇒ 预览框可以不被屏蔽）')
console.log('  列表身份: cat=' + MARKER_CAT + ' file=' + MARKER_FILE)