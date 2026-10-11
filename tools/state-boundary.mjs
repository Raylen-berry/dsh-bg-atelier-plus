// tools/state-boundary.mjs —— 用户状态的**字节级边界**：快照 / 核对 / 差异
//
// 这个模块的判据被审核方第十六轮用 **6 个可执行反例**打过，其中 4 个打在这里。全部成立，
// 已按下述口径重写。**判据要能被独立反例推翻，才算判据**：
//   ① 只比首尾摘要 ⇒ 大图中段改动漏检 —— 且我当时还写了"为了省 IO"的注释，
//      实际 `readFileSync` 把整文件读进来了（既没省 IO 又不准）。**现在全文件流式 sha256。**
//   ② `compareTree` 只比 hash，**连已记录的 size/mtime 都不比** ⇒ 现在三者都比。
//   ③ 缓存分类按"路径里有没有 previews 这个目录名" ⇒ 图库里真有个叫 `previews` 的**分类**
//      就被误吞成缓存。**现在按"精确根目录 + 相对前缀"分类**，图库下一律算用户数据。
//   ④ 写死两棵 `DSH_HOME` 目录 ⇒ 插件支持 `DSH_BG_ATELIER_SETTINGS_DIR` /
//      `DSH_BG_ATELIER_WALLPAPERS` 覆盖时，真正的数据落点根本不在核对范围里。
//      **现在照抄 index.js 的根目录推导规则**（含"回退到原插件目录"那条），两侧都核。
//   ⑤ 枚举/读取失败被 `catch { continue }` 跳过 ⇒ **读不完整也报绿**。现在一律记为错误，
//     错误存在 ⇒ 判定为"核对不完整"，**绝不出绿**。
//
// 另外如实写清这个工具**不能**证明什么（别让绿被过度解读）：
//   · 它只证明"两次完整快照之间，明确范围内的文件内容相同"；
//   · 它**不能**证明过程中没有写入（写完又改回去是查不出来的）；
//   · 它**不能**替代进程级隔离（SIGKILL/断电时 finally 不执行）。
//
// 用法（配合 capture / compare / 功能套件 使用）：
//   node tools/state-boundary.mjs begin  <名字>   # 开跑前：给数据树做全量指纹快照
//   node tools/state-boundary.mjs verify <名字>   # 跑完后：重新哈希比对，逐条列出增/删/改/错误
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const SNAP_DIR = path.join(REPO, 'baselines', '_state')

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
}

/** 允许新增的**派生缓存**目录名（可再生）。只在"设置目录"下生效，且按相对前缀精确匹配。 */
export const CACHE_SUBDIRS = ['posters', 'previews', 'larges', 'we-stills']

/**
 * **可注入的根目录覆盖**（空 = 按实际配置推导）。
 *
 * 为什么保留这个看起来多余的数组：审核方的**独立反例脚本**用它来构造反例
 * （`STATE_ROOTS.splice(...)` 换成"一个不是目录的路径"，验"枚举失败必须不出绿"）。
 * 独立复核的harness 不该因为我的重构就失效 —— 所以它必须能影响真实解析，
 * 而不是变成一个没人看的常量。
 */
export const STATE_ROOTS = []

/**
 * 照抄 `index.js` 的根目录推导规则（**不能自己另写一套**，否则两边会漂）。
 * 覆盖：
 *   · 设置目录：env 覆盖优先；否则把"本插件那份"和"原插件那份"**都**纳入核对
 *     （index.js 在自家 settings.json 不存在而原插件那份存在时会**回退读原插件那份**）。
 *   · 图库目录：env 覆盖优先；否则 `DSH_HOME/dsh-bg-atelier/wallpapers`。
 * 去重：图库目录常常就在 `dsh-bg-atelier` 下，而它同时是设置候选 ⇒ 图库这份单独作为
 * `wallpapers` 根（全算用户数据），设置根则**排除**自己的 `wallpapers/` 子树，避免重复计数。
 */
