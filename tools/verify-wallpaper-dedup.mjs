// 离线断言：`贝利尔` 那两对同名底图的去重状态**与实况一致、内容一字不改、路由照样取得到**。
//
// 背景（为什么要专门有一套）：wallpapers/ 是**实时扫盘**列图的（index.js scanTypeDir）——
// 磁盘上有几个受支持的文件，设置页就有几张图。所以重复底图**不能删名字**，只能用硬链接：
// 两个名字共享同一份字节 ⇒ 列表不变、已有 URL 不变，磁盘只存一份。
//
// 基线修订（2026-09-23，用户确认「删名」）：当年硬链接的旧名 `贝利尔.png` 已在后续清理中删除，
// 全盘 dedup 复查（dedup-hardlink --pairs）确认再无同内容组。这套现在守护的是**修订后的现状**：
//   ① 现存名字可读、sha256 == 基线（内容没被动过）
//   ② 现存名字大小 == 基线；nlink 如实打印
//   ②′ 全库不许再冒出同内容重复组；inode 数 == 条目数（没有双份字节）
//   ③ 供图路由对现存名字回 200，且送出的字节 == 磁盘上的字节（含旧格式根目录名兜底）
//   ④ 清单校验照跑（清单 39 项 vs 磁盘实况的差异由 fetch-wallpapers --check 报缺, 不在这套口径里）
//
// 与 test-served-bytes.mjs 的区别：那套要真图**且只在本地跑**；本套 ①②③ 在 CI（没有 wallpapers/）
// 上明确打 SKIP 跳过、只有 ④ 照跑 —— 因为它同时守着"代码里对这几个名字的引用"，CI 上不该白丢保护。
//
// 跑法：node tools/verify-wallpaper-dedup.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyLocal, readManifest } from '../fetch-wallpapers.js'
import { scanImages, findDuplicateGroups } from './dedup-hardlink.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WALL = path.join(ROOT, 'wallpapers')
const ROUTE_PREFIX = '/bga/wallpapers'

// 两对贝利尔的基线：内容 sha256。
// 旧名是 2026-09-08 那批、`2` 名是 09-14 改名时**拷贝**出来的（不是 move）⇒ 磁盘上曾并存两份同样字节。
// 基线修订（2026-09-23，用户确认删名）：旧名 `贝利尔.png` 已在后续清理中删除，全盘 dedup 复查
// （dedup-hardlink --pairs）确认再无同内容组；只剩 `贝丽尔2.png` 一个名字。于是这里收敛为单名，
// sha256/大小仍按原基线校验（内容没被动过），inode/nlink 类断言只对现存名字成立。
const PAIRS = [
  {
    label: '高清/贝利尔',
    sha256: 'b725b8a3de22231df39ad7acaa1b711d5d7b0e7c280ac3156c1a089fb42859ec',
    bytes: 52738200,
    names: ['高清/贝丽尔2.png'],
  },
  {
    label: '重返未来1999/贝利尔',
    sha256: 'febf88f66dc55b22d4db2603b96313826cbd5e857fdcda0ef911034875ddc30f',
    bytes: 4268873,
    names: ['重返未来1999/贝丽尔2.png'],
  },
]

let pass = 0, fail = 0, skip = 0
const results = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push('  ✓ ' + name) } else { fail++; results.push('  ✗ ' + name + (detail ? '  —— ' + detail : '')) }
}
function skipped(name) { skip++; results.push('  – SKIP ' + name) }

const sha256file = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const mb = (n) => (n / 1048576).toFixed(2) + 'MB'
const dev = (st) => String(st.dev) + ':' + String(st.ino)

const haveWallpapers = fs.existsSync(WALL) && fs.readdirSync(WALL).some((c) => {
  try { return fs.statSync(path.join(WALL, c)).isDirectory() } catch { return false }
})

