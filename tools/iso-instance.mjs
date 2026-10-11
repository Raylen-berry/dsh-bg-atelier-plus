// tools/iso-instance.mjs —— **隔离验收实例**的最小入口（起 / 停 / 状态）
//
// 为什么需要（审核方第十五/十六轮）：我此前所有验收都跑在**用户正在用的那份环境**上 ——
// 于是每次都要靠"钉图 → 改设置 → 收尾还原"去补，而那条路补不完（用户一操作就被覆盖、
// 进程被杀 finally 不执行、大图拖慢、标记图进用户图库……）。根治办法是**独立实例**：
// 独立 DSH_HOME、独立端口、独立插件副本、独立图库、独立浏览器 profile。
//
// 本脚本把手工验证过的步骤固化下来，并且**不证明隔离就不算起来**：
//   · 插件数据落点（/bga/wallpapers.json 的 dir/writableDir）必须都在隔离根下；
//   · 生产设置文件在起停前后哈希不变；
//   · 起不来 / 证明不了 ⇒ 杀掉自己起的进程并失败退出。
//
// 用法：
//   node tools/iso-instance.mjs up   [--name poc1] [--browser] [--port 19402] [--cdp 19502]
//   node tools/iso-instance.mjs down [--name poc1]
//   node tools/iso-instance.mjs status [--name poc1]
//
// 起来之后，验收脚本要**显式绑定**到这个实例（这几个环境变量就是绑定）：
//   DSH_HOME=<root>/home  VB_GUI_HOST=127.0.0.1:<port>  VB_CDP_PORT=<cdp>
//   VB_VIEWPORT=1426x807@1.1666666269302368  VB_SKIP_ONBOARDING=1  VB_PLUGIN_DIR=<root>/plugin/dsh-bg-atelier-official
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync, readdirSync, openSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const args = process.argv.slice(2)
const cmd = args[0]
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const NAME = opt('name', 'poc1')
const ROOT = opt('root', path.join(path.dirname(REPO), 'dsh-iso', NAME))
const PORT = Number(opt('port', '19402'))
const CDP = Number(opt('cdp', '19502'))
const WITH_BROWSER = args.includes('--browser')

const EXE = 'E:\\DeepSeek Harness\\DeepSeek Harness.exe'
const CLI = 'E:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROD_PLUGIN = 'E:\\dsh-plugins\\dsh-bg-atelier-official'
const PROD_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const INSTANCE_JSON = path.join(ROOT, 'instance.json')

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const listening = async (port) => {
  try { const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) }); return r.ok } catch {
    try { const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1500) }); return r.status > 0 } catch { return false }
  }
}
async function waitPort(port, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await listening(port)) return true; await sleep(1500) }
  return false
}

/** 只杀本脚本记录过的 PID（**绝不用命令行模式匹配** —— 我自己工具调用的 runner 命令行里
 *  也含我写的脚本文本，实测误伤过一次）。 */
function killRecorded(pid, why) {
  if (!pid || !alive(pid)) return false
  try { process.kill(pid, 'SIGKILL'); console.log('    已结束 PID ' + pid + '（' + why + '）'); return true } catch (e) {
    console.error('    ✗ 结束 PID ' + pid + ' 失败：' + String(e && e.message)); return false
  }
}

function buildPluginCopy() {
  const dst = path.join(ROOT, 'plugin', 'dsh-bg-atelier-official')
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(dst, { recursive: true })
  // 整目录拷贝，只排除重的/无关的 —— **不能只手挑几个文件**：
  // 实测漏了 `./fetch-wallpapers.js` 与 `./we/routes.js` 的依赖文件 ⇒ 插件 "failed to import"。
  const skip = new Set(['baselines', '.git', 'node_modules', 'docs'])
  const copy = (src, out) => {
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const s = path.join(src, e.name), d = path.join(out, e.name)
      if (e.isDirectory()) { mkdirSync(d, { recursive: true }); copy(s, d) }
      else copyFileSync(s, d)
    }
  }
  copy(PROD_PLUGIN, dst)
  return dst
}

