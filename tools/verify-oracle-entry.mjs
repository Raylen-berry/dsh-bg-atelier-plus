// tools/verify-oracle-entry.mjs —— 视觉 oracle **入口级**离线回归（跑真进程、验真退出码）
//
// 为什么需要：审核方第七轮指出，verify-oracle-flow 那 20 项只调用三个函数，
// **没有执行入口、也没验证退出码** —— 于是"入口里的 finally 顺序"这类问题测不到。
// 上一轮审核方自己的沙箱注入了 manifest，因此也漏检了它的缺失（本轮已补回）。
//
// 做法：起一个**极简假 CDP 服务器**（HTTP /json/list + 手写 RFC6455 WebSocket，
// 不引第三方依赖），用 `VB_CDP_PORT` 把真脚本指过来，然后 **spawn 真入口**：
//   node tools/visual-baseline.mjs capture|compare <临时基准名>
// 断言的是**真实进程的真实退出码**与真实写出的 manifest。
//
// 覆盖场景（对应审核方第七轮三条 P2 + 正向路径）：
//   S1 capture 正常              → exit 0，manifest 的 pinnedWallpaper/rotationFrozenFrom 都非 null
//   S2 capture 首次 GET 返回 {}  → exit 4（拒绝录基准），且**不写 manifest**
//   S3 capture PUT 返回 503      → exit 4（钉图未确认 ⇒ 拒绝录基准）
//   S4 capture 刷新抛错          → exit 4
//   S5 capture 客户端未钉上      → exit 4（探针报 autoOn 仍 true）
//   S6 compare 正常              → exit 0（同一张假截图 ⇒ 像素必然一致）
//   S7 compare 还原阶段读取抛错  → 清理**仍然执行**（服务器记到清理调用）+ 退出码非 0
//   S8 清理自身失败              → exit 6
//
// 用法：node tools/verify-oracle-entry.mjs
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng } from '../../dsh-browser-live/pixdiff.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'visual-baseline.mjs')
const OUT_ROOT = path.join(HERE, '..', 'baselines')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ---------------------------------------------------------------- 一张固定的假截图
// 20×20 的确定性 PNG：capture 与 compare 拿到的是**同一份字节** ⇒ 像素必然一致。
const TINY = (() => {
  const w = 20, h = 20, data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    data[o] = (x * 7) & 0xff; data[o + 1] = (y * 11) & 0xff; data[o + 2] = ((x + y) * 5) & 0xff; data[o + 3] = 255
  }
  return encodePng({ width: w, height: h, data })
})()
const TINY_B64 = TINY.toString('base64')