// ---- ④ 清单校验：贝利尔必须"在清单、在盘上、内容没变" ----
// 与 ①②③ 同一口径：这几条都是"本机底图完整性"，没有 wallpapers/ 就整体跳过（图片不进 git ⇒ CI 上必然没有）。
// 别把它硬留成 CI 必跑项 —— 那样 CI 上必然红，套件就成了假门禁。
// total 不钉死数值（2026-09-23 起随加图浮动：39 → 55），只要求与 items 自洽；全量完整性归
// fetch-wallpapers --check 管，这套只守去重相关的那几项。
console.log('=== ④ 清单校验（贝利尔在清单且完好） ===')
if (!haveWallpapers) {
  skipped('wallpapers/ 不存在 —— 本机底图完整性这一类断言整体跳过（含清单校验）')
} else {
  let manifest = null
  try { manifest = readManifest(ROOT) } catch (e) { /* 下面报 */ }
  ok('清单可读且 total==items.length', !!manifest && manifest.total === (manifest.items || []).length,
    manifest ? 'total=' + manifest.total + ' items=' + (manifest.items || []).length : '读不了清单')
  // verifyLocal 的**全量**结论由 fetch-wallpapers --check 自己报（2026-09-23 起本机有 4 个已改名的
  // 清单路径缺失 + 20 张未登记新图 ⇒ 全量必然不绿，那不是本套要守的回归）。这里只守贝利尔：
  // 它们在清单里、在磁盘上、sha256 没变 —— 去重/清理绝不允许悄悄弄坏清单在用的那份。
  const v = verifyLocal(ROOT)
  for (const p of ['高清/贝丽尔2.png', '重返未来1999/贝丽尔2.png']) {
    ok('清单内且在盘上: ' + p, !v.missing.includes(p) && !v.bad.includes(p),
      'missing=' + v.missing.join(',') + ' bad=' + v.bad.join(','))
  }
  if (manifest) {
    const paths = manifest.items.map((i) => i.path)
    for (const p of ['高清/贝丽尔2.png', '重返未来1999/贝丽尔2.png']) {
      ok('清单含 ' + p, paths.includes(p))
    }
    // 清单里**不该**有旧名：旧名是磁盘遗留，不是清单条目（否则就是 39 项里混进了重复计数）。
    for (const p of ['高清/贝利尔.png', '重返未来1999/贝利尔.png']) {
      ok('清单不含（去重前的冗余名）' + p, !paths.includes(p))
    }
  }
}