function buildProfile() {
  const prof = path.join(ROOT, 'home', 'profiles', 'web')
  mkdirSync(path.join(prof, 'node_modules'), { recursive: true })
  const src = path.join(PROD_HOME, 'profiles', 'web')
  for (const f of ['cordis.yml', 'pnpm-workspace.yaml']) {
    if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(prof, f))
  }
  const srcNm = path.join(src, 'node_modules')
  for (const f of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) {
    if (existsSync(path.join(srcNm, f))) copyFileSync(path.join(srcNm, f), path.join(prof, 'node_modules', f))
  }
  // package.json：bundles 取最小集（base + web-app + 本插件），依赖指向**副本**
  writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-iso-web', private: true,
    dependencies: { 'dsh-bg-atelier-plus': 'link:' + path.join(ROOT, 'plugin', 'dsh-bg-atelier-official') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bg-atelier-plus'] } },
  }, null, 2) + '\n', 'utf8')
  // node_modules 里的链接：指向副本
  const link = path.join(prof, 'node_modules', 'dsh-bg-atelier-plus')
  try { rmSync(link, { recursive: true, force: true }) } catch { /* noop */ }
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, path.join(ROOT, 'plugin', 'dsh-bg-atelier-official')], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('建 junction 失败：' + (r.stderr || r.stdout || '').slice(0, 120))

  // patch 层：全新 DSH_HOME 会让设置对话框停在**首次运行引导**，插件的「底图工坊」导航
  // 根本不渲染 ⇒ 03/04 永远打不开面板。这几项抄自生产 desktop profile（同样的键值，
  // 去掉 LLM/插件相关配置），只用于跳过引导。
  const patch = [
    '# 隔离验收实例：跳过首次运行引导（否则插件的 settings.section 不渲染）。',
    '# 键值抄自生产 profile 的 cordis.patch.yml，去掉与本实例无关的条目。',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '  config:',
    '    enabled: true',
    '- id: ui-settings-account',
    '  name: "@deepseek-ai/dsh-client-ui-settings-account"',
    '  config:',
    '    version: 1',
    '    step: done',
    '    usage: detailed',
    '    developerTools: true',
    '    purpose: null',
    '    process: standard',
    '    completion: api-key',
  ].join('\n') + '\n'
  writeFileSync(path.join(prof, 'cordis.patch.yml'), patch, 'utf8')
  return prof
}