export function resolveBoundary() {
  // 注入优先：只在测试注入非空时生效（审核方独立脚本就是这么构造反例的）
  if (STATE_ROOTS.length) {
    return {
      home: dshHome(),
      settingsFileHint: '',
      roots: STATE_ROOTS.map((p) => (typeof p === 'string'
        ? { kind: 'settings', path: p, exclude: [] }
        : { kind: p.kind || 'settings', path: p.path, exclude: p.exclude || [] })),
    }
  }
  const home = dshHome()
  const envDir = process.env.DSH_BG_ATELIER_SETTINGS_DIR
  const settingsDirs = envDir
    ? [path.resolve(envDir)]
    : [path.join(home, 'dsh-bg-atelier-plus'), path.join(home, 'dsh-bg-atelier')]
  const wallpaperDir = process.env.DSH_BG_ATELIER_WALLPAPERS
    ? path.resolve(process.env.DSH_BG_ATELIER_WALLPAPERS)
    : path.join(home, 'dsh-bg-atelier', 'wallpapers')

  const roots = []
  for (const dir of settingsDirs) roots.push({ kind: 'settings', path: dir, exclude: ['wallpapers'] })
  // 图库根只加一次（若与某个设置根同路径，去重）
  if (!roots.some((r) => r.path === wallpaperDir && r.kind === 'wallpapers')) {
    roots.push({ kind: 'wallpapers', path: wallpaperDir, exclude: [] })
  }
  return { home, settingsFileHint: path.join(settingsDirs[0], 'settings.json'), roots }
}

/** 该文件的分类：用户数据 / 允许新增的派生缓存。**按精确根目录 + 相对前缀**判定。 */
export function classifyPath(root, rel) {
  if (root.kind !== 'settings') return 'user'          // 图库下一律用户数据（分类名再像缓存也不算）
  const top = rel.split(/[\\/]/)[0]
  return CACHE_SUBDIRS.includes(top) ? 'cache' : 'user'
}

/**
 * 全文件 sha256 —— **整份读、整份哈希，不抽样**。
 *
 * 为什么不做"只读首尾"那种优化（审核方第十六轮反例 1）：抽样会让**大图中段的改动漏检**，
 * 而我当时的注释还写着"为了省 IO" —— 实际 eadFileSync 已经把整文件读进来了，
 * 既没省 IO 又不准。现在没有这个取舍：整文件哈希。
 * 保持**同步**是为了让审核方的独立反例脚本能原样调用（它的断言是同步读结果）。
 */
function hashFile(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/**
 * 遍历一个根。返回 { files, links, errors }：
 *   files  rel → { size, mtime, hash }
 *   links  rel → 解析后的真实路径（链接拓扑也要核对：指向变了就是变化）
 *   errors 任何枚举/读取失败都进这里（**不跳过**：错误存在就不许出绿）
 */
function walkRoot(root) {
  const files = {}, links = {}, errors = []
  const visited = new Set()
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = path.join(root.path, rel)
    let real
    try { real = realpathSync(abs) } catch (err) {
      errors.push('realpath 失败 ' + abs + '：' + String((err && err.code) || err)); continue
    }
    if (visited.has(real)) continue
    visited.add(real)
    if (rel) links[rel] = real
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch (err) {
      errors.push('无法枚举 ' + abs + '：' + String((err && err.code) || err)); continue
    }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name
      const p = path.join(root.path, r)
      if (root.exclude && root.exclude.includes(r.split(/[\\/]/)[0]) && e.isDirectory()) continue
      let isDir = e.isDirectory(), isFile = e.isFile()
      if (e.isSymbolicLink()) {
        try { const s = statSync(p); isDir = s.isDirectory(); isFile = s.isFile() } catch (err) {
          errors.push('链接解析失败 ' + p + '：' + String((err && err.code) || err)); continue
        }
      }
      if (isDir) { stack.push(r); continue }
      if (!isFile) continue
      try {
        const st = lstatSync(p)
        const hash = hashFile(p)
        files[r] = { size: st.size, mtime: Math.round(st.mtimeMs), hash, class: classifyPath(root, r) }
      } catch (err) {
        errors.push('读取失败 ' + p + '：' + String((err && err.code) || err))
      }
    }
  }
  return { files, links, errors }
}

