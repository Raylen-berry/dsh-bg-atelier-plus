#!/usr/bin/env node
// tools/run-all.mjs —— 发布前检查总入口：本地与 CI 跑的是同一条命令（npm test）。
//
//   node tools/run-all.mjs          跑全部：每套都跑完再汇总
//   node tools/run-all.mjs --list   只列清单，不执行
//
// 为什么不用 `a.mjs && b.mjs` 串：第一套一失败后面的根本不跑，一次 push 只能暴露一个错误。
// 这里每套都跑、逐套列结果，任一套非 0 退出 ⇒ 本进程退出码 1 ⇒ CI 变红。
//
// 本清单只含**离线套件**：不联网、不做任何真实下载、不读本机 DSH 安装目录。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

// ---- 仓库配置 -------------------------------------------------------------
const CHECKS = ['index.js', 'client.js', ...fs.readdirSync(path.join(REPO, 'we')).filter(n => n.endsWith('.js')).map(n => 'we/' + n)]
CHECKS.push(...fs.readdirSync(path.join(REPO, 'we/native')).filter(n => n.endsWith('.cjs')).map(n => 'we/native/' + n))

const SUITES = [
  'tools/test-download-robustness.mjs',
  'tools/test-we-decode.mjs',
  'tools/test-we-library.mjs',
  'tools/test-we-services.mjs',
  'tools/test-we-routes.mjs',
  'tools/test-we-client.mjs',
  'tools/test-we-native.mjs',
  'tools/test-we-properties.mjs',
  'tools/verify-dockfx-bounds.mjs',
  // 特效画布几何（画布 = 输入框卡面矩形, 高度跟着卡面长高）+ 标签气泡（用户附图那套）。
  'tools/verify-fx-geometry.mjs',
  // 自动切换（间隔钳制 / 开关 / signature 不重起 / tick 起表）+ 渐变过渡（建拆 / 两帧 / 单层）。
  // 纯算术 + 调用计数 + 记录型假 document，不联网不读本机安装目录。
  'tools/verify-auto-fade.mjs',
  'tools/verify-background-lifecycle.mjs',
  // 迁移脚本 tools/settings.mjs 的校验口径：间隔档位吸附（那张 14 档表是 client.js AUTO_STOPS 的副本，
  // 两处各写一遍就得有人盯着）+ v1.11.0 两个新字段的默认值/钳制 + 老设置文件兼容。
  // WeSource 异步语义：六场景（乱序/切源/销毁/失败重试/连发/冷热启动）+ 两条 abort 竞态。
  // 做过**变异测试**：删掉 then 分支的 aborted 保护后本套件会失败 —— 证明它测的是真代码。
  'tools/verify-we-source-async.mjs',
  // oracle 的还原判定：三态契约 + 退出码语义 + 源码层断言（capture 不许写死 exit(0)）。
  // 30 项；做过变异测试：把末尾改回 exit(0) 或让 not-needed 判 failed 都会让它失败。
  'tools/verify-oracle-restore.mjs',
  // oracle 的**完整控制流**：把真函数装进沙箱跑（读失败→钉图必须被拒、无需还原≠失败、
  // 宿主读失败返回 {} 不算有效原值、设置钉上了但画面没渲染也必须拒绝）。22 项，做过变异测试。
  'tools/verify-oracle-flow.mjs',
  // oracle **入口级**：起假 CDP 服务器 + spawn 真脚本，验**真实退出码**（0/4/5/6）。
  // 20 项；做过变异测试（撤 frozen 守卫 / 把 compare 的 finally 改回扁平顺序都会让它失败）。
  'tools/verify-oracle-entry.mjs',
  // oracle **几何可迁移性**：合成图证明「窗口变宽 / 面板整体右移 4px」时锚点推导能跟上，
  // 而写死绝对常量的旧口径会裁歪（反证 diff=219784）。7 项，纯离线无需浏览器。
  'tools/verify-oracle-geometry.mjs',
  'tools/verify-settings.mjs',
  'tools/test-playlists.mjs',
  // 底图去重（贝利尔两对：同内容两个名字 → 硬链接）。离线自足：清单校验那几项在 CI 照跑，
  // 只有"读真图"的 ①②③ 在没有 wallpapers/ 时打 SKIP（图片不进 git）。
  'tools/verify-wallpaper-dedup.mjs',
]