function buildTestLibrary() {
  const dir = path.join(ROOT, 'home', 'dsh-bg-atelier', 'wallpapers', '测试图')
  mkdirSync(dir, { recursive: true })
  // 用插件仓库里的 diff 工具编码 PNG（不引新依赖）
  // ⚠️ 路径转义在**父脚本**里就换成正斜杠；别在模板里写反斜杠 —— 实测会生成
  //    E:dsh-pluginsdsh-browser-live…（反斜杠被吃掉）⇒ ERR_MODULE_NOT_FOUND。
  const pixdiff = path.join(path.dirname(REPO), 'dsh-browser-live', 'pixdiff.js').split(path.sep).join('/')
  const gen = path.join(ROOT, '_gen.mjs')
  writeFileSync(gen, `
import { writeFileSync } from 'node:fs'
import { encodePng } from 'file:///${pixdiff}'
const dir = ${JSON.stringify(dir)}
function png(w, h, pick) {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, c = pick(x, y)
    data[o] = c[0]; data[o+1] = c[1]; data[o+2] = c[2]; data[o+3] = 255
  }
  return encodePng({ width: w, height: h, channels: 4, data })
}
writeFileSync(dir + '/iso-A.png', png(320, 180, (x,y)=>[40+(x%200),30+(y%150),90]))
writeFileSync(dir + '/iso-B_高清.png', png(320, 180, (x,y)=>[200-(x%180),120,60+(y%120)]))
`, 'utf8')
  const r = spawnSync(process.execPath, [gen], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('生成测试图失败：' + (r.stderr || '').slice(0, 160))
  rmSync(gen, { force: true })
  return dir
}

async function up() {
  console.log('=== 起隔离验收实例：' + NAME + ' ===')
  console.log('  根目录: ' + ROOT)
  if (existsSync(INSTANCE_JSON)) {
    const inst = JSON.parse(readFileSync(INSTANCE_JSON, 'utf8'))
    if (inst.pid && alive(inst.pid) && await listening(inst.port)) {
      console.log('  已存在且健康（PID ' + inst.pid + '，端口 ' + inst.port + '）⇒ 直接复用。要重来先 down。')
      return
    }
    console.log('  发现旧的 instance.json 但进程已不在 ⇒ 重建。')
  }
  mkdirSync(ROOT, { recursive: true })

  const prodSettings = path.join(PROD_HOME, 'dsh-bg-atelier-plus', 'settings.json')
  const prodBefore = existsSync(prodSettings) ? sha(prodSettings) : '(无)'

  const plugin = buildPluginCopy()
  const prof = buildProfile()
  const lib = buildTestLibrary()
  console.log('  插件副本: ' + plugin)
  console.log('  profile: ' + prof)
  console.log('  测试图库: ' + lib)

  const outf = path.join(ROOT, '_run.out')
  const errf = path.join(ROOT, '_run.err')
  // ⚠️ 分离启动也必须**把输出收下来**：宿主会在 stdout 打印
  //    `dsh web: http://127.0.0.1:<port>/?token=…` —— 那是浏览器认证要用的 URL。
  //    第一版用 stdio:'ignore' ⇒ 拿不到 token（隔离浏览器就打不开页面）。
  // ⚠️ 必须用 PowerShell 的 `Start-Process` 启动，**不要**用 node 的 spawn({detached:true})：
  //    实测 spawn 起得来（日志里打印了端口与 token），但**宿主随后自行退出**（端口不再监听）；
  //    而 Start-Process 起的那个能长期存活（POC 实例跑了几十分钟仍在）。
  //    差别在启动方式本身，不在参数 —— 所以这里回到已验证的那条路。
  const pidf2 = path.join(ROOT, 'instance.pid')
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  // ⚠️ Start-Process 的 -ArgumentList 是把数组**用空格拼**再交给子进程的，**不会**给含空格的项
  //    自动加引号 ⇒ `E:\DeepSeek Harness\...\cli.js` 被拆成两个参数，子进程报
  //    "Cannot find module 'E:\DeepSeek'"。必须自己给含空格的项套内层双引号。
  const arg = (s) => q(/\s/.test(String(s)) ? '"' + s + '"' : s)
  // ⚠️ `Start-Process` 的整条命令必须是**一个语句**：不能把 -FilePath 与 -ArgumentList
  //    用 `; ` 分开（那会变成两个语句 ⇒ "-ArgumentList is not recognized"）。实测踩过。
  const startProc = '$p = Start-Process -FilePath ' + q(EXE)
    + ' -ArgumentList @(' + ["--expose-internals", CLI, 'web', '--host', '127.0.0.1', '--port', String(PORT), '--no-open']
      .map(arg).join(',') + ')'
    + ' -PassThru -RedirectStandardOutput ' + q(outf) + ' -RedirectStandardError ' + q(errf) + ' -WindowStyle Hidden'
  const ps = [
    "$env:ELECTRON_RUN_AS_NODE='1'",
    '$env:DSH_HOME=' + q(path.join(ROOT, 'home')),
    startProc,
    'Set-Content -Path ' + q(pidf2) + ' -Value $p.Id -Encoding ASCII',
    '$p.Id',
  ].join('; ')
  const r0 = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  const pid = Number(String(r0.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop())
  if (!pid) {
    console.error('  ✗ 启动失败：' + String((r0.stderr || r0.stdout || '')).slice(0, 200))
    process.exit(1)
  }
  console.log('  已启动，PID = ' + pid)

  const okPort = await waitPort(PORT, 60000)
  if (!okPort) {
    killRecorded(pid, '起不来')
    console.error('  ✗ 60 秒内端口 ' + PORT + ' 没起来 ⇒ 已结束自己起的进程')
    process.exit(1)
  }

  // 取带 token 的 URL 与插件日志（宿主会把它们写进 storages/日志；这里从 /bga 路由反证即可）
  // 从 stdout 里取带 token 的认证 URL（浏览器必须用它，否则 401）
  let authUrl = null
  try {
    const txt = readFileSync(outf, 'utf8')
    const mm = txt.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
    if (mm) authUrl = mm[0]
  } catch { /* noop */ }
  let head = null
  try { head = await (await fetch('http://127.0.0.1:' + PORT + '/bga/settings.json')).headers.get('x-bga-settings-status') } catch { /* noop */ }
  let roots = null
  try { roots = await (await fetch('http://127.0.0.1:' + PORT + '/bga/wallpapers.json')).json() } catch { /* noop */ }

  // ★ 隔离证明：插件的数据落点必须在隔离根下；生产设置在起停前后哈希不变
  const proof = []
  const inRoot = (p) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase())
  proof.push(['插件 writableDir 在隔离根下', roots ? inRoot(roots.writableDir) : false, roots && roots.writableDir])
  proof.push(['插件图库 dir 在隔离根下', roots ? inRoot(roots.dir) : false, roots && roots.dir])
  proof.push(['图库只看到测试分类', !!roots && roots.categories.every((c) => c.name === '测试图'), roots && roots.categories.map((c) => c.name).join(',')])
  proof.push(['新接口状态头可用（未重启的生产上还看不到）', head !== null, 'x-bga-settings-status=' + head])
  const prodAfter = existsSync(prodSettings) ? sha(prodSettings) : '(无)'
  proof.push(['生产 settings.json 未被改动', prodBefore === prodAfter, prodBefore.slice(0, 12) + ' → ' + prodAfter.slice(0, 12)])

  let bad = 0
  for (const [n, okv, extra] of proof) {
    console.log('  ' + (okv ? '✅' : '❌') + ' ' + n + (extra ? '  [' + String(extra).slice(0, 90) + ']' : ''))
    if (!okv) bad++
  }
  if (bad) {
    killRecorded(pid, '隔离证明不成立')
    console.error('  ✗ 隔离无法证明 ⇒ 已结束自己起的进程，拒绝继续（审核方要求：证明不了就不许跑）')
    process.exit(1)
  }

  const inst = { name: NAME, root: ROOT, port: PORT, cdpPort: CDP, pid, home: path.join(ROOT, 'home'), plugin, authUrl, startedAt: new Date().toISOString() }
  let browserPid = null
  if (WITH_BROWSER) {
    const bprof = path.join(ROOT, 'browser-profile')
    mkdirSync(bprof, { recursive: true })
    // 同宿主：用 Start-Process 起（node spawn detached 起的那个宿主会自己退出；
    // 浏览器没单独试过 spawn，统一走已验证的路径，少一个变量）
    // 同宿主：用 Start-Process 起（同样必须拼成**一个语句**）
    const bArgs = ['--user-data-dir=' + bprof, '--remote-debugging-port=' + CDP,
      '--no-first-run', '--no-default-browser-check', authUrl || ('http://127.0.0.1:' + PORT + '/')]
    const bps = '$p = Start-Process -FilePath ' + q(CHROME)
      + ' -ArgumentList @(' + bArgs.map(arg).join(',') + ')'
      + ' -PassThru -WindowStyle Minimized; $p.Id'
    const br = spawnSync('powershell', ['-NoProfile', '-Command', bps], { encoding: 'utf8' })
    browserPid = Number(String(br.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()) || null
    const okCdp = await waitPort(CDP, 40000)
    console.log('  ' + (okCdp ? '✅' : '❌') + ' 隔离浏览器 CDP 端口 ' + CDP + '（PID ' + browserPid + '）')
    if (!okCdp) { killRecorded(browserPid, 'CDP 起不来'); killRecorded(pid, '连带'); process.exit(1) }
  }
  inst.browserPid = browserPid
  writeFileSync(INSTANCE_JSON, JSON.stringify(inst, null, 2), 'utf8')
  console.log('\n  实例已就绪：' + INSTANCE_JSON)
  console.log('  绑定用环境变量（验收脚本必须显式带上）：')
  console.log('    DSH_HOME=' + inst.home)
  console.log('    VB_GUI_HOST=127.0.0.1:' + PORT + '   VB_CDP_PORT=' + CDP)
  console.log('    VB_VIEWPORT=1426x807@1.1666666269302368  VB_SKIP_ONBOARDING=1')
  console.log('    VB_PLUGIN_DIR=' + plugin)
  console.log('  停止：node tools/iso-instance.mjs down --name ' + NAME)
}

function down() {
  console.log('=== 停隔离实例：' + NAME + ' ===')
  if (!existsSync(INSTANCE_JSON)) { console.log('  没有 instance.json ⇒ 无事可做'); return }
  const inst = JSON.parse(readFileSync(INSTANCE_JSON, 'utf8'))
  killRecorded(inst.browserPid, '隔离浏览器')
  killRecorded(inst.pid, '隔离宿主')
  rmSync(path.join(ROOT, 'instance.pid'), { force: true })
  console.log('  完成。生产宿主与生产数据从未被本脚本触碰。')
}

async function status() {
  if (!existsSync(INSTANCE_JSON)) { console.log('  没有实例记录（' + INSTANCE_JSON + '）'); return }
  const inst = JSON.parse(readFileSync(INSTANCE_JSON, 'utf8'))
  console.log('  实例 ' + inst.name + '  根=' + inst.root)
  console.log('    宿主 PID ' + inst.pid + ' 存活=' + alive(inst.pid) + '  端口 ' + inst.port + ' 在听=' + await listening(inst.port))
  console.log('    浏览器 PID ' + inst.browserPid + ' 存活=' + (inst.browserPid ? alive(inst.browserPid) : '-') + '  CDP ' + inst.cdpPort + ' 在听=' + await listening(inst.cdpPort))
  try {
    const r = await fetch('http://127.0.0.1:' + inst.port + '/bga/wallpapers.json')
    const j = await r.json()
    console.log('    插件数据落点: dir=' + j.dir)
    console.log('                  writableDir=' + j.writableDir)
    console.log('    在隔离根下: ' + path.resolve(j.writableDir).toLowerCase().startsWith(path.resolve(inst.root).toLowerCase()))
  } catch (e) { console.log('    读 /bga/wallpapers.json 失败：' + String(e && e.message).slice(0, 80)) }
}

if (cmd === 'up') await up()
else if (cmd === 'down') down()
else if (cmd === 'status') await status()
else { console.error('用法: node tools/iso-instance.mjs up|down|status [--name poc1] [--browser] [--port 19402] [--cdp 19502]'); process.exit(2) }
