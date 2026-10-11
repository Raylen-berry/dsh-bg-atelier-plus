// tools/mutate-real-style.mjs —— **A 级坏例**：真的改插件样式/行为，证明 oracle 抓得到真回归
//
// 审核方第十六轮指出：我此前的坏例大多是「C 涂色级」（合成图上涂一块 ⇒ 只证明比较器能识别）
// 或「B 注入级」（改基准元数据 ⇒ 只证明断言路径会拦）。**没有任何一条是"改插件真实样式
// 让它画出不同像素"**。这个脚本补的就是这一类。
//
// 做法：
//   1. 只在**插件副本**上改（`--plugin` 指向副本目录；默认取 VB_PLUGIN_DIR 或环境里的副本）
//      —— 生产代码 `E:\dsh-plugins\dsh-bg-atelier-official` 一个字都不动；
//   2. 改动是**真实源码文本替换**（改 CSS 值/改代码路径），并断言替换确实发生了（没发生就算失败，
//      不许"改了但没改到"当成没检出）；
//   3. 清浏览器缓存 + 跑真实 `compare <基准>`（在隔离实例上）；
//   4. 断言 **exit≠0 且检出的状态/原因符合预期**；
//   5. 从备份恢复插件文件并**校验 sha256 与原文件一致**（恢复不成功 ⇒ 报错退出）。
//
// 用法（在隔离实例上）：
//   node tools/mutate-real-style.mjs <基准名> [变异名...]
// 环境：DSH_HOME / VB_GUI_HOST / VB_CDP_PORT / VB_VIEWPORT / VB_SKIP_ONBOARDING
//      VB_PLUGIN_DIR=<插件副本目录>（默认取 DSH_HOME 无关的环境变量；必填）
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const base = process.argv[2]
const only = process.argv.slice(3)
if (!base) { console.error('用法: node tools/mutate-real-style.mjs <基准名> [变异名...]'); process.exit(2) }

const PLUGIN = process.env.VB_PLUGIN_DIR
if (!PLUGIN || !existsSync(path.join(PLUGIN, 'client.js'))) {
  console.error('✗ 必须用 VB_PLUGIN_DIR 指向**插件副本**目录（里面要有 client.js）。')
  console.error('  这个脚本拒绝在生产插件目录上做变异。')
  process.exit(2)
}
const PROD = 'e:\\dsh-plugins\\dsh-bg-atelier-official'
if (path.resolve(PLUGIN).toLowerCase() === PROD) {
  console.error('✗ VB_PLUGIN_DIR 指向了**生产插件目录** ⇒ 拒绝运行（变异必须在副本上做）。')
  process.exit(2)
}

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

/**
 * 变异表：每条都**改真实行为**，并写明"期望被哪一路抓到"。
 * `file`/`from`/`to` 是真实源码文本替换；`expect` 是失败原因里应出现的关键词（不能空）。
 */
const MUTATIONS = [
  {
    name: 'panel-shift-12px',
    desc: '把设置面板整体右移 12px（真实布局回归）',
    file: 'client.js',
    // ⚠️ 锚点必须落在**当前生效的主题**上：隔离实例是浅色主题，
    //    所以用浅色那段 `.bga-studio{--bga-panel:rgba(250,252,255,.9)` 开头。
    from: '.bga-studio{--bga-panel:rgba(250,252,255,.9)',
    to: '.bga-studio{transform:translateX(12px);--bga-panel:rgba(250,252,255,.9)',
    expectAny: ['布局漂移', '像素差异'],
  },
  {
    name: 'panel-bg-alpha',
    desc: '把浅色主题面板底色透明度从 .9 改成 .55（真实配色回归）',
    file: 'client.js',
    from: '--bga-panel:rgba(250,252,255,.9)',
    to: '--bga-panel:rgba(250,252,255,.55)',
    expectAny: ['像素差异', '探针状态也变了'],
  },
  {
    name: 'orb-shift-6px',
    desc: '把侧栏 orb 右移 6px（真实布局回归，01/02/05/06 覆盖这一带）',
    file: 'client.js',
    from: "'.bga-orb{border:none;background:none;padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center}'",
    to: "'.bga-orb{border:none;background:none;padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;margin-left:6px}'",
    expectAny: ['布局漂移', '像素差异'],
  },
]

async function clearCacheAndReload() {
  // 直接对隔离浏览器发 CDP：清缓存，确保页面重新取到被改过的 client.js
  const port = process.env.VB_CDP_PORT
  const host = process.env.VB_GUI_HOST || ''
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && String(t.url).includes(host))
  if (!page) throw new Error('找不到隔离页（VB_GUI_HOST=' + host + '）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws open 失败')) })
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Network.enable')
  await send('Network.clearBrowserCache')
  await send('Page.reload', { ignoreCache: true })
  ws.close()
  await new Promise((r) => setTimeout(r, 4500))
}

function runCompare() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, 'visual-baseline.mjs'), 'compare', base], {
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env, cwd: REPO,
    })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { out += d })
    c.on('close', (code) => resolve({ code, out }))
  })
}

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✅ ' + n + (extra ? '  [' + extra + ']' : '')) } else { fail++; console.log('  ❌ ' + n + (extra ? '  [' + extra + ']' : '')) } }

console.log('=== A 级坏例：真实样式/行为变异（在插件副本上） ===')
console.log('  副本: ' + PLUGIN)
console.log('  基准: ' + base + '\n')

for (const m of MUTATIONS) {
  if (only.length && !only.includes(m.name)) continue
  const file = path.join(PLUGIN, m.file)
  const bak = file + '.mutbak'
  const before = sha(file)
  copyFileSync(file, bak)
  try {
    const src = readFileSync(file, 'utf8')
    if (!src.includes(m.from)) {
      ok(m.name + ' 变异前提（源码里有锚点）', false, '找不到锚点：' + m.from.slice(0, 50))
      continue
    }
    writeFileSync(file, src.replace(m.from, m.to), 'utf8')
    const applied = sha(file) !== before
    ok(m.name + ' 变异确实落到源码里', applied, m.desc)
    if (!applied) continue

    await clearCacheAndReload()
    const r = await runCompare()
    const verdict = (r.out.match(/视觉回归：.*/) || ['(无结论行)'])[0].trim()
    const hit = r.code !== 0
    const reasonOk = m.expectAny.some((k) => r.out.includes(k))
    ok('★ ' + m.name + ' ⇒ oracle **必须失败**（exit≠0）', hit, 'exit=' + r.code + ' | ' + verdict)
    ok('  ' + m.name + ' ⇒ 失败原因符合预期', reasonOk,
      (r.out.match(/❌[^\n]*/) || ['(没有 ❌ 行)'])[0].trim().slice(0, 120))
  } finally {
    // 恢复 + 校验哈希（恢复不成功必须报错，不能"大概恢复了"）
    try {
      copyFileSync(bak, file)
      rmSync(bak, { force: true })
      const after = sha(file)
      ok(m.name + ' 插件副本已还原（sha256 一致）', after === before,
        after.slice(0, 12) + (after === before ? ' == ' : ' != ') + before.slice(0, 12))
    } catch (e) {
      fail++
      console.error('  ❌ ' + m.name + ' **还原失败**：' + String(e && e.message) + ' —— 请手工从 ' + bak + ' 恢复')
    }
  }
}

console.log('\nA 级坏例：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