const EXCLUDED = [
  ['tools/verify-switch-load-browser.mjs', '需要 Playwright 与 Chromium；隔离页面的连点解码压力与选择计数回归'],
  ['tools/verify-playlists-browser.mjs', '需要 React DOM、Playwright 与 Chromium；图单与设置页真实 UI 回归，使用隔离数据'],
  ['tools/verify-fade-browser.mjs', '需要 Playwright 与 Chromium；独立浏览器回归，不连接真实 DSH、不写用户设置'],
  ['tools/fetch-wallpapers.mjs --check', '只读校验本机原图，不联网；依赖已下载的底图，图片不进 git，因此不在 CI 运行'],
  ['tools/test-served-bytes.mjs', '要 wallpapers/ 里的真实图片才能起供图路由断言（离线跑本机复现退出码 1：没有 wallpapers/）'],
  ['tools/make-release.mjs --dry-run', '唯一不上传的分支也要**联网**查 Release 资产表 ⇒ CI（尤其 GitHub Actions 自带 GITHUB_TOKEN 时）不该顺手打外网 API；发布机上手动跑'],
  // oracle-compare.mjs 是纯模块（只导出、不执行），不是套件，无需登记；它是 audit 与
  // visual-baseline 共用的比对口径（原来两份实现漂移过，见该文件头部注释）。
  ['tools/audit-oracle-coverage.mjs', 'oracle 覆盖边界审计：需要 baselines/<名称>/ 里的基准图（图不入库）⇒ CI 里没有基准；本机跑 `node tools/audit-oracle-coverage.mjs [基准名]`'],
  ['tools/visual-baseline.mjs', '视觉 oracle：需要 GUI 在 127.0.0.1:19387 跑着 + 已连接的浏览器（走 CDP）⇒ 不是纯离线测试，本机手动跑 capture/compare'],
  ['tools/verify-viewport-matrix.mjs', '迁移适配真机矩阵：需要 GUI + 浏览器（用 CDP Emulation 改视口/DPR），且依赖已录基准 audit-r26 ⇒ 本机手动跑 `node tools/verify-viewport-matrix.mjs`'],
  ['tools/make-marker-wallpaper.mjs', '生成"中等尺寸标记图"并装到用户底图目录（04 状态的前置）⇒ 有副作用、不是测试；本机按需跑 `node tools/make-marker-wallpaper.mjs [--remove]`'],
]

const ENV = {}

// ---- 登记完备性 + 已知失败 ------------------------------------------------
// tools/ 下每个「看起来是套件」的文件都必须在 SUITES / EXCLUDED / KNOWN_FAILING 里登记，
// 否则本进程直接失败 —— 防止以后新增套件被静默漏掉（同一个不变量原来由 browser-live 的
// verify-manifest.mjs 断言 package.json 里那个长串来保证）。
const DISCOVERY = (n) => /^(verify|test|probe)-.*\.mjs$/.test(n) || n === 'selfcheck.mjs'

// 已知失败：仍然跑、结果照列，但**不**让整体变红（每条都必须写明原因）。
const KNOWN_FAILING = []

// ---- 执行器 ---------------------------------------------------------------
const results = []
const t = (ms) => (ms / 1000).toFixed(1) + 's'

function summarize(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const cand = [...lines].reverse().find((l) => /passed|通过|failed|失败|全部通过/.test(l))
  if (cand) return cand.trim()
  const n = lines.filter((l) => /^\s*(PASS|✓|✔|OK)\b/.test(l)).length
  return n ? n + ' 项（按 PASS 行计数）' : '（无输出）'
}