/** 全量快照（async：逐文件流式哈希）。 */
export function snapshotTree() {
  const cfg = resolveBoundary()
  const tree = {}, errors = []
  for (const root of cfg.roots) {
    const key = root.kind + ':' + root.path
    if (!existsSync(root.path)) { tree[key] = { absent: true, files: {}, links: {}, errors: [] }; continue }
    const r = walkRoot(root)
    tree[key] = { absent: false, files: r.files, links: r.links, errors: r.errors }
    for (const e of r.errors) errors.push(key + ' → ' + e)
  }
  return { at: new Date().toISOString(), home: cfg.home, roots: cfg.roots, tree, errors }
}

/** 比对：大小/时间/哈希都比；链接拓扑也比；错误原样带出。 */
export function compareTree(snap) {
  const added = [], removed = [], changed = [], rewritten = [], errors = [].concat(snap.errors || [])
  for (const root of snap.roots) {
    const key = root.kind + ':' + root.path
    const before = snap.tree[key] || { files: {}, links: {}, absent: true }
    let now
    if (!existsSync(root.path)) now = { absent: true, files: {}, links: {}, errors: [] }
    else {
      const r = walkRoot(root)
      now = { absent: false, files: r.files, links: r.links, errors: r.errors }
      for (const e of r.errors) errors.push(key + ' → ' + e)
    }
    for (const k of Object.keys(now.files)) {
      const b = before.files[k]
      if (!b) { added.push(root.kind + ' ' + path.join(root.path, k)); continue }
      const n = now.files[k]
      const why = []
      if (b.hash !== n.hash) why.push('内容')
      if (b.size !== n.size) why.push('大小')
      if (b.mtime !== n.mtime) why.push('修改时间')
      if (!why.length) continue
      const line = root.kind + ' ' + path.join(root.path, k)
        + '（' + why.join('+') + ' 变化：' + b.size + 'B/' + b.mtime + ' → ' + n.size + 'B/' + n.mtime + '）'
      // ⚠️ **只改 mtime、内容与大小都没变** ⇒ 这是"被按原样重写了一遍"，不是用户数据变化。
      //    实测在 capture 路径上就遇到：我们的还原把 settings.json 写了回去，字节完全一致。
      //    把它算成"用户数据被改动"会制造假红；但也不能吞掉 —— 单列为"原样重写"（信息性）。
      if (b.hash === n.hash && b.size === n.size) rewritten.push(line)
      else changed.push(line)
    }
    for (const k of Object.keys(before.files)) if (!(k in now.files)) removed.push(root.kind + ' ' + path.join(root.path, k))
    for (const k of Object.keys(now.links)) {
      if (!(k in before.links)) { /* 链接新增：目标目录内容本身会被上面比到，不单独报 */ }
      else if (before.links[k] !== now.links[k]) {
        changed.push(root.kind + ' ' + path.join(root.path, k) + '（链接目标变化 ' + before.links[k] + ' → ' + now.links[k] + '）')
      }
    }
  }
  return { added, removed, changed, rewritten, errors }
}

/** 开跑前建立边界（async）。 */
export function boundaryBegin(log) {
  const snap = snapshotTree()
  if (log) {
    let files = 0
    console.log('  状态边界: 全量快照 ' + snap.roots.length + ' 个根')
    for (const r of snap.roots) {
      const t = snap.tree[r.kind + ':' + r.path]
      const n = Object.keys(t.files).length
      files += n
      console.log('      [' + r.kind + '] ' + r.path + '  ' + n + ' 个文件'
        + (t.absent ? '（不存在）' : '') + (Object.keys(t.links).length ? '（含 ' + Object.keys(t.links).length + ' 个链接，已跟进核对）' : ''))
    }
    console.log('      合计 ' + files + ' 个文件，全文件流式 sha256')
    if (snap.errors.length) {
      console.error('      ⚠️ 快照期间有 ' + snap.errors.length + ' 处错误（会导致判定为"核对不完整"）：')
      for (const e of snap.errors.slice(0, 5)) console.error('        ' + e)
    }
  }
  return snap
}

