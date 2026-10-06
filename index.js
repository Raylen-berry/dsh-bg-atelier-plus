// ============================================================================
// dsh-bg-atelier · Host half (packaged, boot-loaded)
// (版本号不写在这儿了 —— 启动日志从 package.json 读, 免得注释先过期)
// 职责:
//   1. 通过 webServer 前缀路由 /bga/wallpapers/<类型>/<文件名> 以 HTTP 提供底图,
//      避免把 base64 大图塞进 Client→Host RPC。
//   2. 通过 webServer 精确路由 /bga/wallpapers.json 返回"分类型"底图清单,
//      供设置页两级浏览 (类型页 → 类型内图库) 与宝珠随机换图 (纯 HTTP)。
//
// 底图按"类型目录"组织: 放图目录下每个子文件夹 = 一个底图类型(名称即文件夹名)。
//   例: wallpapers/线稿风/xxx.png  → 类型「线稿风」
//       wallpapers/重返未来1999/…  → 类型「重返未来1999」
// 放图目录根部的散图(旧版遗留)会归入「未分类」类型, 旧 URL 仍可访问(自动在
// 各类型里按文件名找回), 平滑升级。
//
// 高清识别: 文件名去掉扩展名后, 尾部带 高清/_高清/·高清/（高清）/4k/uhd/hd 等
// 标记的自动打上 isHd, 清单里的 base 是去掉标记后的显示名 (显示名与文件名无关)。
//
// 底图目录解析顺序 (首个有图的目录命中):
//   ① $DSH_BG_ATELIER_WALLPAPERS 绝对路径 (用户显式覆盖)
//   ② $DSH_HOME/dsh-bg-atelier/wallpapers (可写用户目录, 方便随时加图)
//   ③ 插件包内置 wallpapers/ (随包分发, 开箱即用)
//   ④ 工作区相对路径 dsh-plugins/dsh-desktop-wallpaper/wallpapers (旧动态版兼容)
// ============================================================================

import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 底图取回：与 tools/fetch-wallpapers.mjs 共用同一份实现（见 fetch-wallpapers.js 顶部注释）
import { readManifest, fetchWallpapers } from './fetch-wallpapers.js'
// WE (Wallpaper Engine) 库接入: /bga/we/* 路由, 详见 we/ 目录与 README「WE 壁纸库」节。
import { registerWeRoutes } from './we/routes.js'

export const name = 'dsh-bg-atelier-plus'
export const inject = ['webServer']

// Package root: index.js 位于包根, 无需再往上一层.
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
// 注意: webServer 的 prefix 匹配规则是 pathname === prefix || startsWith(prefix + '/'),
// 所以注册路径必须不带尾斜杠, 而客户端 URL 仍带斜杠段。
const ROUTE_PREFIX = '/bga/wallpapers'
const URL_PREFIX = ROUTE_PREFIX + '/'
const LIST_PATH = '/bga/wallpapers.json'
const SETTINGS_PATH = '/bga/settings.json'
// 读取原始文件的最大字节上限 (为容纳超大高清底图)。
const MAX_BYTES = 128 * 1024 * 1024
// 输出分辨率目标 (长边):
//   SERVED_MAX_DIM    0 = 真正使用时的底图 —— **不设上限, 原图原样送**（v1.6.1 起恒为 0）。
//                        dim===0 时该路直接送原文件字节, 不缩放、不重编码、不进缓存;
//                        改回正数才会走「缩放 + thumbBufferCache」那条通用路径。
//   THUMB_DIM       320 = 「当前底图」小方块 (64×42 CSS)
//   POSTER_DIM      112 = 类型卡里的迷你缩略图 (57×40 CSS; v1.4.0 由 48 提到 112)
//   PREVIEW_DIM     640 = 设置页图库网格主图 (150–260 CSS 宽 × 2x 屏; v1.4.0 新增)
const SERVED_MAX_DIM = 0
const THUMB_DIM = 320
const POSTER_DIM = 112
const PREVIEW_DIM = 640
// 派生图 webp 编码质量: poster 只要"先出图", preview 是图库主图, 给高一点。
const POSTER_QUALITY = 80
const PREVIEW_QUALITY = 86
// 运行时缩略图缓存 (按 相对路径+大小+mtime 失效), 避免每次请求都重缩。
// 只服务「需要缩放」的那条路; 送原图那条**不进缓存** —— 39 张合计 820 MB,
// 全缓存住 = 让一个换底图插件常驻 820 MB 内存, 而它省下的只是 OS 页缓存本来就兜住的读盘。
const thumbBufferCache = new Map()
// 派生图 (poster/preview) 内存缓存 (按派生 key 哈希), 避免同一进程内重复读盘。
const derivedMemCache = new Map()

// JSON 响应小工具（清单 / 设置 / 下载进度三条路由共用）。
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

