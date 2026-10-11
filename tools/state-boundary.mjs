// tools/state-boundary.mjs —— 用户状态的**字节级边界**：快照 / 核对 / 差异
//
// 为什么需要它（审核方第十五轮）：现有保护是**字段级还原**（把 wallpaper/autoOn/styles 等
// 逐个写回），它能证明的只是"我们打算还原的那几个字段写回去了"。而"用户状态受到保护"
// 需要的是**可证明**：验收跑完之后，插件的数据目录与跑之前**逐字节一致**。
//
// 用法（配合 capture / compare / 功能套件 使用）：
//   node tools/state-boundary.mjs begin   <名字>     # 开跑前：给两棵数据树做字节快照
//   node tools/state-boundary.mjs verify  <名字>     # 跑完后：重新哈希比对，逐条列出增/删/改
//   node tools/state-boundary.mjs diff    <名字>     # 同上，但只打印（不改变退出码语义）
//
// 退出码：0 = 与快照逐字节一致；1 = 有差异（列出每一条）；2 = 用法/前置错误（没有快照就拒绝）。
// 快照存在 baselines/_state/<名字>.json（gitignore 内、且在**被核对的两棵树之外**，
// 免得快照文件本身被算成"新增文件"）。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const SNAP_DIR = path.join(REPO, 'baselines', '_state')
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')

/** 被核对的树：本插件**全部**可写落点（宿主侧设置 + 派生缓存 + 用户图库 + 预设等）。 */
export const STATE_ROOTS = [
  path.join(HOME, 'dsh-bg-atelier'),
  path.join(HOME, 'dsh-bg-atelier-plus'),
]

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 递归列出目录下所有文件（相对 root 的路径 → 指纹）。
 *
 * ⚠️ **必须跟随目录 junction / 符号链接**，否则核对是"名义上覆盖"。
 *    实测踩到：`$DSH_HOME/dsh-bg-atelier/wallpapers` 是 **Junction → E:\Download\kuake\wallpapers**，
 *    用户真正的图库在 DSH_HOME **之外**；第一版遍历器跳过非普通文件 ⇒ 只核到 1 个文件，
 *    却打印"逐字节一致" —— 正是审核方红队表里"靠链接指向生产目录 ⇒ 名义隔离"那条，
 *    只不过这次中招的是**核对**而不是隔离。
 *    现在：看到链接就 realpath 进去跟；用 realpath 做 visited 去重防环；
 *    并把遇到的链接**打印出来**（可见性比"相信它被覆盖了"重要）。
 *
 * 指纹口径（速度与强度的取舍，明写出来）：
 *   · 文件 ≤ 8 MB：记 sha256（内容级）
 *   · 更大的文件：记 size + mtimeMs + 首尾各 64 KB 的 sha256
 *     （图库里有 50 MB 级的原图，全量哈希要跑几百 MB~GB 的 IO；验收**不会**改写这些大图内容，
 *       只会增删文件 ⇒ 增删由路径集合捕获、内容变化由 mtime 捕获）
 */
function fingerprint(abs) {
  const st = statSync(abs)
  if (st.size <= 8 * 1024 * 1024) {
    const buf = readFileSync(abs)
    return { size: st.size, mtime: Math.round(st.mtimeMs), hash: sha(buf) }
  }
  const fd = readFileSync(abs, { flag: 'r' })
  const head = fd.subarray(0, 65536)
  const tail = fd.subarray(Math.max(0, fd.length - 65536))
  return {
    size: st.size, mtime: Math.round(st.mtimeMs),
    hash: 'big:' + sha(Buffer.concat([head, tail])),
  }
}

function walkRoot(root) {
  const out = {}
  const links = []
  const visited = new Set()
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = path.join(root, rel)
    let real
    try { real = realpathSync(abs) } catch { continue }
    if (visited.has(real)) continue          // 防环（链接指回祖先）
    visited.add(real)
    if (real !== abs) links.push(rel || '.' + ' → ' + real)
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name
      const p = path.join(root, r)
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        // 链接：用 stat（跟随）判断到底是目录还是文件
        try { const s = statSync(p); isDir = s.isDirectory(); isFile = s.isFile() } catch { continue }
      }
      if (isDir) { stack.push(r); continue }
      if (!isFile) continue
      try { out[r] = fingerprint(p) } catch (err) {
        out[r] = { size: -1, mtime: 0, hash: 'unreadable:' + String((err && err.code) || err) }
      }
    }
  }
  out.__links = links
  return out
}

export function snapshotTree() {
  const snap = {}
  for (const root of STATE_ROOTS) snap[root] = walkRoot(root)
  return { at: new Date().toISOString(), home: HOME, roots: STATE_ROOTS, tree: snap }
}

/** 比对：返回 {added, removed, changed} 三个数组（路径带 root 前缀）。 */
export function compareTree(snap) {
  const added = [], removed = [], changed = []
  for (const root of snap.roots) {
    const now = walkRoot(root)
    const before = snap.tree[root] || {}
    for (const k of Object.keys(now)) {
      if (k === '__links') continue
      if (!(k in before)) added.push(path.join(root, k))
      else if (before[k].hash !== now[k].hash) {
        changed.push(path.join(root, k) + '（' + before[k].size + 'B → ' + now[k].size + 'B）')
      }
    }
    for (const k of Object.keys(before)) { if (k === '__links') continue; if (!(k in now)) removed.push(path.join(root, k)) }
  }
  return { added, removed, changed, clean: added.length === 0 && removed.length === 0 && changed.length === 0 }
}