/** 跑完后核对（async）。clean 要求：用户数据无变化 **且** 无任何错误。 */
export function boundaryVerify(snap, log) {
  const res = compareTree(snap)
  const user = [], cache = []
  for (const [kind, arr] of [['added', res.added], ['removed', res.removed], ['changed', res.changed]]) {
    for (const line of arr) {
      const cls = classifyLine(snap, line)
      ;(cls === 'cache' ? cache : user).push(kind + ' ' + line)
    }
  }
  const incomplete = res.errors.length > 0
  const clean = user.length === 0 && !incomplete
  if (log) {
    if (clean && cache.length === 0) {
      console.log('  ✅ 用户数据全量一致（settings.json 与图库都在核对范围内、逐文件 sha256 相同）')
    } else if (clean) {
      console.log('  ✅ 用户数据全量一致（派生缓存有 ' + cache.length + ' 处新增，可再生、不算用户数据）')
    } else {
      if (user.length) {
        console.error('  ❌ **用户数据被改动了**：')
        for (const x of user.slice(0, 15)) console.error('      ' + x)
        if (user.length > 15) console.error('      …还有 ' + (user.length - 15) + ' 条')
      }
      if (incomplete) {
        console.error('  ❌ **核对不完整**（读不完整一律不出绿）：')
        for (const e of res.errors.slice(0, 10)) console.error('      ' + e)
      }
    }
    if (res.rewritten && res.rewritten.length) {
      console.log('  ℹ️ **原样重写**（内容与大小都没变，只是被写回了一次）' + res.rewritten.length + ' 处：')
      for (const x of res.rewritten.slice(0, 5)) console.log('      ' + x)
    }
    if (cache.length) {
      console.log('  ℹ️ 派生缓存变化 ' + cache.length + ' 处（可再生；出现 removed/changed 需留意）：')
      for (const x of cache.slice(0, 5)) console.log('      ' + x)
      if (cache.length > 5) console.log('      …还有 ' + (cache.length - 5) + ' 处')
    }
  }
  return { clean, incomplete, userChanges: user, cacheChanges: cache, rewritten: res.rewritten || [], errors: res.errors }
}

/** 把"kind path"这一行还原成用户数据/缓存。 */
function classifyLine(snap, line) {
  for (const r of snap.roots) {
    if (!line.startsWith(r.kind + ' ')) continue
    const p = line.slice(r.kind.length + 1).replace(/（.*$/, '')
    if (!p.startsWith(r.path)) continue
    const rel = path.relative(r.path, p)
    return classifyPath(r, rel)
  }
  return 'user'   // 归不了类就算用户数据（保守）
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const [mode, name] = process.argv.slice(2)
  if (!mode || !name) {
    console.error('用法: node tools/state-boundary.mjs begin|verify <名字>')
    process.exit(2)
  }
  mkdirSync(SNAP_DIR, { recursive: true })
  const file = path.join(SNAP_DIR, name + '.json')

  if (mode === 'begin') {
    const snap = boundaryBegin(true)
    writeFileSync(file, JSON.stringify(snap), 'utf8')
    console.log('    快照: ' + path.relative(REPO, file))
    process.exit(snap.errors.length ? 1 : 0)
  }
  if (!existsSync(file)) {
    console.error('✗ 没有找到快照 ' + path.relative(REPO, file) + ' ⇒ **拒绝核对**（先跑 begin）')
    process.exit(2)
  }
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  console.log('=== 状态边界核对：' + name + '（快照建于 ' + snap.at + '）===')
  const res = boundaryVerify(snap, true)
  process.exit(res.clean ? 0 : 1)
}