// ---------------------------------------------------------------- 假 CDP 服务器
function makeServer(cfg) {
  const state = {
    settings: { autoOn: true, autoMin: 5, wallpaper: { file: 'w.png', cat: 'c' }, accent: '#fff' },
    writes: [],            // PUT 的 body
    gets: 0,               // GET 次数
    sawCleanup: 0,         // 清理表达式被执行次数
    sawPrepare: 0,
  }
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/json/list')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{
        type: 'page', url: 'http://127.0.0.1:19387/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/page/Fake',
      }]))
      return
    }
    res.writeHead(404); res.end()
  })

  // --- 手写 RFC6455（只用到文本帧；服务端→客户端不掩码） ---
  const encode = (str) => {
    const buf = Buffer.from(str, 'utf8'); const len = buf.length
    let head
    if (len < 126) { head = Buffer.from([0x81, len]) }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2) }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) }
    return Buffer.concat([head, buf])
  }
  const decoder = (socket, onMsg) => {
    let acc = Buffer.alloc(0)
    return (chunk) => {
      acc = Buffer.concat([acc, chunk])
      for (;;) {
        if (acc.length < 2) return
        const b1 = acc[1]; const masked = (b1 & 0x80) !== 0
        let len = b1 & 0x7f, off = 2
        if (len === 126) { if (acc.length < off + 2) return; len = acc.readUInt16BE(off); off += 2 }
        else if (len === 127) { if (acc.length < off + 8) return; len = Number(acc.readBigUInt64BE(off)); off += 8 }
        let key = null
        if (masked) { if (acc.length < off + 4) return; key = acc.subarray(off, off + 4); off += 4 }
        if (acc.length < off + len) return
        let payload = acc.subarray(off, off + len)
        if (masked) { const out = Buffer.from(payload); for (let i = 0; i < out.length; i++) out[i] ^= key[i % 4]; payload = out }
        const opcode = acc[0] & 0x0f
        acc = acc.subarray(off + len)
        if (opcode === 8) { try { socket.end() } catch { /* noop */ } return }
        if (opcode === 1) onMsg(payload.toString('utf8'))
      }
    }
  }

  server.on('upgrade', (req, socket) => {
    // 客户端断开时 socket 会抛 ECONNRESET；不挂 handler 会掀掉整个测试进程（实测踩过）。
    socket.on('error', () => { /* 客户端已断开，忽略 */ })
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.on('data', decoder(socket, (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      const reply = (result, error) => {
        try { socket.write(encode(JSON.stringify({ id: msg.id, result: result || {}, error }))) } catch { /* noop */ }
      }
      if (msg.method === 'Page.captureScreenshot') return reply({ data: TINY_B64 })
      if (msg.method === 'Page.reload') {
        if (cfg.reloadFail) return reply(null, { message: 'Simulated reload failure' })
        return reply({})
      }
      if (msg.method !== 'Runtime.evaluate') return reply({})
      // CDP 形状：Runtime.evaluate 返回 {id, result:{result:{type,value}}}。
      // 脚本里 send 解析的是 m.result，readState 再取 .result.value ⇒ 少包一层就全是 no-value。
      const val = (v) => reply({ result: { type: 'string', value: v } })
      const e = String(msg.params && msg.params.expression || '')
      // 表达式分派（顺序有意义：先匹配更具体的）
      try {
        if (/getElementById\('vb-env'\)[\s\S]*remove/.test(e) && /out\.style/.test(e)) {
          state.sawCleanup++
          if (cfg.cleanupFail) throw new Error('Simulated cleanup timeout')
          return val(JSON.stringify({ style: true, backdrop: true }))
        }
        if (/__bgaStateProbe/.test(e)) {
          // 返回值同时带**设置值**和**实际渲染的背景 URL**（pinWallpaper 两者都要确认）
          const wf = state.settings.wallpaper ? state.settings.wallpaper.file : null
          const rendered = cfg.renderWrong
            ? 'url("http://x/bga/wallpapers/' + encodeURIComponent('WRONG.png') + '")'
            : 'url("http://x/bga/wallpapers/' + (wf ? encodeURIComponent(wf) : '') + '")'
          const v = cfg.probeMismatch
            ? { probe: 'ok', autoOn: true, file: 'OTHER.png', rendered }
            : { probe: 'ok', autoOn: state.settings.autoOn === true, file: wf, rendered }
          return val(JSON.stringify(v))
        }
        if (/vb-backdrop/.test(e)) {
          state.sawPrepare++
          // cfg.noBackdrop ⇒ 模拟"对话框还没挂上 ⇒ 垫底没生效"（prepareEnvironment 回传 backdrop=0）
          return val(cfg.noBackdrop ? 'applied(backdrop=0)' : 'applied(backdrop=1)')
        }
        if (/return 'ok:'/.test(e)) return val('ok:200')   // 预检
        if (/method:'PUT'/.test(e)) {
          const m = e.match(/body:\s*"((?:[^"\\]|\\.)*)"/)
          let body = null
          try { body = JSON.parse(JSON.parse('"' + m[1] + '"')) } catch { body = null }
          if (cfg.putFail) return val('PUT failed ' + cfg.putFail)
          if (body) { state.writes.push(body); Object.assign(state.settings, body) }
          return val('pinned(w) + autoOn=false')
        }
        if (/\.text\(\)/.test(e)) {   // 任何 GET（freeze / pin 内部 / 还原回读）
          state.gets++
          const idx = state.gets - 1
          if (cfg.emptyAt && cfg.emptyAt.includes(idx)) return val('{}')
          if (cfg.throwAt && cfg.throwAt.includes(idx)) throw new Error('Simulated GET failure')
          return val(JSON.stringify(state.settings))
        }
        if (/volatile/.test(e)) {
          // ⚠️ 入口新增 measureLiveGeom()：一次读回 innerWidth + 各锚点 + **随时间变的那一列**。
          //    桩必须给出**结构完整**的锚点，否则 geom=null ⇒ 几何核对判不可信 ⇒ 全场景 exit=4
          //    （第一版就是这里没补，S1/S6/S7 一起假失败）。
          //    volatile 的形状是 [{l,r,t}] —— 宿主的时间标签实测是 "6分钟"（**没有"前"字**）。
          return val(JSON.stringify({
            w: cfg.cssWidth || 1426, h: 807,
            dlg: { l: 313, t: 24, r: 1113, b: 783 },
            studio: { l: 525, t: 78, r: 1085, b: 1419 },
            hero: { l: 545, t: 148, r: 1059, b: 360 },
            sidebar: { l: 0, t: 0, r: 280, b: 807 },
            volatile: [{ l: 234, r: 261, t: '6分钟' }],
            // 侧栏纵向以**插件自己的元素**为锚（实测 .bga-orb 在 y724–751）
            plugin: [{ l: 12, t: 724, r: 40, b: 751 }],
          }))
        }
        if (/pending:pending\.length/.test(e)) {
          return val(JSON.stringify({ pending: 0, broken: 0, visible: 1, bg: 'ready', heroState: 'ready' }))
        }
        if (/bl-panel/.test(e)) return val('panel-already-hidden')
        if (/already-clean/.test(e)) return val('already-clean')
        if (/clicked-settings/.test(e)) return val('clicked-settings')
        if (/clicked-studio/.test(e)) return val('clicked-studio')
        if (/hasStudio/.test(e)) {
          return val(JSON.stringify({ hasStudio: true, studioSize: [560, 1341], heading: '底图工坊', saveState: '已保存' }))
        }
        if (/EXPECT_GEOMETRY|Math\.round\(r\.left\),t:Math\.round\(r\.top\),r:Math\.round\(r\.right\)/.test(e)) {
          // 几何核对现在只看**与窗口无关的量**（元素自己的宽度），所以桩要给 w
          return val(JSON.stringify({ l: 525, t: 78, r: 1085, w: cfg.studioWidth || 560, h: 1341 }))
        }
        if (/backgroundImage/.test(e)) return val(JSON.stringify({ bg: 'url(fake)' }))
        return val('"ok"')
      } catch (err) {
        return reply(null, { message: String(err.message || err) })
      }
    }))
  })

  server.on('clientError', () => { /* 忽略畸形请求 */ })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state }))
  })
}