function run(kind, file) {
  const args = kind === 'check' ? ['--check', file] : [file]
  const started = Date.now()
  const s = spawnSync(process.execPath, args, {
    cwd: REPO, env: { ...process.env, ...ENV }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const out = (s.stdout || '') + (s.stderr || '')
  const code = s.status === null ? 1 : s.status
  const ok = code === 0
  results.push({ kind, file, ok, code, ms: Date.now() - started, summary: summarize(out) })
  console.log('\n' + '─'.repeat(72))
  console.log((ok ? '✅ ' : '❌ ') + file + '   exit=' + code + '  ' + t(Date.now() - started))
  console.log('─'.repeat(72))
  if (out.trim()) console.log(out.replace(/\s+$/, ''))
  if (s.error) console.log('!! spawn 失败：' + s.error.message)
  return ok
}

function checkRegistry() {
  const reg = new Set([...SUITES, ...EXCLUDED.map((e) => e[0]), ...KNOWN_FAILING.map((e) => e[0])]
    .map((f) => path.basename(String(f).split(' ')[0])))
  const missing = fs.readdirSync(path.join(REPO, 'tools')).filter(DISCOVERY).filter((n) => !reg.has(n))
  if (missing.length) {
    console.error('✗ 有套件没登记到 tools/run-all.mjs（SUITES / EXCLUDED / KNOWN_FAILING 三选一）：' + missing.join(', '))
    process.exit(1)
  }
}

checkRegistry()

if (LIST_ONLY) {
  console.log('语法门禁：' + (CHECKS.length ? CHECKS.join(', ') : '（无）'))
  console.log('测试套件：')
  for (const f of SUITES) console.log('  · ' + f)
  console.log('未纳入 CI：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + ' —— ' + why)
  if (KNOWN_FAILING.length) {
    console.log('已知失败（仍跑、不拦截）：')
    for (const [f, why] of KNOWN_FAILING) console.log('  · ' + f + ' —— ' + why)
  }
  process.exit(0)
}

console.log('dsh-desktop-wallpaper 发布前检查（离线）· node ' + process.version)
console.log('仓库：' + REPO)
for (const f of CHECKS) run('check', f)
for (const f of SUITES) run('suite', f)

const checks = results.filter((r) => r.kind === 'check')
const suites = results.filter((r) => r.kind === 'suite')
const knownNames = new Set(KNOWN_FAILING.map((e) => path.basename(e[0])))
const isKnown = (r) => knownNames.has(path.basename(r.file))
const bad = results.filter((r) => !r.ok && !isKnown(r))
const known = results.filter((r) => !r.ok && isKnown(r))

console.log('\n' + '='.repeat(72))
console.log('汇总')
console.log('='.repeat(72))
for (const r of results) console.log((r.ok ? ' ✅ ' : ' ❌ ') + r.file.padEnd(38) + t(r.ms).padStart(6) + '  ' + r.summary)
console.log('-'.repeat(72))
console.log('语法门禁 ' + checks.filter((r) => r.ok).length + '/' + checks.length +
  '　套件 ' + suites.filter((r) => r.ok).length + '/' + suites.length + ' 通过')
if (EXCLUDED.length) {
  console.log('\n未纳入 CI 的套件（原因）：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + '\n      ' + why)
}
if (known.length) {
  console.log('\n⚠ 已知失败（不拦截整体退出码，原因见本文件 KNOWN_FAILING）：')
  for (const r of known) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
if (bad.length) {
  console.log('\n失败套件：')
  for (const r of bad) console.log('  · ' + r.file + '（exit=' + r.code + '）' + r.summary)
}
console.log('\n' + (bad.length ? '✗ 有套件失败 —— 整体失败' : '✓ 全部通过'))
process.exit(bad.length ? 1 : 0)
