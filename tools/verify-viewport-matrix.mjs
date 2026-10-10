// tools/verify-viewport-matrix.mjs —— 迁移适配真机矩阵（验收约定第 7 项）
//
// 要验的三件事：
//   ① 换窗口尺寸后，**同一套工具**仍然能工作（几何自动推导、不写死坐标、不崩）——
//      判据是"在那个尺寸下录的基准，在同一尺寸下比对零差异"，而不是"拿旧尺寸的基准比"。
//   ② 换 **DPR** 后可以**沿用同一份基准**（CSS 视口没变 ⇒ 布局与底图裁切都没变，
//      只是设备像素密度变了 ⇒ 走跨 DPI 归一化路径）。
//   ③ 环境变形不能把真错误吃掉、也不能被误判成错误：布局契约要能区分
//      "宿主随窗口变"（放行）与"插件自己挪位"（拒绝）；视口小到锚点缺失时要**大声拒绝**。
//
// ⚠️ 为什么①不是"同一份基准跨尺寸比"（实测结论，已写进验收约定的排除范围）：
//   底图是 `background-size: cover` —— **视口尺寸一变，底图就被重新裁切**，
//   于是露出底图的区域像素整体改变（实测侧栏带 95.5% 像素不同）。那不是工具失灵，
//   是内容真的不同。跨 DPR 时 CSS 视口不变 ⇒ cover 裁切不变 ⇒ 那份基准可以沿用（实测 8/8 零差异）。
//
// 用法：node tools/verify-viewport-matrix.mjs [--only=<片段>] [--keep]
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = path.join(HERE, '..', 'baselines')
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '')
const KEEP = process.argv.includes('--keep')

/** 基准基准档（已有基准 audit-r26 就是它录的）。 */
const BASE_VIEWPORT = { w: 1426, h: 807, dpr: 1.1666666269302368 }

const MATRIX = [
  // ① 换窗口尺寸：各录各的基准
  { id: 'wide-1600x900@dpr1.1667', w: 1600, h: 900, dpr: BASE_VIEWPORT.dpr, mode: 'fresh' },
  { id: 'small-1180x720@dpr1.25', w: 1180, h: 720, dpr: 1.25, mode: 'fresh' },
  // ② 只换 DPR：沿用现成基准
  { id: 'dpr1.0-same-css', w: 1426, h: 807, dpr: 1.0, mode: 'reuse', base: 'audit-r28' },
].filter((c) => !only || c.id.includes(only))