// 惰性加载 sharp (宿主可解析到 DSH Desktop 内置的 sharp); 失败则原样输出。
// 注意: 插件以 junction 挂进 profile 时, ESM 的裸 import('sharp') 会按**真实路径**
// (D:\DeepSeek\dsh-plugins\...) 找 node_modules —— 那里没有 sharp, 于是静默退化成
// "缩略图=原图"(每次打开工坊都拉整张原图, 这就是"点开很卡"的元凶之一)。所以先试裸
// import, 再按部署路径逐个试 app 自带的 sharp 入口, 全失败才退回原样输出。
let sharpPromise = null
/** sharp 的候选来源, 按"最可能成功"排序。
 *
 *  为什么需要这么多候选: 插件目录被 link/junction 挂进 profile 时, ESM 的裸 import 是按
 *  **真实路径** (E:\dsh-plugins\...) 往上找 node_modules 的 —— 那里没有 sharp, 于是静默退化成
 *  "缩略图=原图"(每次打开工坊都拉整张原图), 连带 ?sz=large 中间档也一起失效。
 *  所以除了裸 import, 还要显式去三个地方找:
 *    ① profile 树共享的 node_modules (DSH_HOME/profiles/node_modules) —— 桌面版宿主自带的 sharp
 *       就在这儿 (0.35.x, 已用 require 实测可加载);
 *    ② 宿主 asar 里的 sharp (<app>/resources/app.asar/node_modules/sharp) —— Electron 的
 *       require 能读 asar;
 *    ③ asar 旁边解包出来的那份 (<app>/resources/app.asar.unpacked/...) —— 原生 .node 从
 *       asar 里加载会失败, 解包目录才是正路。 */
function sharpCandidates() {
  const candidates = []
  // ⓪ 显式指定 (排障/测试): 判据用 "://" 而不是 /^[a-zA-Z]+:/ —— 后者会把盘符 "D:\..." 当协议,
  //    把裸路径喂给 import() ⇒ ERR_UNSUPPORTED_ESM_URL_SCHEME。
  if (process.env.DSH_BG_ATELIER_SHARP) {
    const p = process.env.DSH_BG_ATELIER_SHARP
    candidates.push(p.indexOf('://') > 0 ? p : pathToFileURL(path.resolve(p)).href)
  }
  // ① 裸 import: 插件装在真有 node_modules 的树里、或 profile 树正好能兜住时有效
  candidates.push('sharp')
  // ①b profile 树共享 node_modules 的绝对路径 (link/junction 场景下裸 import 兜不到这里)
  const home = dshHome()
  for (const rel of [['profiles', 'node_modules'], ['node_modules']]) {
    const p = path.join(home, ...rel, 'sharp', 'dist', 'index.cjs')
    try { if (fsSync.existsSync(p)) candidates.push(pathToFileURL(p).href) } catch { /* ignore */ }
  }
  // ②③ 宿主自带的 sharp: 桌面版把它打在 asar 里, 路径从 process.execPath 现推, 不写死盘符
  const probes = []
  try {
    const exeDir = path.dirname(process.execPath)                 // <app>
    const resources = path.join(exeDir, 'resources')
    for (const rel of [
      ['app.asar.unpacked', 'node_modules', 'sharp', 'dist', 'index.cjs'], // 原生模块要这份
      ['app.asar', 'node_modules', 'sharp', 'dist', 'index.cjs'],          // Electron 能读 asar
      ['app', 'node_modules', 'sharp', 'dist', 'index.cjs'],               // 解包版
    ]) probes.push(path.join(resources, ...rel))
    // node 可执行文件在 <app>/node_modules/node/bin/node.exe 时: 上两级就是 <app>/node_modules
    probes.push(path.join(exeDir, '..', '..', 'sharp', 'dist', 'index.cjs'))
  } catch { /* ignore */ }
  for (const p of probes) {
    // asar 路径**不先探存在性**: 普通 Node 的 fs 看不见 asar 内部, existsSync 会是 false,
    // 而 Electron 里它是真的能 import 的 —— 先探反而会把正确的候选筛掉。探不到的 import 会
    // 自己失败 (下面的循环逐个兜), 不算错。
    const spec = /[\\/]app\.asar[\\/]/.test(p) ? pathToFileURL(p).href : (fsSync.existsSync(p) ? pathToFileURL(p).href : null)
    if (spec && candidates.indexOf(spec) < 0) candidates.push(spec)
  }
  return candidates
}
/** 从模块命名空间里挑出"能调用的 sharp 函数"。
 *  0.35 的 CJS 导出是个函数 (带 versions), 但也有版本是 { default: fn } —— 两种都认。 */
function pickSharp(m) {
  if (!m) return null
  if (typeof m === 'function') return m
  if (typeof m.default === 'function') return m.default
  if (m.default && typeof m.default === 'object') return m.default
  return typeof m === 'object' ? m : null
}
async function getSharp() {
  if (sharpPromise === null) {
    sharpPromise = (async () => {
      const tried = []
      for (const spec of sharpCandidates()) {
        // 裸 import 之外再兜一次 require: Electron 的 require 能读 asar, 而 import 到原生
        // 模块 (sharp 的 .node) 时 asar 里那条路会失败。
        for (const how of ['import', 'require']) {
          try {
            let s
            if (how === 'import') s = pickSharp(await import(spec))
            else {
              const req = createRequire(import.meta.url)
              s = pickSharp(req(spec === 'sharp' ? 'sharp' : fileURLToPath(spec)))
            }
            if (s) return s
          } catch (e) { tried.push(how + ' ' + spec + ' :: ' + String((e && e.message) || e)) }
        }
      }
      console.error('[dsh-bg-atelier] sharp unavailable, serving originals.\n  ' + tried.join('\n  '))
      return null
    })()
  }
  return sharpPromise
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
}

// ------------------------------------------------------------- 通用小工具 ---

// 文件名去掉扩展名。
function stemOf(name) {
  const ext = extOf(name)
  return ext ? name.slice(0, name.length - ext.length - 1) : name
}

