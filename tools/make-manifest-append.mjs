// 生成底图清单 —— **追加式**（发版专用；不要用 make-wallpaper-manifest.mjs 发版）
//
// 为什么需要它：make-wallpaper-manifest.mjs 是按目录自然序**从零重编号**的，
// 一旦改名或插入新图，既有 `wNN` 与 Release 里已上传的资产就会整体错位
// —— 实测踩过：`贝利尔.png` 改名成 `贝利尔2.png` 后，w08/w16 指向的内容就变了，
// 而 make-release 会发现「同名资产字节数不符」，把已上传的资产删掉重传（几百 MB 白传）。
//
// 本脚本的做法：拿**上一版清单**（默认取 git 里 HEAD 那一版，也就是上次发布用的那份），
// 按 sha256 把已发布的图绑回它原来的资产名（路径改名不影响），剩下的新图按同样的
// 目录自然序续编 w20、w21…。于是 `node tools/make-release.mjs` 只会补传差额。
//
// 用法：
//   node tools/make-manifest-append.mjs                    # 从 HEAD:wallpapers.manifest.json 取旧清单
//   node tools/make-manifest-append.mjs --from <git-ref>   # 指定别的版本
//   node tools/make-manifest-append.mjs --from <文件路径>    # 或直接从文件取
// 换 Release tag：环境变量 WALLPAPER_RELEASE_TAG（默认沿用旧清单里的 tag）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WALL = path.join(ROOT, 'wallpapers')
const OUT = path.join(ROOT, 'wallpapers.manifest.json')
const REPO = 'Raylen-berry/dsh-desktop-wallpaper'

const i = process.argv.indexOf('--from')
const FROM = i >= 0 ? process.argv[i + 1] : 'HEAD:wallpapers.manifest.json'

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

// ---- 1) 上一版清单 ----
let prev = null
try {
  const text = fs.existsSync(FROM)
    ? fs.readFileSync(FROM, 'utf8')
    : execFileSync('git', ['-C', ROOT, 'show', FROM], { encoding: 'utf8' })
  prev = JSON.parse(text)
  console.log('上一版清单（' + FROM + '）：' + prev.total + ' 项 · ' + mb(prev.totalBytes) + ' · tag ' + prev.release.tag)
} catch (e) {
  console.error('取不到上一版清单（' + FROM + '）：' + e.message)
  console.error('首次发布请先用 --from 指定一份旧清单；确实没有旧资产时用 tools/make-wallpaper-manifest.mjs。')
  process.exit(1)
}

// ---- 2) 扫当前 wallpapers/ ----
if (!fs.existsSync(WALL)) { console.error('没有 wallpapers/ 目录：' + WALL); process.exit(1) }
const files = []
for (const cat of fs.readdirSync(WALL).sort()) {
  const catDir = path.join(WALL, cat)
  if (!fs.statSync(catDir).isDirectory()) continue
  for (const f of fs.readdirSync(catDir).sort()) {
    const p = path.join(catDir, f)
    if (!fs.statSync(p).isFile()) continue
    const buf = fs.readFileSync(p)
    files.push({ path: cat + '/' + f, ext: path.extname(f).toLowerCase(), bytes: buf.length, sha256: sha256(buf) })
  }
}
console.log('本机 wallpapers/：' + files.length + ' 张 · ' + mb(files.reduce((s, f) => s + f.bytes, 0)))

// ---- 3) 已发布的按 sha256 绑回原资产名 ----
const bySha = new Map()
for (const f of files) {
  if (bySha.has(f.sha256)) console.error('  警告：两处内容相同 ' + f.path + ' 与 ' + bySha.get(f.sha256).path)
  bySha.set(f.sha256, f)
}
const used = new Set(), usedNames = new Set(), items = [], renamed = []
for (const it of prev.items) {
  const hit = bySha.get(it.sha256)
  if (!hit) { console.error('  ! ' + it.asset + '（' + it.path + '）在本机找不到相同内容 —— 它的资产需要重新上传'); continue }
  if (used.has(hit.sha256)) { console.error('  ! ' + it.asset + ' 与前面某项内容重复，跳过'); continue }
  used.add(hit.sha256)
  // 旧清单里可能就有**重名**（曾经的续编起点是"上一版的条数"，而旧清单最大号是 w138 ⇒ 撞出三个 w136/w137/w138）。
  // 名字必须唯一：同名不同内容上传时 GitHub 直接 422（实测 w136.png），留在清单里就是永远传不完。
  // 先到先得 —— 占住这个名字的不动，后来的挪到末尾重新编号。
  if (usedNames.has(it.asset)) { console.error('  ! ' + it.asset + '（' + hit.path + '）与前面的资产重名 —— 挪到末尾重新编号'); renamed.push(hit); continue }
  usedNames.add(it.asset)
  items.push({ asset: it.asset, path: hit.path, bytes: hit.bytes, sha256: hit.sha256 })
  console.log('  = ' + it.asset + '  ← ' + hit.path + '  ' + mb(hit.bytes) + (hit.path === it.path ? '' : '（由 ' + it.path + ' 改名）'))
}

// ---- 4) 新图续编 ----
// 起点取**已用编号的最大值**，不是条数：旧清单 135 条但最大号 w138，按条数续编必然撞号。
const maxNum = (list) => list.reduce((max, it) => Math.max(max, parseInt(String(it.asset).replace(/\D/g, ''), 10) || 0), 0)
let n = maxNum(prev.items)
const nextAsset = (ext) => {
  let name
  do { n += 1; name = 'w' + String(n).padStart(2, '0') + ext } while (usedNames.has(name))
  usedNames.add(name)
  return name
}
const rest = files.filter((f) => !used.has(f.sha256))
for (const f of [...rest, ...renamed]) {
  const asset = nextAsset(f.ext)
  items.push({ asset, path: f.path, bytes: f.bytes, sha256: f.sha256 })
  console.log('  + ' + asset + '  ← ' + f.path + '  ' + mb(f.bytes))
}
// 自检：名字重复就直接失败 —— 这种清单能写出来但永远传不完（GitHub 422），越早炸越好。
if (usedNames.size !== items.length) {
  console.error('内部错误：算出来的资产名有重复（' + usedNames.size + ' 个名字 / ' + items.length + ' 项），拒绝写出')
  process.exit(1)
}

// ---- 5) 写出 ----
const tag = process.env.WALLPAPER_RELEASE_TAG || prev.release.tag
const manifest = {
  format: 'dsh-bg-atelier-wallpapers/1',
  generatedAt: new Date().toISOString(),
  release: { tag, repo: REPO, base: 'https://github.com/' + REPO + '/releases/download/' + tag },
  total: items.length,
  totalBytes: items.reduce((s, x) => s + x.bytes, 0),
  policy: 'lossless：一律上传原始文件（PNG/JPG 原样，不缩放、不重编码）',
  items,
}
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), 'utf8')
console.log('\n已写出 ' + OUT)
console.log('  ' + manifest.total + ' 张 · ' + mb(manifest.totalBytes) +
  '（本次要新传 ' + (rest.length + renamed.length) + ' 张 · ' + mb([...rest, ...renamed].reduce((s, f) => s + f.bytes, 0)) + '）')
console.log('  基址 ' + manifest.release.base)
console.log('  下一步：node tools/make-release.mjs')