const st = JSON.parse(readFileSync(process.env.DSH_HOME + '/dsh-browser-live/state.json', 'utf8'))
const list = await (await fetch('http://127.0.0.1:' + st.port + '/json/list')).json()
const page = list.find((t) => String(t.url || '').includes('127.0.0.1:19387'))
if (!page) { console.error('没找到 GUI 标签页'); process.exit(3) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws open 失败')) })
let id = 0
const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}, t = 30000) => new Promise((res) => {
  const i = ++id
  const tm = setTimeout(() => { pend.delete(i); res({ __timeout: 1 }) }, t)
  pend.set(i, (m) => { clearTimeout(tm); res(m) })
  ws.send(JSON.stringify({ id: i, method, params }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runOracle(mode, dir) {
  return new Promise((resolve) => {
    const args = ['tools/visual-baseline.mjs', mode]
    if (dir) args.push(dir)
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
    c.on('close', (code) => resolve({ code, out }))
  })
}

const verdictOf = (out) => (out.match(/视觉回归：.*/) || ['(无结论行)'])[0].trim()

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

async function applyViewport(c) {
  const r = await send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: c.dpr, mobile: false })
  if (r.__timeout || r.error) return null
  await sleep(1200)
  const p = await send('Runtime.evaluate', { expression: `JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`, returnByValue: true })
  return p?.result?.result?.value || null
}
async function clearViewport() {
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(900)
}

console.log('=== 迁移适配真机矩阵 ===\n')
const made = []

for (const c of MATRIX) {
  const got = await applyViewport(c)
  console.log('  — ' + c.id + '  实测 ' + (got || '覆盖失败'))
  if (!got) { ok(c.id + ' 应用视口覆盖', false); continue }

  if (c.mode === 'reuse') {
    const r = await runOracle('compare', c.base)
    ok(c.id + ' ⇒ 沿用基准仍零差异（CSS 视口不变 ⇒ cover 裁切不变 ⇒ 跨 DPI 归一化生效）', r.code === 0,
      'exit=' + r.code + ' | ' + verdictOf(r.out))
    const bad = r.out.split('\n').filter((l) => /❌|覆盖不足|布局漂移/.test(l)).slice(0, 2)
    for (const l of bad) console.log('        ' + l.trim().slice(0, 130))
  } else {
    const dir = '_mx-' + c.id.replace(/[^a-z0-9]+/gi, '-')
    made.push(dir)
    const cap = await runOracle('capture', dir)
    ok(c.id + ' ⇒ 在该尺寸下能录基准（几何自动推导，未因环境变化拒绝）', cap.code === 0,
      'exit=' + cap.code + (cap.code !== 0 ? ' | ' + cap.out.split('\n').filter((l) => /✗/.test(l)).slice(0, 2).map((l) => l.trim().slice(0, 110)).join(' ; ') : ''))
    if (cap.code === 0) {
      const r = await runOracle('compare', dir)
      ok(c.id + ' ⇒ 同尺寸下比对零差异', r.code === 0, 'exit=' + r.code + ' | ' + verdictOf(r.out))
      // 该尺寸下**必须仍能检出真错误**：把布局契约故意写错一条
      const mf = path.join(OUT_ROOT, dir, 'manifest.json')
      if (existsSync(mf)) {
        const m = JSON.parse(readFileSync(mf, 'utf8'))
        const st0 = m.states.find((s) => s.geom && s.geom.hostKind === 'sidebar' && s.geom.pluginRel)
        if (st0) {
          // ⚠️ 必须**成对**改（left +12 且 right −12）才是"插件真的右移 12px"。
          //    只改 left 不行：契约判据是"左**或**右至少一边不变"，右边缘还匹配就会被放行（踩过一次）。
          st0.geom.pluginRel.left = (st0.geom.pluginRel.left || 0) + 12
          st0.geom.pluginRel.right = (st0.geom.pluginRel.right || 0) - 12
          const { writeFileSync } = await import('node:fs')
          writeFileSync(mf, JSON.stringify(m, null, 2))
          const rBad = await runOracle('compare', dir)
          ok('★ ' + c.id + ' 下仍能检出"插件自己横移 12px"', rBad.code !== 0 && /布局漂移/.test(rBad.out),
            'exit=' + rBad.code + ' | ' + (rBad.out.match(/布局漂移[^\n]*/) || ['(未报漂移)'])[0].slice(0, 110))
        }
      }
    }
  }
  await clearViewport()
}

// —— 坏例：视口压到明显放不下面板的高度 ⇒ 必须非零退出（不静默判一致）——
// ⚠️ 如实标注：这一步实测的失败**原因**是 `CDP 超时: Page.captureScreenshot`（渲染器在极小视口下
//    不吐帧），**不是**几何层的"锚点缺失 ⇒ 拒绝"。所以它证明的是"极端视口下不会假装一致"，
//    而"锚点缺失要大声拒绝"由离线几何套件（surface 锚点缺失 ⇒ null）与入口套件的场景覆盖。
//    把两者混为一谈会变成"通过得理由不对"。
console.log('\n  — 坏例：视口压到 1180x360（渲染器不吐帧）—')
if (await applyViewport({ w: 1180, h: 360, dpr: BASE_VIEWPORT.dpr })) {
  const rBad = await runOracle('compare', 'audit-r28')
  ok('★ 极端视口下非零退出（不静默判一致）', rBad.code !== 0, 'exit=' + rBad.code)
  const tail = rBad.out.split('\n').map((l) => l.trim()).filter((l) => /✗|❌|超时|拒绝/.test(l)).slice(-2)
  console.log('       实测失败原因: ' + (tail.join(' ; ').slice(0, 150) || '(无)'))
  await clearViewport()
}

if (!KEEP) for (const d of made) { try { rmSync(path.join(OUT_ROOT, d), { recursive: true, force: true }) } catch {} }
else console.log('\n  （--keep：临时基准保留在 baselines/ 里供检查）')

console.log('\n迁移矩阵：' + pass + ' 通过 / ' + fail + ' 失败')
ws.close()
process.exit(fail === 0 ? 0 : 1)