// 清单里跳过这些"说明类/隐藏"文件, 不当作不支持文件报错。
function isIgnoredName(name) {
  if (!name) return true
  if (name.charCodeAt(0) === 46) return true // . 开头隐藏文件
  if (name === FOLDERS_FILE) return true     // 标签配置, 不是图
  return /^(readme|说明|安装说明|notes)(\..*)?$/i.test(name)
}

// 高清标记识别 (作用于去扩展名后的名字, 只认"尾部"标记):
//   中文: 高清 / _高清 / ·高清 / -高清 / （高清）
//   英文: _4k / ·4k / _hd / (hd) / _uhd ... (需要分隔符前缀, 避免误伤正常英文名)
const HD_CN = /([_\s·.\-（(]*高清[)）]*)$/
const HD_EN = /([_\s·.\-（(]+(?:4k|uhd|hd)[)）]*)$/i
function splitHd(stem) {
  let base = stem
  let hd = false
  let m = HD_CN.exec(base)
  if (m) { hd = true; base = base.slice(0, m.index) }
  else {
    m = HD_EN.exec(base)
    if (m) { hd = true; base = base.slice(0, m.index) }
  }
  base = base.replace(/[_\s·.\-]+$/, '')
  return { base: base || stem, hd }
}

// 自然排序 (数字段按数值比, 其余按码位比), 保证编号稳定可预期。
function nameTokens(s) {
  const out = []
  const re = /(\d+)/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index))
    out.push(m[1])
    last = m.index + m[1].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
function compareNames(a, b) {
  const ta = nameTokens(String(a))
  const tb = nameTokens(String(b))
  const n = Math.min(ta.length, tb.length)
  for (let i = 0; i < n; i++) {
    const x = ta[i]
    const y = tb[i]
    if (x === y) continue
    const xd = /^\d+$/.test(x)
    const yd = /^\d+$/.test(y)
    if (xd && yd) {
      if (x.length !== y.length) return x.length < y.length ? -1 : 1
      return x < y ? -1 : 1
    }
    return x < y ? -1 : 1
  }
  return ta.length - tb.length
}

// ------------------------------------------------------------- 持久化状态 ---

// 设置持久化到 host 侧文件 ($DSH_HOME/dsh-bg-atelier-plus/settings.json),
// 客户端通过 /bga/settings.json GET/PUT 读写 —— 与 dsh-whale-widget 的
// size.json 一致, 比 localStorage 可靠 (不受站点数据清理/沙箱影响)。
//
// 官方版分支 (dsh-bg-atelier-plus): 两个客户端很可能共用同一个 DSH_HOME, 所以这份设置
// **默认**落在和原插件不同的目录名上, 不然两边会互相覆盖底图/配色/特效; 派生图缓存跟着走。
//   · DSH_BG_ATELIER_SETTINGS_DIR 仍可显式覆盖 (排障/多实例);
//   · 自己那份目录还不存在、而原插件那份在时, 直接沿用原插件那份 —— 刚把 profile 从
//     dsh-bg-atelier 换成 dsh-bg-atelier-plus 时, 底图/配色/特效不用重调。
//     一旦本插件写过一次盘, 自己那份目录就存在了, 之后各写各的。
function settingsDirCandidates() {
  const env = process.env.DSH_BG_ATELIER_SETTINGS_DIR
  if (env) return [path.resolve(env)]
  const own = path.join(dshHome(), 'dsh-bg-atelier-plus')
  const original = path.join(dshHome(), 'dsh-bg-atelier')
  try {
    if (!fsSync.existsSync(path.join(own, 'settings.json')) && fsSync.existsSync(path.join(original, 'settings.json'))) {
      return [own, original]   // 先在自己那份上找, 找不到读原插件那份
    }
  } catch { /* 探不动就按默认走 */ }
  return [own]
}
function pickSettingsFile() {
  for (const dir of settingsDirCandidates()) {
    try { if (fsSync.existsSync(path.join(dir, 'settings.json'))) return { dir, file: path.join(dir, 'settings.json') } } catch { /* 下一个 */ }
  }
  const dir = settingsDirCandidates()[0]
  return { dir, file: path.join(dir, 'settings.json') }
}
const SETTINGS_PICK = pickSettingsFile()
const SETTINGS_DIR = SETTINGS_PICK.dir
const SETTINGS_FILE = SETTINGS_PICK.file
// 放图目录也可单独指向 (默认仍是原插件那个共享图库, 免得把 9GB 图片再拷一份)。
const USER_WALLPAPER_DIR = process.env.DSH_BG_ATELIER_WALLPAPERS
  ? path.resolve(process.env.DSH_BG_ATELIER_WALLPAPERS)
  : path.join(dshHome(), 'dsh-bg-atelier', 'wallpapers')

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      // 图单可能引用数百张图；仍限制请求体大小，避免旧 8KB 上限截断正常设置。
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeSettings(obj) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true })
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf8')
}

// ---- 轻量占位图 (poster) 的磁盘落点: 一个文件夹, 文件名 = key 哈希, 命中即复用,
//      底图文件本身改动 (大小/mtime 变化) 会换 key 重新生成, 旧文件自然变孤儿不碍事。
const POSTERS_DIR = path.join(SETTINGS_DIR, 'posters')
// v1.4.0: 设置页图库主图 (640px) 与类型卡迷你图 (112px) 都落盘成派生图, 只生成一次。
const PREVIEWS_DIR = path.join(SETTINGS_DIR, 'previews')
// 官方版分支新增: 「升清」用的中间档 (默认 3840 长边) 也落盘, 只生成一次。
const LARGES_DIR = path.join(SETTINGS_DIR, 'larges')
// 升清中间档的目标长边; 0 = 直接用原图 (退回"唯一一档就是原图"的老行为)。
const LARGE_DIM = 3840
const LARGE_QUALITY = 88