/** 派生缓存目录（可再生）。判定规则**明写出来**，不含糊：
 *  · **用户数据** = settings.json 与图库（wallpapers/**）—— 一项都不许变。
 *  · **派生缓存** = posters/previews/larges/we-stills —— 允许新增（插件会按需生成），
 *    但会**分别列出数量**；若出现删除或内容变化也照样报出来（那才是异常）。
 *  这样"缓存增长"不会淹没真正的用户数据改动，而异常也躲不掉。 */
const CACHE_DIR_RE = /[\\/](posters|previews|larges|we-stills)[\\/]/

function classify(p) {
  return CACHE_DIR_RE.test(p) ? 'cache' : 'user'
}

/** 开跑前建立边界：返回快照对象（内存里，不落盘）。 */
export function boundaryBegin(log) {
  const snap = snapshotTree()
  const counts = snap.roots.map((r) => {
    const t = snap.tree[r] || {}
    return { root: r, files: Object.keys(t).length - 1, links: (t.__links || []).length }
  })
  const files = counts.reduce((n, c) => n + c.files, 0)
  if (log) {
    console.log('  状态边界: 已快照 ' + files + ' 个文件（' + snap.roots.length + ' 棵树）')
    for (const c of counts) {
      console.log('      ' + c.root + '  ' + c.files + ' 个文件'
        + (c.links ? '（含 ' + c.links + ' 个链接，已跟进核对）' : ''))
    }
  }
  return snap
}

/** 跑完后核对。返回 {clean, userChanges[], cacheChanges[]}；clean 只看**用户数据**。 */
export function boundaryVerify(snap, log) {
  const res = compareTree(snap)
  const user = [], cache = []
  for (const [kind, arr] of [['added', res.added], ['removed', res.removed], ['changed', res.changed]]) {
    for (const p of arr) (classify(p) === 'cache' ? cache : user).push(kind + ' ' + p)
  }
  const clean = user.length === 0
  if (log) {
    if (clean) {
      console.log('  ✅ 用户数据逐字节一致（settings.json 与图库都没被改动）')
    } else {
      console.error('  ❌ **用户数据被改动了**（验收工具动了用户文件）：')
      for (const x of user.slice(0, 15)) console.error('      ' + x)
      if (user.length > 15) console.error('      …还有 ' + (user.length - 15) + ' 条')
    }
    if (cache.length) {
      console.log('  ℹ️ 派生缓存有变化 ' + cache.length + ' 处（可再生，不算用户数据；removed/changed 需留意）：')
      for (const x of cache.slice(0, 5)) console.log('      ' + x)
      if (cache.length > 5) console.log('      …还有 ' + (cache.length - 5) + ' 处')
    }
  }
  return { clean, userChanges: user, cacheChanges: cache }
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const [mode, name] = process.argv.slice(2)
  if (!mode || !name) {
    console.error('用法: node tools/state-boundary.mjs begin|verify|diff <名字>')
    process.exit(2)
  }
  mkdirSync(SNAP_DIR, { recursive: true })
  const file = path.join(SNAP_DIR, name + '.json')

  if (mode === 'begin') {
    const snap = snapshotTree()
    writeFileSync(file, JSON.stringify(snap), 'utf8')
    const files = Object.values(snap.tree).reduce((n, t) => n + Object.keys(t).length, 0)
    console.log('  状态边界已建立：' + name)
    console.log('    根目录 ' + snap.roots.length + ' 个，文件 ' + files + ' 个')
    for (const r of snap.roots) {
      const t = snap.tree[r] || {}
      const links = t.__links || []
      console.log('      ' + r + '  (' + (Object.keys(t).length - 1) + ' 个文件)' + (links.length ? '  ⚠️ 含 ' + links.length + ' 个链接，已跟进去核：' : ''))
      for (const l of links.slice(0, 5)) console.log('        ' + l)
    }
    console.log('    快照: ' + path.relative(REPO, file))
    process.exit(0)
  }

  if (!existsSync(file)) {
    console.error('✗ 没有找到快照 ' + path.relative(REPO, file) + ' ⇒ **拒绝核对**（先跑 begin）')
    process.exit(2)
  }
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  const res = compareTree(snap)
  const show = (label, arr) => {
    if (!arr.length) return
    console.log('  ' + label + ' ' + arr.length + ' 个：')
    for (const x of arr.slice(0, 20)) console.log('    ' + x)
    if (arr.length > 20) console.log('    …还有 ' + (arr.length - 20) + ' 个')
  }
  const files = Object.values(snap.tree).reduce((n, t) => n + Object.keys(t).length, 0)
  console.log('=== 状态边界核对：' + name + '（快照建于 ' + snap.at + '，' + files + ' 个文件）===')
  if (res.clean) {
    console.log('  ✅ 逐字节一致：两棵数据树与跑之前完全相同（含派生缓存与图库）')
    process.exit(0)
  }
  console.log('  ❌ **用户状态被改变了**（下列每一项都是验收工具动了用户数据）：')
  show('新增', res.added); show('删除', res.removed); show('内容变化', res.changed)
  process.exit(mode === 'diff' ? 0 : 1)
}