function runScript(mode, dir, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, mode, dir], {
      env: { ...process.env, VB_CDP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

const freshDir = (() => { let n = 0; return () => '_entry-' + Date.now().toString(36) + '-' + (n++) })()
const made = []

async function scenario(label, cfg, fn) {
  const { server, state } = await makeServer(cfg || {})
  const port = server.address().port
  try { await fn(port, state) } finally { await new Promise((r) => server.close(r)) }
}

console.log('=== oracle 入口级回归（spawn 真进程、验真退出码）===')

// 每个场景用独立基准目录，跑完删掉（baselines 本来就不入库）
function cleanupDir(dir) {
  try { fs.rmSync(path.join(OUT_ROOT, dir), { recursive: true, force: true }) } catch { /* noop */ }
}

const dir1 = freshDir(); made.push(dir1)
await scenario('S1', {}, async (port, state) => {
  const r = await runScript('capture', dir1, port)
  ok('S1 capture 正常 ⇒ exit 0', r.code === 0, 'exit=' + r.code)
  let man = null
  try { man = JSON.parse(fs.readFileSync(path.join(OUT_ROOT, dir1, 'manifest.json'), 'utf8')) } catch { /* noop */ }
  ok('S1 manifest 写了 pinnedWallpaper（非 null）', !!(man && man.pinnedWallpaper), JSON.stringify(man && man.pinnedWallpaper))
  ok('S1 manifest 写了 rotationFrozenFrom（非 null）', !!(man && man.rotationFrozenFrom))
  ok('S1 冻结过轮播（PUT 里 autoOn=false）', state.writes.some((w) => w && w.autoOn === false))
})

const dir2 = freshDir(); made.push(dir2)
await scenario('S2', { emptyAt: [0] }, async (port) => {
  const r = await runScript('capture', dir2, port)
  ok('S2 首次 GET 返回 {} ⇒ 拒绝录基准（exit 4）', r.code === 4, 'exit=' + r.code)
  let exists = true
  try { fs.readFileSync(path.join(OUT_ROOT, dir2, 'manifest.json')) } catch { exists = false }
  ok('S2 **没有写出 manifest**（不是静默录了个 null 基准）', exists === false)
})

const dir3 = freshDir(); made.push(dir3)
await scenario('S3', { putFail: 503 }, async (port) => {
  const r = await runScript('capture', dir3, port)
  ok('S3 PUT 503 ⇒ 拒绝录基准（exit 4）', r.code === 4, 'exit=' + r.code)
})

const dir4 = freshDir(); made.push(dir4)
await scenario('S4', { reloadFail: true }, async (port) => {
  const r = await runScript('capture', dir4, port)
  ok('S4 刷新失败 ⇒ 拒绝录基准（exit 4）', r.code === 4, 'exit=' + r.code)
})

const dir5 = freshDir(); made.push(dir5)
await scenario('S5', { probeMismatch: true }, async (port) => {
  const r = await runScript('capture', dir5, port)
  ok('S5 客户端没真钉上 ⇒ 拒绝录基准（exit 4）', r.code === 4, 'exit=' + r.code)
})

const dir6 = freshDir(); made.push(dir6)
await scenario('S6', {}, async (port) => {
  const cap = await runScript('capture', dir6, port)
  ok('S6 前置：capture 成功', cap.code === 0, 'exit=' + cap.code)
  const r = await runScript('compare', dir6, port)
  ok('S6 compare 正常 ⇒ exit 0', r.code === 0, 'exit=' + r.code + ' | ' + (r.out.match(/视觉回归：.*/) || [''])[0])
})

const dir7 = freshDir(); made.push(dir7)
await scenario('S7', {}, async (port, state) => {
  const cap = await runScript('capture', dir7, port)
  ok('S7 前置：capture 成功', cap.code === 0, 'exit=' + cap.code)
})
// compare 分支的 GET 次序：0=freeze、1=pin 内部、2=还原 nowRaw、3=还原 verifyRaw
// 让第 2 次抛错 ⇒ 还原过程抛异常 ⇒ 验证"清理仍然执行"且退出码非 0
await scenario('S7b', { throwAt: [2] }, async (port, state) => {
  const before = state.sawCleanup
  const r = await runScript('compare', dir7, port)
  ok('S7 还原阶段读取抛错 ⇒ 退出码 5（不是被冲成 1）', r.code === 5, 'exit=' + r.code)
  ok('S7 ★ 清理**仍然执行了**（独立 finally）', state.sawCleanup > before,
    'sawCleanup ' + before + ' → ' + state.sawCleanup)
})

const dir8 = freshDir(); made.push(dir8)
await scenario('S8', { cleanupFail: true }, async (port) => {
  const r = await runScript('capture', dir8, port)
  ok('S8 清理自身失败 ⇒ exit 6（不谎报成功）', r.code === 6, 'exit=' + r.code)
})

// 垫底没生效 ⇒ 面板会被宿主 3% 透光污染 ⇒ 必须**大声失败**，不能冒充 0.5% 的"视觉回归"
// （真机实测到过：backdrop 没挂上时 compare 报 2977 像素/Δ4 的假差异）
const dir10 = freshDir(); made.push(dir10)
await scenario('S10', { noBackdrop: true }, async (port) => {
  const r = await runScript('capture', dir10, port)
  ok('S10 对话框垫底未生效 ⇒ 拒绝录基准（exit 4）', r.code === 4, 'exit=' + r.code)
  let exists = true
  try { fs.readFileSync(path.join(OUT_ROOT, dir10, 'manifest.json')) } catch { exists = false }
  ok('S10 没有写出被透光污染的基准', exists === false)
})

// capture 分支的 GET 次序：0=freeze、1=pin 内部、2=还原 nowRaw
// S7 验的是 compare；这里给 capture 补一条对称场景（两个分支的 finally 是分别写的，
// 只测一个会漏掉另一个的回归 —— 实测过锚点命中错分支导致变异未被抓到的事）
const dir9 = freshDir(); made.push(dir9)
await scenario('S9', { throwAt: [2] }, async (port, state) => {
  const r = await runScript('capture', dir9, port)
  ok('S9 capture 还原阶段抛错 ⇒ 退出码 5（不被冲成 1）', r.code === 5, 'exit=' + r.code)
  ok('S9 ★ capture 侧清理也仍然执行', state.sawCleanup > 0, 'sawCleanup=' + state.sawCleanup)
})

// 设置已写入、探针的 wallpaper 字段也对，但**画面背景还是上一张** ⇒ 不许继续
// （真机就是这么把基准录坏的：之后每次 compare 都报 93%）
const dir11 = freshDir(); made.push(dir11)
await scenario('S11', { renderWrong: true }, async (port) => {
  const r = await runScript('capture', dir11, port)
  ok('S11 钉图未渲染 ⇒ 拒绝录基准（exit 4）', r.code === 4, 'exit=' + r.code)
})

for (const d of made) cleanupDir(d)

console.log('\n入口级回归：' + pass + ' 通过 / ' + fail + ' 失败')
console.log('退出码约定：0 正常 · 1 视觉差异/未就绪 · 3 页面通道挂 · 4 拒绝录基准/钉图未确认 · 5 还原失败 · 6 清理失败')
console.log('\n**变异测试记录**（证明本套件不是空转）：')
console.log('  · 撤掉 capture 的 frozen 空值守卫        → S2 失败（抓到）')
console.log('  · compare 的 finally 改回扁平顺序        → S7 两条断言都失败（抓到：exit=1 且清理 0 次）')
console.log('  · 撤掉 pinWallpaper 的 PUT 结果检查      → S3 仍通过：因为下游的"客户端探针确认"')
console.log('    也会挡住（PUT 失败 ⇒ 设置没变 ⇒ 探针报 autoOn=true ⇒ 拒绝）。**行为仍被覆盖**，')
console.log('    只是那一条检查与探针检查构成纵深防御、彼此冗余；不是测试空洞。')
process.exit(fail === 0 ? 0 : 1)