// 派生图规格: kind → 分辨率 / 编码质量 / 落盘目录。
const DERIVED = {
  poster:  { dim: POSTER_DIM,  quality: POSTER_QUALITY,  dir: POSTERS_DIR },
  preview: { dim: PREVIEW_DIM, quality: PREVIEW_QUALITY, dir: PREVIEWS_DIR },
  // large: 比 640 预览清楚得多、又不像 8K 原图那样要解 130MB 位图的一档。
  // 长边 ≤ LARGE_DIM 的原图不会进这条 (见 resolveWallpaper), 所以它只服务超大图。
  large:   { dim: LARGE_DIM,   quality: LARGE_QUALITY,   dir: LARGES_DIR },
}

function derivedHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return 'p' + h.toString(36)
}

// 派生图的稳定 key = 规格 + 源文件(路径+大小+mtime)。
// 源文件一改 (换图/改图), key 就变 ⇒ 旧派生图自然失效, 新图重新生成, 不用手工清缓存。
function derivedKey(kind, targetPath, info) {
  const spec = DERIVED[kind]
  return kind + '|' + spec.dim + '|' + spec.quality + '|' + targetPath + ':' + info.size + ':' + info.mtimeMs
}

function wallpaperCandidates() {
  return [
    process.env.DSH_BG_ATELIER_WALLPAPERS,
    USER_WALLPAPER_DIR,
    path.join(PACKAGE_ROOT, 'wallpapers'),
    path.join(process.cwd(), 'dsh-plugins', 'dsh-desktop-wallpaper', 'wallpapers'),
  ].filter(Boolean)
}

function isSupportedFile(e) {
  return e.isFile() && !isIgnoredName(e.name) && MIME[extOf(e.name)]
}

// ---- 标签体系 (v1.16.4) ------------------------------------------------------
// 用户要的是"一张图可能带**多个**标签": 高清版的 6·1 既要挂「重返未来1999」也要挂「高清」,
// 而普通版的 6·1 只挂「重返未来1999」; 线稿的物语花绫普通版只挂「线稿风」, 高清版两个都挂。
// 于是不能只靠"目录名 = 类型"这一条, 得让每个目录能声明它给图打什么标签。
//
// 配置放放图目录根部的 `folders.json`（可写用户目录里那份, 不进插件仓库）:
//   {
//     "folderTags": {
//       "高清": ["高清", "重返未来1999"],   // 这个目录里的图额外挂上这些
//       "线稿风": ["线稿风", "!subject"]     // "!subject" = 保留用目录名当标签
//     }
//   }
// 取值顺序: folders.json 里显式声明的 → 目录名本身 → "未分类"。
// 另外文件名里可以塞 `!主体` 覆盖（如 `亚丝娜!线稿风_高清.png`）—— 换主题时不用改 json。
const FOLDERS_FILE = 'folders.json'
const TAG_SUBJECT_HINT = '!subject'

async function readFolderTags(dir) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, FOLDERS_FILE), 'utf8'))
    const map = raw && typeof raw === 'object' ? (raw.folderTags || raw) : {}
    const out = {}
    if (map && typeof map === 'object') {
      for (const [name, value] of Object.entries(map)) {
        const list = (Array.isArray(value) ? value : [value])
          .filter((v) => typeof v === 'string' && v.trim().length > 0)
          .map((v) => v.trim())
        if (list.length) out[name] = list
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 文件名里的 `!主体` 覆盖（`某某!线稿风.png` ⇒ base 去掉这段, 标签加「线稿风」）。 */
function splitSubjectHint(stem) {
  const at = stem.lastIndexOf('!')
  if (at <= 0) return { stem, subject: '' }
  const hint = stem.slice(at + 1).trim()
  if (!hint || /[\\/]/.test(hint)) return { stem, subject: '' }
  return { stem: stem.slice(0, at), subject: hint }
}

/** 一个目录给图打的标签（去掉 "!subject" 这种指令, 保留目录名本身当标签）。 */
function tagsForFolder(folderTags, catName) {
  const declared = folderTags[catName]
  const keepFolderName = !declared || declared.includes(TAG_SUBJECT_HINT)
  const list = []
  if (declared) for (const t of declared) { if (t !== TAG_SUBJECT_HINT && !list.includes(t)) list.push(t) }
  if (keepFolderName) {
    const name = catName || '未分类'
    if (!list.includes(name)) list.unshift(name)
  }
  if (!list.length) list.push(catName || '未分类')
  return list
}

// 目录可用判定: 顶层有受支持图片, 或某个非隐藏子目录里有一张受支持图片。
async function dirHasImages(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (isSupportedFile(e)) return true
      if (e.isDirectory() && e.name.charCodeAt(0) !== 46) {
        const sub = await fs.readdir(path.join(dir, e.name), { withFileTypes: true })
        for (const f of sub) if (isSupportedFile(f)) return true
      }
    }
  } catch {
    /* not readable */
  }
  return false
}