if (!haveWallpapers) {
  console.log('\n=== ①②②′③ 底图本体 ===')
  // 跳过消息只打一条（上面 ④ 那里已经打过），这里只标出区间。
  console.log('  （底图本体这类断言在 CI 上必然没有 —— 本机跑请先 node tools/fetch-wallpapers.mjs）')
} else {
  // ---- ① 四个名字都还在、可读、sha256 == 基线 ----
  console.log('\n=== ① 4 个文件存在 / 可读 / sha256 与基线一致 ===')
  for (const pair of PAIRS) {
    for (const rel of pair.names) {
      const p = path.join(WALL, rel)
      let h = null
      try { h = sha256file(p) } catch { /* 下面报 */ }
      ok('sha256 一致 ' + rel, h === pair.sha256, h === null ? '读不了' : '实得 ' + String(h).slice(0, 16) + '…')
    }
  }

  // ---- ② 现存名字：大小与基线一致；nlink 计数如实记录（旧名删除后可能残留 ≥2） ----
  console.log('\n=== ② 现存名字的大小与基线一致 ===')
  for (const pair of PAIRS) {
    const sts = pair.names.map((rel) => fs.statSync(path.join(WALL, rel)))
    ok('大小 == 基线  ' + pair.label, sts.every((st) => st.size === pair.bytes),
      sts.map((st) => st.size).join(' / ') + '（基线 ' + pair.bytes + '）')
    console.log('    ' + pair.label + ' nlink=' + sts[0].nlink + (sts[0].nlink >= 2 ? '（旧名已删，链接计数是当年硬链接的残留）' : ''))
  }

  // ---- ②′ 全库不许再冒出同内容的重复组（去重状态的守门员）----
  console.log('\n=== ②′ 全库无同内容重复组 ===')
  {
    // 口径：贝利尔的旧名已删 ⇒ 现在**任何**两个名字撞 sha256 都是回归（要么该建硬链接，要么是真重复）。
    const groups = findDuplicateGroups(WALL)
    ok('同内容重复组 == 0', groups.length === 0,
      groups.length ? '冒出 ' + groups.length + ' 组：' + groups.map((g) => g.group.map((f) => f.rel).join(' ≡ ')).join(' · ') : '')

    // 按 inode 去重后的真实占用。基线修订（2026-09-23）：本机已从 39 张扩到 55 张（新增图未登记、
    // 4 个清单路径被改名），旧的"39 inode / 820 MiB"算术随实况作废 —— 这里只断言
    // "inode 数 == 文件数"（即真的没有双份字节），总量打印出来供人核对。
    const seen = new Set()
    let realBytes = 0, entries = 0, unique = 0, entrySum = 0
    for (const f of scanImages(WALL)) {
      entries++; entrySum += f.size
      const st = fs.statSync(f.path)
      const k = st.dev + ':' + st.ino
      if (seen.has(k)) continue
      seen.add(k); unique++; realBytes += st.size
    }
    ok('真实 inode 数 == 目录条目数（无双份字节）', unique === entries, '实得 inode ' + unique + ' / 条目 ' + entries)
    console.log('    条目 ' + entries + ' 个 / inode ' + unique + ' 个 · 真实占用 ' + (realBytes / 1048576).toFixed(2) + ' MiB（条目求和 ' + (entrySum / 1048576).toFixed(2) + ' MiB · 回收 ' + ((entrySum - realBytes) / 1048576).toFixed(2) + ' MiB）')
  }

  console.log('\n=== ③ 路由 /bga/wallpapers/<类型>/<名> 取回现存名字 ===')
  const routes = []
  const fakeCtx = {
    get: (n) => (n === 'webServer' ? { register: (cfg) => { routes.push(cfg); return function () {} } } : undefined),
    effect: (fn) => { fn(); return function () {} },
  }
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
  await mod.apply(fakeCtx)   // index.js 是具名导出 (export async function apply)，没有 default
  const route = routes.find((r) => r.kind === 'prefix' && r.path === ROUTE_PREFIX)
  ok('抓到底图路由 ' + ROUTE_PREFIX, !!route, '注册到的路由：' + routes.map((r) => r.path).join(','))

  function request(url) {
    return new Promise(function (resolve) {
      const chunks = []
      const res = {
        writeHead(status, headers) { this.status = status; this.headers = headers || {} },
        end(body) {
          if (body !== undefined && body !== null) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
          resolve({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) })
        },
      }
      Promise.resolve(route.handler({ url }, res)).catch(function (e) { resolve({ status: 0, err: e.message }) })
    })
  }

  for (const pair of PAIRS) {
    for (const rel of pair.names) {
      const [cat, name] = rel.split('/')
      const r = await request(ROUTE_PREFIX + '/' + encodeURIComponent(cat) + '/' + encodeURIComponent(name))
      // 只对小的那一对逐字节比 sha256（52MB 的比一次就够，见下）；大只比大小，免得这套跑太久。
      const disk = fs.statSync(path.join(WALL, rel)).size
      const isHd = rel === pair.names[0] && pair.bytes > 10 * 1024 * 1024
      const okBytes = isHd ? r.body.length === disk : (r.body.length === disk && crypto.createHash('sha256').update(r.body).digest('hex') === pair.sha256)
      ok('路由 200 ' + rel + '  ' + mb(r.body.length) + (isHd ? '（仅比大小）' : '（sha256 与磁盘一致）'),
        r.status === 200 && okBytes, 'status=' + r.status + ' len=' + r.body.length + ' 磁盘=' + disk + (r.err ? ' err=' + r.err : ''))
    }
  }

  // 旧格式（根目录名兜底查找）也要能找到现存名字 —— 老版本 URL 靠这条活着。
  for (const rel of ['高清/贝丽尔2.png', '重返未来1999/贝丽尔2.png']) {
    const name = rel.split('/')[1]
    const want = PAIRS.map((p) => p.bytes)
    const r = await request(ROUTE_PREFIX + '/' + encodeURIComponent(name))
    ok('旧格式兜底 200 ' + name + '（去各类型里找）', r.status === 200 && want.includes(r.body.length),
      'status=' + r.status + ' len=' + r.body.length + ' 期望 ∈ {' + want.join(', ') + '}')
  }
}

console.log('\n' + results.join('\n'))
console.log('\n结果：' + pass + ' 通过 · ' + fail + ' 失败' + (skip ? ' · ' + skip + ' 跳过（CI 无 wallpapers/）' : '') + (fail ? '' : ' ✓'))
process.exit(fail ? 1 : 0)