export async function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-bg-atelier] webServer service unavailable, host half disabled')
    return
  }

  // 保证可写用户目录存在, 让用户永远有一个"往这里丢图"的地方。
  try { await fs.mkdir(USER_WALLPAPER_DIR, { recursive: true }) } catch { /* ignore */ }

  // 每次实时解析底图目录 (路由与清单共用), 不缓存, 这样往用户目录丢图后
  // 点「刷新」立刻生效, 无需重启。
  async function wallpaperDir() {
    for (const cand of wallpaperCandidates()) {
      try {
        const info = await fs.stat(cand)
        if (info.isDirectory() && await dirHasImages(cand)) return cand
      } catch { /* try next */ }
    }
    return path.join(PACKAGE_ROOT, 'wallpapers')
  }

  // 扫描单个类型目录 → { items, skipped }
  async function scanTypeDir(dir, catName) {
    const items = []
    const skipped = []
    const catDir = catName ? path.join(dir, catName) : dir
    let entries
    try {
      entries = await fs.readdir(catDir, { withFileTypes: true })
    } catch {
      return { items, skipped }
    }
    entries.sort((a, b) => compareNames(a.name, b.name))
    const folderTags = await readFolderTags(dir)
    const baseTags = tagsForFolder(folderTags, catName)
    let no = 0
    for (const e of entries) {
      if (!e.isFile()) continue
      if (isIgnoredName(e.name)) continue
      const ext = extOf(e.name)
      if (!MIME[ext]) { skipped.push((catName ? catName + '/' : '') + e.name); continue }
      const stem = stemOf(e.name)
      const hint = splitSubjectHint(stem)
      const hdInfo = splitHd(hint.stem)
      // v1.16.2: **目录名「高清」也当高清标记**。用户把图高清化之后放进高清文件夹, 文件名
      // 不带 _高清 后缀, 只认后缀的话这批图在筛选里全算"普通"; 而且"同名两版"的方案要靠
      // 文件夹区分清晰度 (高清/ 与 重返未来1999/), 目录本身就是最可靠的判据。
      const hd = hdInfo.hd || catName === '高清'
      // v1.16.4 标签: 目录声明 + 文件名 `!主体` 覆盖 + 高清时补「高清」。
      // 一张图可以同时挂「重返未来1999」和「高清」—— 用户要的就是这个(搜 6·1 出两版)。
      const tags = baseTags.slice()
      if (hint.subject && !tags.includes(hint.subject)) tags.unshift(hint.subject)
      if (hd && !tags.includes('高清')) tags.push('高清')
      no += 1
      let size = 0
      try {
        size = (await fs.stat(path.join(catDir, e.name))).size
      } catch { /* unknown size */ }
      items.push({
        name: e.name,            // 原始文件名 (内部标识用)
        base: hdInfo.base,       // 显示名 (去扩展名、去高清标记、去 `!主体`)
        hd,                      // 是否高清 (文件名标记 或 在「高清」目录里)
        tags,                    // 标签（≥1 个）: [主体, ...] + 「高清」
        no,                      // 类型内编号 (1 起, 按文件名自然序)
        url: catName
          ? URL_PREFIX + encodeURIComponent(catName) + '/' + encodeURIComponent(e.name)
          : URL_PREFIX + encodeURIComponent(e.name),
        size,
      })
    }
    return { items, skipped }
  }

  // 顶层类型目录名 (排序, 含空目录 — 空目录可作为"将要放图"的占位类型)。
  async function listTypeDirs(dir) {
    const names = []
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return names
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.charCodeAt(0) !== 46) names.push(e.name)
    }
    names.sort(compareNames)
    return names
  }

  // 生成清单: { dir, writableDir, total, skipped, categories: [...] }
  async function listWallpapers() {
    try {
      const dir = await wallpaperDir()
      const rootScan = await scanTypeDir(dir, '')   // 根目录散图 (旧版遗留)
      const categories = []
      let total = 0
      const skipped = rootScan.skipped.slice()
      if (rootScan.items.length) {
        // 根目录有散图 → 归入「未分类」类型
        total += rootScan.items.length
        categories.push({ name: '未分类', count: rootScan.items.length, hd: rootScan.items.filter((i) => i.hd).length, items: rootScan.items })
      }
      const typeDirs = await listTypeDirs(dir)
      for (const catName of typeDirs) {
        const scan = await scanTypeDir(dir, catName)
        for (const s of scan.skipped) skipped.push(s)
        total += scan.items.length
        categories.push({ name: catName, count: scan.items.length, hd: scan.items.filter((i) => i.hd).length, items: scan.items })
      }
      return { dir, writableDir: USER_WALLPAPER_DIR, total, skipped, categories }
    } catch (err) {
      console.error('[dsh-bg-atelier] list wallpapers failed: ' + String(err))
      return { dir: '', writableDir: USER_WALLPAPER_DIR, total: 0, skipped: [], categories: [] }
    }
  }

  // 底图清单 (HTTP, 供客户端 fetch)
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: LIST_PATH,
    handler: async (req, res) => {
      sendJson(res, 200, await listWallpapers())
      // 设置页刚打开/刷新 ⇒ 顺手把新图缺的派生图补上 (debounce, 不挡这次响应)。
      scheduleWarmDerived(1200)
    },
  }), 'dsh-bg-atelier: manifest route')

  // 设置持久化读写 (客户端 GET 拉取 / PUT 保存)
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      const send = (status, obj) => sendJson(res, status, obj)
      if (req.method === 'GET') { send(200, await readSettings()); return }
      if (req.method === 'PUT' || req.method === 'POST') {
        try {
          const parsed = JSON.parse(await readBody(req))
          if (!parsed || typeof parsed !== 'object') { send(400, { ok: false, error: 'invalid body' }); return }
          await writeSettings(parsed)
          send(200, { ok: true })
        } catch (err) {
          send(400, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      send(405, { ok: false, error: 'method not allowed' })
    },
  }), 'dsh-bg-atelier: settings route')

  // ---------------------------------------------------------------------------
  // 底图取回（v1.5.5）：19 张图约 333MB，**不再放进 git**，改成 GitHub Release 资产 + 按需下载。
  // 仓库里只留 wallpapers.manifest.json（路径/字节数/sha256），下载逻辑在 fetch-wallpapers.js
  // —— 与命令行 tools/fetch-wallpapers.mjs 是**同一份实现**，两边行为不会漂。
  // 设置页的「下载底图」按钮打这两个路由：
  //   GET  /bga/wallpapers/fetch-status  看进度（页面每 800ms 轮询）
  //   POST /bga/wallpapers/fetch         开始/继续（已在跑就原样返回，不会起第二份）
  // 逐张校验 sha256、已存在且通过的一律跳过 ⇒ 可反复点、可断点续传；单张失败不影响其余。
  // ---------------------------------------------------------------------------
  let fetchState = { running: false, done: 0, total: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0, errors: [], startedAt: 0, finishedAt: 0, error: '' }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/bga/wallpapers/fetch-status',
    handler: async (req, res) => {
      sendJson(res, 200, { ...fetchState, errors: fetchState.errors.slice(0, 8) })
    },
  }), 'dsh-bg-atelier: fetch-status route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/bga/wallpapers/fetch',
    handler: async (req, res) => {
      const send = (status, obj) => sendJson(res, status, obj)
      if (req.method !== 'POST') { send(405, { ok: false, error: 'method not allowed' }); return }
      if (fetchState.running) { send(200, { ok: true, running: true, note: 'already running' }); return }
      let manifest
      try { manifest = readManifest() } catch (err) {
        send(400, { ok: false, error: '读不到 wallpapers.manifest.json：' + String((err && err.message) || err) })
        return
      }
      fetchState = { running: true, done: 0, total: manifest.total, downloaded: 0, skipped: 0, failed: 0, bytes: 0, errors: [], startedAt: Date.now(), finishedAt: 0, error: '' }
      console.log('[dsh-bg-atelier] 开始从 Release 取回底图：' + manifest.total + ' 张 · ' + manifest.release.base)
      // 后台跑，不阻塞这次响应（19 张要好几分钟）
      fetchWallpapers({
        manifest,
        onProgress: (p) => {
          fetchState.done = p.done
          fetchState.downloaded = p.downloaded
          fetchState.skipped = p.skipped
          fetchState.failed = p.failed
          fetchState.bytes = p.bytes
        },
      }).then((r) => {
        fetchState.running = false
        fetchState.finishedAt = Date.now()
        fetchState.errors = r.errors || []
        fetchState.failed = r.failed
        console.log('[dsh-bg-atelier] 底图取回结束：下载 ' + r.downloaded + ' 张（' + (r.bytes / 1048576).toFixed(1) + ' MB）· 跳过 ' + r.skipped + ' · 失败 ' + r.failed)
      }).catch((err) => {
        fetchState.running = false
        fetchState.finishedAt = Date.now()
        fetchState.error = String((err && err.message) || err)
        console.warn('[dsh-bg-atelier] 底图取回失败：' + fetchState.error)
      })
      send(202, { ok: true, started: true, total: manifest.total, bytes: manifest.totalBytes })
    },
  }), 'dsh-bg-atelier: fetch route')

  // 读取并(可选)缩放单张底图: 不改动原始文件。
  // kind: ''(真正使用的底图 —— 默认原图原样, 不设上限) | 'thumb'(320) | 'poster'(112px 类型卡迷你图) | 'preview'(640px 图库主图)。
  // 长边 ≤ 目标的图原样输出。需要缩放的那条路按 相对路径+大小+mtime 缓存。
  // poster/preview 是"打开即出、不拖慢图库"的关键: 首次生成后写盘到
  // $DSH_HOME/dsh-bg-atelier/{posters,previews}/, 之后重启/再打开都直接读盘, 不再对每张原图重缩。
  // 派生图 (poster/preview) 统一入口: 内存缓存 → 磁盘缓存 → sharp 现生成并落盘。
  // 原始文件只读不改; 源文件 mtime/大小一变, derivedKey 就变, 旧图自动失效重生成。
  async function resolveDerived(targetPath, info, kind) {
    const spec = DERIVED[kind]
    const h = derivedHash(derivedKey(kind, targetPath, info))
    const file = path.join(spec.dir, h + '.webp')
    const mem = derivedMemCache.get(h)
    if (mem !== undefined) return { buffer: mem, mime: 'image/webp' }
    try {
      const disk = await fs.readFile(file)
      derivedMemCache.set(h, disk)
      return { buffer: disk, mime: 'image/webp' }
    } catch { /* 未生成, 继续 */ }
    const src = await fs.readFile(targetPath)
    const sh = await getSharp()
    if (sh) {
      try {
        const out = await sh(src)
          .resize({ width: spec.dim, height: spec.dim, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: spec.quality })
          .toBuffer()
        derivedMemCache.set(h, out)
        try { await fs.mkdir(spec.dir, { recursive: true }); await fs.writeFile(file, out) } catch { /* 写不进就只在内存缓存 */ }
        return { buffer: out, mime: 'image/webp' }
      } catch (e) { /* 不支持格式 → 原样返回 */ }
    }
    return { buffer: src, mime: MIME[extOf(targetPath)] }
  }

  async function resolveWallpaper(targetPath, kind) {
    const info = await fs.stat(targetPath)
    if (!info.isFile()) throw new Error('not a file')
    if (info.size > MAX_BYTES) throw new Error('file too large')
    const key = targetPath + ':' + info.size + ':' + info.mtimeMs
    // poster(112px 类型卡) / preview(640px 图库主图) 走"落盘派生图"这条: 只生成一次。
    if (kind === 'poster' || kind === 'preview') return resolveDerived(targetPath, info, kind)
    // 「升清」中间档 (官方版分支新增): 客户端先铺 640 预览、再换这一档。
    // 只对**比中间档还大**的原图有意义 —— 长边 ≤ LARGE_DIM 的图连派生都不做,
    // 直接把原文件字节送出去 (清晰度零损失, 也省掉一次重编码)。
    if (kind === 'large') {
      if (LARGE_DIM <= 0) return { buffer: await fs.readFile(targetPath), mime: MIME[extOf(targetPath)] }
      const sh = await getSharp()
      if (sh) {
        try {
          const meta = await sh(targetPath).metadata()
          const long = Math.max(meta.width || 0, meta.height || 0)
          if (long > 0 && long <= LARGE_DIM) return { buffer: await fs.readFile(targetPath), mime: MIME[extOf(targetPath)] }
          return await resolveDerived(targetPath, info, 'large')
        } catch { /* 读不出尺寸就退回原图, 宁可大也不要空 */ }
      }
      return { buffer: await fs.readFile(targetPath), mime: MIME[extOf(targetPath)] }
    }
    const thumb = kind === 'thumb'
    const dim = thumb ? THUMB_DIM : SERVED_MAX_DIM
    // 不设上限 (dim === 0): 直接把原文件**字节**送出去 —— 不缩放、不重编码、也不进内存缓存。
    // 这条路上 sharp 完全不参与 ⇒ 省掉一次"解码+重编码"的 CPU 与几秒的首字节等待。
    if (dim <= 0) return { buffer: await fs.readFile(targetPath), mime: MIME[extOf(targetPath)] }
    const cache = thumbBufferCache   // 只有 thumb 会走到这条 (SERVED_MAX_DIM 恒为 0)
    const hit = cache.get(key)
    if (hit !== undefined && hit.key === key) return { buffer: hit.buffer, mime: MIME[extOf(targetPath)] }
    let buffer = await fs.readFile(targetPath)
    const sh = await getSharp()
    if (sh) {
      try {
        const meta = await sh(buffer).metadata()
        const long = Math.max(meta.width || 0, meta.height || 0)
        if (long > dim) {
          buffer = await sh(buffer)
            .resize({ width: dim, height: dim, fit: 'inside', withoutEnlargement: true })
            .toBuffer()
        }
      } catch (e) { /* 不支持/失败则输出原始文件 */ }
    }
    cache.set(key, { key, buffer })
    return { buffer, mime: MIME[extOf(targetPath)] }
  }

  // 按原始文件名在"根目录 + 各类型目录"里找回文件 (旧版根目录 URL 平滑迁移用)。
  async function findByFileName(dir, fileName, kind) {
    try {
      return await resolveWallpaper(path.join(dir, fileName), kind)
    } catch { /* 根目录没有, 去类型里找 */ }
    const typeDirs = await listTypeDirs(dir)
    for (const catName of typeDirs) {
      try {
        return await resolveWallpaper(path.join(dir, catName, fileName), kind)
      } catch { /* 下一个类型 */ }
    }
    throw new Error('not found')
  }

  // ------------------------------------------------------ 派生图预热 (v1.4.0) --
  // 目标: 新丢进放图目录的图, 不用等"谁第一次打开设置页"才缩图 —— 插件启动后
  // 后台把还没生成过派生图的图补齐 (preview 640px + poster 112px 各一份, 落盘)。
  // 已生成过的直接跳过 (derivedKey 命中磁盘缓存), 所以是幂等的:
  //   · 启动后延时跑一次 (先让宿主把该起的东西起完);
  //   · 每次 /bga/wallpapers.json (设置页打开/刷新) 之后 debounce 再补一次。
  // 串行 + 每张之间让出事件循环, 不跟 agent 抢 CPU; 生成失败的单张直接跳过。
  let warmRunning = false
  let warmQueued = null
  async function warmDerivedImages() {
    if (warmRunning) return
    warmRunning = true
    try {
      const sh = await getSharp()
      if (!sh) return
      const dir = await wallpaperDir()
      const files = []
      const collect = async (catName) => {
        const catDir = catName ? path.join(dir, catName) : dir
        let entries
        try { entries = await fs.readdir(catDir, { withFileTypes: true }) } catch { return }
        for (const e of entries) if (isSupportedFile(e)) files.push(path.join(catDir, e.name))
      }
      await collect('')
      for (const catName of await listTypeDirs(dir)) await collect(catName)
      let made = 0
      for (const file of files) {
        try {
          const info = await fs.stat(file)
          if (info.size > MAX_BYTES) continue
          for (const kind of Object.keys(DERIVED)) {
            const spec = DERIVED[kind]
            const h = derivedHash(derivedKey(kind, file, info))
            if (derivedMemCache.has(h)) continue
            try {
              await fs.access(path.join(spec.dir, h + '.webp'))
              continue   // 已落盘, 跳过 (不读原图, 不重编码)
            } catch { /* 需要生成 */ }
            // large 档只对"比中间档还大"的原图存在: 小图那条路直接送原文件,
            // 先探一次尺寸, 免得白给 313 张图各生成一份永远没人请求的派生图。
            if (kind === 'large') {
              try {
                const meta = await sh(file).metadata()
                const long = Math.max(meta.width || 0, meta.height || 0)
                if (long > 0 && long <= LARGE_DIM) continue
              } catch { continue }
            }
            await resolveDerived(file, info, kind)
            made += 1
          }
        } catch { /* 单张失败不影响其它 */ }
        await new Promise((r) => setTimeout(r, 80))   // 让出事件循环, 别占满 CPU
      }
      if (made > 0) console.log('[dsh-bg-atelier] warmed ' + made + ' derived image(s) for ' + files.length + ' wallpaper(s)')
    } catch (e) {
      console.error('[dsh-bg-atelier] warm derived images failed: ' + String(e))
    } finally {
      warmRunning = false
    }
  }
  // debounce: 多次触发合并成一次; 已经跑着就直接跳过 (跑完时若又有新触发, 下一轮再补)。
  function scheduleWarmDerived(delayMs) {
    if (warmQueued !== null) clearTimeout(warmQueued)
    warmQueued = setTimeout(() => { warmQueued = null; warmDerivedImages() }, delayMs)
  }

  // 底图文件路由 (Fiber 回收时自动注销)
  //   新格式: /bga/wallpapers/<编码后类型名>/<编码后文件名>
  //   旧格式: /bga/wallpapers/<编码后文件名> (兼容旧版根目录 URL)
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const reply = (status, headers, body) => {
        try {
          res.writeHead(status, headers || {})
          res.end(body)
        } catch (e) { /* socket already gone */ }
      }
      const url = String((req && req.url) || '')
      const qIndex = url.indexOf('?')
      const raw = qIndex >= 0 ? url.slice(0, qIndex) : url
      const query = qIndex >= 0 ? url.slice(qIndex + 1) : ''
      const szM = /(^|[?&])sz=([a-z0-9]+)/i.exec(query)
      const kind = szM ? szM[2].toLowerCase() : ''   // '' 原图 | large(升清档) | thumb | poster | preview
      if (kind !== '' && kind !== 'large' && kind !== 'thumb' && kind !== 'poster' && kind !== 'preview') { reply(400); return }
      if (raw.indexOf(URL_PREFIX) !== 0) { reply(404); return }
      const rest = raw.slice(URL_PREFIX.length)
      if (!rest) { reply(400); return }
      // 解码并做路径安全校验 (拒绝 .. / 分隔符注入)
      let segs
      try {
        segs = rest.split('/').map(decodeURIComponent)
      } catch (e) { reply(400); return }
      if (segs.length > 2) { reply(400); return }
      for (const seg of segs) {
        if (!seg || seg.indexOf('/') >= 0 || seg.indexOf('\\') >= 0 || seg.indexOf('..') >= 0) {
          reply(400)
          return
        }
      }
      const dir = await wallpaperDir()
      try {
        let result
        if (segs.length === 1) {
          // 旧格式: 根目录文件名, 找不到则自动按文件名去各类型里找
          result = await findByFileName(dir, segs[0], kind)
        } else {
          const target = path.join(dir, segs[0], segs[1])
          result = await resolveWallpaper(target, kind)
        }
        // poster/thumb 允许浏览器强缓存 1 天 (重开底图工坊不再整批重拉/重缩, 明显更跟手);
        // poster 还额外落盘到 posters/ 文件夹, 连服务端重缩都省掉;
        // 原图(实际使用时)也缓存 1 小时 — 新增/改名的图会生成新 URL, 不受旧缓存影响。
        const cc = kind !== '' ? 'public, max-age=86400' : 'public, max-age=3600'
        reply(200, {
          'content-type': result.mime,
          'cache-control': cc,
          'content-length': result.buffer.length,
        }, result.buffer)
      } catch (e) {
        reply(404)
      }
    },
  }), 'dsh-bg-atelier: wallpaper route')

  // ---- WE (Wallpaper Engine) 库路由 (/bga/we/*) ----
  // Launch the official WE CLI without a shell; the application owns its lifetime.
  const spawnLauncher = (exe, args) => new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('spawn', () => { child.unref(); resolve() })
  })
  // 解包出静态图 (scene.pkg → webp) 的落点与 sharp 来源: 与 poster/preview 同属派生图，
  // 放同一个设置目录下，换机/清缓存时一起清。
  ctx.effect(() => registerWeRoutes(webServer, {
    spawnLauncher,
    stillsDir: path.join(SETTINGS_DIR, 'we-stills'),
    sharpCandidates: sharpCandidates(),
  }), 'dsh-bg-atelier: we routes')

  const dir = await wallpaperDir()
  // 启动后延时预热派生图: 新丢进来的图不用等第一次打开设置页才缩图。
  scheduleWarmDerived(4000)
  // 版本号从 package.json 读进来 (原来是硬编码, 早就落后好几个版本了)。
  let ver = '?'
  try { ver = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version } catch (e) { /* 读不到就显示 ? */ }
  console.log('[dsh-bg-atelier] host up (v' + ver + '), serving ' + dir + ' at ' + URL_PREFIX + '<类型>/<文件>')
}
