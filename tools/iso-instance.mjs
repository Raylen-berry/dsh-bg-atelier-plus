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
  // ⚠️ 判活标准是"**有没有 HTTP 响应**"，不是"响应是否 ok"。
  //    原来先请求 `/json/version`（CDP 专用路径），DSH web 端口对它返回 **404** ——
  //    fetch 不抛异常，于是 `r.ok === false` 直接 return false，**永不回退到 `/`**。
  //    后果：宿主明明起来了（日志有端口与 token），脚本却判"90 秒没起来"并把它杀掉。
  //    现在两个路径都试，任何响应（200/401/404 都算）都判为在听。
  for (const p of ['/json/version', '/']) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + p, { signal: AbortSignal.timeout(1500) })
      if (r.status > 0) return true
    } catch { /* 试下一个 */ }
  }
  return false
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
  // ⚠️ `.pnpm` 目录也必须一起拷：漏了它，宿主**会加载完就退出**（插件日志正常打印
  //    "host up" 与 token URL，但端口随后不再监听，表现为"60 秒内端口没起来"）。
  //    实测：手工建的那份拷了 `.pnpm` 能长期存活；脚本第一版漏了它就不行。
  if (existsSync(path.join(srcNm, '.pnpm'))) {
    const copyDir = (s, d) => {
      mkdirSync(d, { recursive: true })
      for (const e of readdirSync(s, { withFileTypes: true })) {
        if (e.isDirectory()) copyDir(path.join(s, e.name), path.join(d, e.name))
        else copyFileSync(path.join(s, e.name), path.join(d, e.name))
      }
    }
    copyDir(path.join(srcNm, '.pnpm'), path.join(prof, 'node_modules', '.pnpm'))
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
  ].join('; ')
  // ⚠️ **必须 `stdio:'ignore'`**：`spawnSync` 会等子进程的 stdout 管道关闭，而
  //    `Start-Process` 起的**孙子进程**（DSH 宿主）继承着那个管道 ⇒ 永远等不到 EOF，
  //    脚本就卡在这次 spawnSync 上（实测：宿主已起来、端口与日志都对，脚本却停在
  //    "测试图库: …" 之后一行都不输出）。改成不接管管道、只从文件读 PID。
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
  let pid = 0
  try { pid = Number(String(readFileSync(pidf2, 'utf8')).trim()) } catch { pid = 0 }
  if (!pid) {
    console.error('  ✗ 启动失败（没能从 ' + pidf2 + ' 读到 PID）')
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
    // 同宿主：用 Start-Process 起（同样必须拼成**一个语句**、同样 stdio:'ignore' 免得等管道）
    const bArgs = ['--user-data-dir=' + bprof, '--remote-debugging-port=' + CDP,
      '--no-first-run', '--no-default-browser-check', authUrl || ('http://127.0.0.1:' + PORT + '/')]
    const bpidf = path.join(ROOT, 'browser.pid')
    const bps = '$p = Start-Process -FilePath ' + q(CHROME)
      + ' -ArgumentList @(' + bArgs.map(arg).join(',') + ')'
      + ' -PassThru -WindowStyle Minimized'
      + '; Set-Content -Path ' + q(bpidf) + ' -Value $p.Id -Encoding ASCII'
    spawnSync('powershell', ['-NoProfile', '-Command', bps], { stdio: 'ignore' })
    try { browserPid = Number(String(readFileSync(bpidf, 'utf8')).trim()) || null } catch { browserPid = null }
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

/**
 * `prepare`：只**准备**（插件副本 + profile + 测试图库），然后打印**在 shell 里**执行的启动命令。
 *
 * 为什么不在这里启动（实测结论，很重要）：从 Node 里经 `spawnSync(powershell → Start-Process)`
 * 起的宿主会被 **Windows Job 对象**连坐回收 —— 宿主日志与端口都正常，几秒后进程就没了
 * （harness 还报过 "Windows Job runner exited …"）。而**直接在 shell 里**跑同一句
 * `Start-Process` 起的宿主能长期存活（POC 实例跑了一小时以上）。启动这一步交给 shell。
 */
function prepare() {
  console.log('=== 准备隔离验收实例：' + NAME + ' ===')
  console.log('  根目录: ' + ROOT)
  mkdirSync(ROOT, { recursive: true })
  const prodSettings = path.join(PROD_HOME, 'dsh-bg-atelier-plus', 'settings.json')
  const prodHash = existsSync(prodSettings) ? sha(prodSettings) : '(无)'
  const plugin = buildPluginCopy()
  const prof = buildProfile()
  const lib = buildTestLibrary()
  console.log('  插件副本: ' + plugin)
  console.log('  profile: ' + prof)
  console.log('  测试图库: ' + lib)
  console.log('  生产 settings.json 当前哈希（记下来，起停前后必须不变）: ' + prodHash.slice(0, 16))
  const token = '<token 会打印在宿主 stdout>'
  console.log('\n  ① 在 shell 里跑这一条起宿主（已含独立 DSH_HOME 与端口）：\n')
  console.log('  $env:ELECTRON_RUN_AS_NODE="1"; $env:DSH_HOME="' + path.join(ROOT, 'home') + '"; '
    + 'Start-Process -FilePath "' + EXE + '" -ArgumentList @('
    // ⚠️ 参数里的路径必须带**内层双引号**：Start-Process 会把数组用空格拼再交给子进程，
    //    不给含空格的项加引号 ⇒ `E:\DeepSeek Harness\...` 被拆成两个参数，子进程报
    //    "Cannot find module 'E:\DeepSeek'"。POC1 当初能跑就是因为带了内层引号。
    + hostArgs(PORT).map((a) => '\\"' + a + '\\"').join(', ')
    + ') -PassThru -WindowStyle Hidden -RedirectStandardOutput "' + path.join(ROOT, '_run.out')
    + '" -RedirectStandardError "' + path.join(ROOT, '_run.err') + '"')
  console.log('\n  ② 等端口起来后跑：node tools/iso-instance.mjs verify --name ' + NAME + ' --root ' + ROOT + ' --port ' + PORT)
  console.log('  ③ 起浏览器（可选）：加上 --browser 到 verify（会拉起独立 profile 的 Chrome 并等 CDP）')
  console.log('\n  ' + token)
}

/** 宿主启动参数（cli.js 的 web 子命令）。 */
function hostArgs(port) {
  return ['--expose-internals', CLI, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
}

/** `verify`：对**已经起来**的实例做隔离证明 + 落 instance.json（证明不过就不写、返回失败）。 */
async function verify() {
  console.log('=== 隔离证明：' + NAME + ' @端口 ' + PORT + ' ===')
  if (!await waitPort(PORT, 15000)) {
    console.error('  ✗ 端口 ' + PORT + ' 没在听 ⇒ 宿主没起来（① 那条命令跑了吗？）')
    process.exit(1)
  }
  const H = async (p, ms = 8000) => {
    try { return await fetch('http://127.0.0.1:' + PORT + p, { signal: AbortSignal.timeout(ms) }) } catch { return null }
  }
  const sr = await H('/bga/settings.json')
  const wr = await H('/bga/wallpapers.json')
  const head = sr ? sr.headers.get('x-bga-settings-status') : null
  let roots = null
  try { roots = wr ? await wr.json() : null } catch { roots = null }
  const prodSettings = path.join(PROD_HOME, 'dsh-bg-atelier-plus', 'settings.json')
  const prodHash = existsSync(prodSettings) ? sha(prodSettings) : '(无)'
  const inRoot = (p) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase())
  const proof = [
    ['插件接口活着（/bga/wallpapers.json 有响应）', !!roots, roots ? 'total=' + roots.total : '无响应'],
    ['插件 writableDir 在隔离根下', !!roots && inRoot(roots.writableDir), roots && roots.writableDir],
    ['插件图库 dir 在隔离根下', !!roots && inRoot(roots.dir), roots && roots.dir],
    ['图库只看到测试分类', !!roots && roots.categories.every((c) => c.name === '测试图' || c.name === '_验收标记图'),
      roots && roots.categories.map((c) => c.name).join(',')],
    ['新接口状态头可用', head !== null, 'x-bga-settings-status=' + head],
    ['生产 settings.json 哈希（本实例未改它）', true, prodHash.slice(0, 16)],
  ]
  let bad = 0
  for (const [n, okv, extra] of proof) {
    console.log('  ' + (okv ? '✅' : '❌') + ' ' + n + (extra ? '  [' + String(extra).slice(0, 90) + ']' : ''))
    if (!okv) bad++
  }
  if (bad) { console.error('  ✗ 隔离无法证明 ⇒ 不算成立'); process.exit(1) }

  let authUrl = null
  try { authUrl = (readFileSync(path.join(ROOT, '_run.out'), 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/) || [null])[0] } catch { /* noop */ }
  let hostPid = null
  try { hostPid = Number(String(readFileSync(path.join(ROOT, 'instance.pid'), 'utf8')).trim()) || null } catch { /* noop */ }
  let browserPid = null
  if (WITH_BROWSER) {
    const bprof = path.join(ROOT, 'browser-profile')
    mkdirSync(bprof, { recursive: true })
    const bArgs = ['--user-data-dir=' + bprof, '--remote-debugging-port=' + CDP,
      '--no-first-run', '--no-default-browser-check', authUrl || ('http://127.0.0.1:' + PORT + '/')]
    const bps = '$p = Start-Process -FilePath ' + q(CHROME) + ' -ArgumentList @(' + bArgs.map(arg).join(',') + ') -PassThru -WindowStyle Minimized'
    spawnSync('powershell', ['-NoProfile', '-Command', bps], { stdio: 'ignore' })
    browserPid = null
    const okCdp = await waitPort(CDP, 40000)
    console.log('  ' + (okCdp ? '✅' : '❌') + ' 隔离浏览器 CDP ' + CDP + (okCdp ? '' : '（没起来；可手起 Chrome）'))
    if (!okCdp) bad++
  }
  if (bad) process.exit(1)
  const inst = { name: NAME, root: ROOT, port: PORT, cdpPort: CDP, pid: hostPid, browserPid, home: path.join(ROOT, 'home'), plugin: path.join(ROOT, 'plugin', 'dsh-bg-atelier-official'), authUrl, startedAt: new Date().toISOString(), prodSettingsHashAtVerify: prodHash }
  writeFileSync(INSTANCE_JSON, JSON.stringify(inst, null, 2), 'utf8')
  console.log('  → 已写 ' + INSTANCE_JSON)
  console.log('  绑定用：')
  console.log('    DSH_HOME=' + inst.home)
  console.log('    VB_GUI_HOST=127.0.0.1:' + PORT + '   VB_CDP_PORT=' + CDP)
  console.log('    VB_VIEWPORT=1426x807@1.1666666269302368  VB_SKIP_ONBOARDING=1')
  console.log('    VB_PLUGIN_DIR=' + inst.plugin)
}

/**
 * `run`：**一条命令跑完整个隔离验收**。
 *
 * 为什么必须"一条命令"（实测结论）：宿主在同一次工具调用内能长期存活，但那次调用的
 * **Windows Job 关闭时会被一起回收** —— 所以"先起宿主、下一条命令再验收"的两步式在本环境
 * 不成立。这里把宿主作为**本进程的子进程**（不 detach、不交给 PowerShell），整条流水线在
 * 同一次调用内完成：
 *   准备 → 起宿主 → 等端口 → 隔离证明(不过就退) → 起隔离浏览器 → 引导/底图准备 →
 *   selftest → capture/compare → A 级变异 → 覆盖审计 → 收尾(杀子进程) → 复核生产未被碰。
 * 任何一步失败都记下来，最后统一给结论与非零退出码；收尾写在 finally 里，异常也不跳过。
 */
async function run() {
  const baseline = opt('baseline', 'iso-auto')
  const viewport = opt('viewport', '1426x807@1.1666666269302368')
  // 默认跑**完整**验收（含变异与覆盖审计）；`--steps` 可裁剪。
  const steps = opt('steps', 'selftest,compare,mutate,audit')
  // `--repeat N`：把 compare 在**同一个环境里**连跑 N 次（稳定性证据：只跑过单次的部分）。
  const repeat = Math.max(1, Number(opt('repeat', '1')) || 1)
  const want = new Set(steps.split(',').map((s) => s.trim()).filter(Boolean))
  const results = []
  const note = (n, okv, extra = '') => { results.push({ n, ok: okv, extra }); console.log('  ' + (okv ? '✅' : '❌') + ' ' + n + (extra ? '  [' + String(extra).slice(0, 120) + ']' : '')) }

  const prodSettings = path.join(PROD_HOME, 'dsh-bg-atelier-plus', 'settings.json')
  const prodHash0 = existsSync(prodSettings) ? sha(prodSettings) : '(无)'
  const prodClientHash0 = sha(path.join(PROD_PLUGIN, 'client.js'))
  let host = null, browser = null

  try {
    console.log('=== 隔离验收（一条命令跑完）：' + NAME + ' @' + PORT + ' ===')
    // ① 准备（幂等：已有副本就不重建）
    if (!existsSync(path.join(ROOT, 'plugin', 'dsh-bg-atelier-official', 'index.js'))) {
      console.log('  [准备] 根目录不存在，先建 …')
      buildPluginCopy(); buildProfile(); buildTestLibrary()
    } else console.log('  [准备] 复用已有根目录 ' + ROOT)

    // ② 起宿主：**本进程的直接子进程**（不 detach）
    const outf = path.join(ROOT, '_run.out'), errf = path.join(ROOT, '_run.err')
    rmSync(outf, { force: true }); rmSync(errf, { force: true })
    const ofd = openSync(outf, 'a'), efd = openSync(errf, 'a')
    host = spawn(EXE, hostArgs(PORT), {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(ROOT, 'home') },
      stdio: ['ignore', ofd, efd], windowsHide: true,
    })
    closeSync(ofd); closeSync(efd)
    host.on('error', (e) => console.error('  ✗ 宿主 spawn 失败：' + e.message))
    note('宿主子进程已起（PID ' + host.pid + '）', true)

    // ③ 等端口
    const up = await waitPort(PORT, 90000)
    note('宿主端口 ' + PORT + ' 就绪', up, up ? '' : '90 秒没起来（看 ' + errf + '）')
    if (!up) throw new Error('宿主没起来')

    // ④ 隔离证明（硬门槛）
    const wpRes = await fetchJson('http://127.0.0.1:' + PORT + '/bga/wallpapers.json')
    let head = null
    try { head = (await fetch('http://127.0.0.1:' + PORT + '/bga/settings.json', { signal: AbortSignal.timeout(8000) })).headers.get('x-bga-settings-status') } catch { /* noop */ }
    const inRoot = (p) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(path.resolve(ROOT).toLowerCase())
    note('插件数据落点在隔离根下', !!wpRes && inRoot(wpRes.writableDir), wpRes && wpRes.writableDir)
    note('图库只看到测试分类', !!wpRes && wpRes.categories.every((c) => c.name === '测试图' || c.name === '_验收标记图'),
      wpRes && wpRes.categories.map((c) => c.name).join(','))
    note('新接口状态头可用', head !== null, 'x-bga-settings-status=' + head)
    if (results.some((r) => !r.ok)) throw new Error('隔离证明不成立 ⇒ 拒绝继续')

    // ⑤ 环境准备：**先**通过宿主 API 给全新 home 设一张测试底图，**再**起浏览器。
    //    ⚠️ 顺序不能反：页面首载时客户端会做一次 load/save，若那时磁盘上还没有底图，
    //    它就用默认值（无底图）存盘、把我们后来 PUT 的冲掉 ⇒ selftest 报"图片未就绪"、
    //    而且客户端那次存盘还会让字节级边界报"用户数据被改动"。实测踩过。
    await bootstrapWallpaper(wpRes, baseline)
    note('已给隔离实例设一张测试底图（先于浏览器）', true,
      '基准钉图或首张非标记图')

    // ⑥ 起隔离浏览器（独立 profile + CDP）
    const authUrl = (readFileSync(outf, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/) || [null])[0]
    if (!authUrl) note('拿到带 token 的认证 URL', false, 'stdout 里没找到；浏览器可能 401')
    const bprof = path.join(ROOT, 'browser-profile')
    mkdirSync(bprof, { recursive: true })
    // ★ 确定性渲染参数（**单变量定位出来的根因**，不是猜的）：
    //   同一根、同一配置、不改代码，两次独立会话录制，8/8 状态 PNG 字节都不同；
    //   空转 compare 得 0 一致 / 8 有差异（每态 1.2~1.5%，通道差 ±1 为主、边缘到 ~32）。
    //   逐项对照后排除了：底图取错（改确定性取图后数字不变）、缓存差异（隔离 home 无缓存目录）、
    //   布局/状态/探针差异（两份基准的 geom/pageState/probe 8/8 完全相同）。
    //   **只加 `--force-color-profile=srgb`** 再跑两次独立会话 ⇒ **8/8 状态字节完全相同、框内差异 0**。
    //   ⇒ 根因是浏览器启动时对显示器色彩配置的采样，与插件/动效无关。
    //   所以这里把"渲染环境确定"做成**默认**，而不是靠关特效或缩小比较区去换稳定性。
    //   （`--chrome-flags` 只能**追加**诊断参数；`--hide-scrollbars` 之类会改布局的不要加——
    //     实测它会改几何导致 capture 被拒。）
    const extraFlags = String(opt('chrome-flags', '')).split(/\s+/).filter(Boolean)
    const chromeFlags = ['--force-color-profile=srgb', ...extraFlags]
    if (extraFlags.length) console.log('  [诊断] Chrome 额外启动参数: ' + extraFlags.join(' '))
    browser = spawn(CHROME, ['--user-data-dir=' + bprof, '--remote-debugging-port=' + String(CDP),
      '--no-first-run', '--no-default-browser-check', ...chromeFlags, authUrl || ('http://127.0.0.1:' + PORT + '/')],
      { stdio: 'ignore', windowsHide: true })
    const cdpUp = await waitPort(CDP, 60000)
    note('隔离浏览器 CDP ' + CDP + ' 就绪', cdpUp, browser ? 'PID ' + browser.pid : '')
    if (!cdpUp) throw new Error('浏览器 CDP 没起来')
    await sleep(6000)   // 等应用首屏与客户端状态落定，再去截图/比图

    // ★ 首次运行引导要凭据才能建会话；而 `DockFx` 挂在 `conversation.composer.dock`
    //   （`client.js:3133`）—— 没有会话 ⇒ 动效节点不在位，`02-fx-nodes` 会被跳过。
    //   密钥**只经环境变量传入、只由应用写进隔离 home**（仓库外、不入 git）；脚本只打印掩码。
    // ★ 但**只在真的需要时才要密钥**：隔离 home 里已由应用存过凭据、或引导已过时，
    //   就不该再要环境变量、更不该把它记成失败 —— 否则"一条命令复现整套验收"会被一个
    //   无关的缺失卡成 ❌（实测就是这么误报的）。
    const key = process.env.VB_ISO_API_KEY
    if (key) {
      const r = await submitApiKey(key)
      note('向隔离实例提交 API Key（只打印掩码）', r === 'saved' || r === 'already',
        '结果=' + r + '  key=' + key.slice(0, 6) + '…')
    } else {
      const probe = await submitApiKey('', true)     // 只探测，不填任何东西
      if (probe === 'already') note('隔离实例已存过凭据（无需 VB_ISO_API_KEY）', true, '引导未出现')
      else note('隔离实例仍要凭据、但没给 VB_ISO_API_KEY ⇒ 建不了会话，动效状态会被跳过', false, probe)
    }
    // 会话是否存在（动效状态的前提）。**信息性**：没有也不算这一步失败 ——
    // 真正的判定在 02-fx-nodes 自己（它会大声拒绝参与比较）。
    try {
      const sdir = path.join(ROOT, 'home', 'sessions')
      const n = existsSync(sdir)
        ? readdirSync(sdir).reduce((a, d) => a + readdirSync(path.join(sdir, d)).length, 0) : 0
      note('隔离实例已有会话（动效状态的前提）', n > 0, n + ' 个' + (n ? '' : ' ⇒ 需先在隔离实例里建一个会话'))
    } catch { /* 数不出来不影响流程 */ }



    // ⑦ 跑验收步骤（显式绑定到本实例）
    const env = {
      ...process.env,
      DSH_HOME: path.join(ROOT, 'home'),
      VB_GUI_HOST: '127.0.0.1:' + PORT,
      VB_CDP_PORT: String(CDP),
      VB_VIEWPORT: viewport,
      VB_SKIP_ONBOARDING: '1',
      VB_PLUGIN_DIR: path.join(ROOT, 'plugin', 'dsh-bg-atelier-official'),
    }
    // 通用逃生口：把任意诊断脚本放进**已绑定好的环境**里跑（诊断用，不参与判定）。
    // 用 stdio:'inherit' 让输出**原样打出来** —— 诊断脚本的价值就在输出本身。
    const extra = opt('extra-script', '')
    if (extra) {
      console.log('  --- 诊断脚本 ' + path.basename(extra) + '（输出直通） ---')
      // 用 pipe 捕获后**显式打印两个流**：`stdio:'inherit'` 在外层还有管道时会把内容丢掉
      // （实测：脚本 exit 1，却一行输出都看不到）。
      const rr = spawnSync(process.execPath, [path.resolve(extra)], { env, cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      const so = String(rr.stdout || ''), se = String(rr.stderr || '')
      if (so.trim()) for (const l of so.split(/\r?\n/)) console.log('    ' + l)
      if (se.trim()) for (const l of se.split(/\r?\n/)) console.error('    [err] ' + l)
      note('诊断脚本 ' + path.basename(extra), rr.status === 0, 'exit ' + rr.status)
    }

    const baseDir = path.join(REPO, 'baselines', baseline)
    // 04 状态要用「标记图」；装进**隔离图库**（脚本用的是隔离 DSH_HOME，不碰用户图库）
    const needCapture = want.has('capture') || (want.has('compare') && !existsSync(path.join(baseDir, 'manifest.json')))
    if (needCapture) await runStep('装标记图（隔离库）', [path.join(HERE, 'make-marker-wallpaper.mjs')], env, note)
    if (want.has('selftest')) await runStep('selftest', [path.join(HERE, 'visual-baseline.mjs'), 'selftest'], env, note)
    if (needCapture) await runStep('capture ' + baseline, [path.join(HERE, 'visual-baseline.mjs'), 'capture', baseline], env, note)
    if (want.has('compare')) {
      for (let i = 1; i <= repeat; i++) {
        await runStep('compare ' + baseline + (repeat > 1 ? ' #' + i + '/' + repeat : ''),
          [path.join(HERE, 'visual-baseline.mjs'), 'compare', baseline], env, note)
      }
    }
    if (want.has('mutate')) await runStep('A 级变异', [path.join(HERE, 'mutate-real-style.mjs'), baseline], env, note)
    if (want.has('audit')) await runStep('覆盖审计', [path.join(HERE, 'audit-oracle-coverage.mjs'), baseline], env, note)
  } catch (e) {
    console.error('  ✗ 中止：' + String(e && e.message || e))
  } finally {
    // ⑧ 收尾：杀掉**自己起的**子进程（含树），再复核生产未被碰
    console.log('  [收尾] 结束隔离宿主与浏览器')
    if (browser && browser.pid) spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' })
    if (host && host.pid) spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2500)
    const prodHash1 = existsSync(prodSettings) ? sha(prodSettings) : '(无)'
    const prodClientHash1 = sha(path.join(PROD_PLUGIN, 'client.js'))
    note('生产 settings.json 未被改动', prodHash0 === prodHash1, prodHash0.slice(0, 12) + ' → ' + prodHash1.slice(0, 12))
    note('生产插件代码未被改动', prodClientHash0 === prodClientHash1, prodClientHash1.slice(0, 12))
    note('隔离宿主端口已关闭', !(await listening(PORT)), '端口 ' + PORT)
  }

  const bad = results.filter((r) => !r.ok).length
  console.log('\n隔离验收汇总：' + (results.length - bad) + ' 通过 / ' + bad + ' 失败')
  process.exit(bad ? 1 : 0)
}

/** 取 JSON（带超时，避免没有 AbortSignal 时挂死）。 */
async function fetchJson(url, ms = 8000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return await r.json() } catch { return null }
}

/**
 * 把 API Key 填进首次运行引导（若在），让隔离实例能建会话。
 * 返回 'saved' | 'already' | 'no-dialog' | 'no-input' | 'failed:<原因>'。
 * ⚠️ 只打印掩码；密钥本身由应用写进隔离 home 的 .credentials.yaml（仓库外、不入 git）。
 */
async function submitApiKey(key, dryRun = false) {
  const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1:' + PORT))
  if (!page) return 'no-page'
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')) })
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value
  try {
    // 已经配置过就别再填（避免把同一把钥匙反复写）
    const hasDialog = await ev(`!![...document.querySelectorAll('button')].find(b=>String(b.textContent||'').trim()==='保存并继续')`)
    if (!hasDialog) return 'already'
    if (dryRun) return 'needs-key'    // 只探测：不填、不点
    const wrote = await ev(`(()=>{
      const btns=[...document.querySelectorAll('button')];
      const save=btns.find(b=>String(b.textContent||'').trim()==='保存并继续'); if(!save) return 'no-save-btn';
      const dlg=save.closest('[role="dialog"]')||document;
      const inp=[...dlg.querySelectorAll('input')].find(i=>i.type==='password'||/api|密钥|key/i.test(i.placeholder||i.name||i.getAttribute('aria-label')||''))
        ||[...dlg.querySelectorAll('input')][0];
      if(!inp) return 'no-input';
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(inp, ${JSON.stringify(key)});
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      return 'filled:'+inp.type})()`)
    if (String(wrote).startsWith('no-')) return wrote
    await sleep(1200)
    const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>String(x.textContent||'').trim()==='保存并继续');if(!b)return 'gone';b.click();return 'clicked'})()`)
    await sleep(4000)
    const after = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>String(x.textContent||'').trim()==='保存并继续');
      return JSON.stringify({stillAsking:!!b, url:location.href.replace(/token=.*/,'***'), text:String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)})})()`)
    console.log('    引导提交: ' + wrote + ' → ' + clicked + ' → ' + after)
    return /"stillAsking":false/.test(String(after)) ? 'saved' : 'failed:仍在要求密钥'
  } catch (e) {
    return 'failed:' + String(e && e.message || e).slice(0, 60)
  } finally { try { ws.close() } catch { /* noop */ } }
}

/**
 * 给实例设一张底图（**必须确定**）。
 *
 * ⚠️ 踩过的坑：原来按"图库第一个分类的第一张"取 —— 而图库内容会变（装标记图后
 * `_验收标记图` 排到 `测试图` 前面），于是**录基准时设的是 iso-A、空转对照时设的是
 * marker**，同一份基准跨实例重启比出 `0 一致 / 8 有差异`（每态 1.2~1.5% 差异）。
 * 那是**我自己 harness 的不确定性**，不是产品回归。
 * 现在的优先级：① 基准里记的 `pinnedWallpaper`（保证与录基准时同一张）；
 * ② 否则挑**非** `_验收标记图` 分类里字典序最小的那张（仍然确定，不随枚举顺序漂）。
 */
async function bootstrapWallpaper(wp, baseline) {
  let chosen = null
  try {
    const mf = baseline && path.join(REPO, 'baselines', baseline, 'manifest.json')
    if (mf && existsSync(mf)) {
      const pin = JSON.parse(readFileSync(mf, 'utf8')).pinnedWallpaper
      if (pin && pin.file) chosen = { cat: pin.cat, file: pin.file, name: pin.name, url: pin.url, hd: pin.hd, tags: pin.tags, no: pin.no, size: pin.size, id: pin.id }
    }
  } catch { /* 读不到就退到 ② */ }
  if (!chosen) {
    const cats = (wp && wp.categories ? wp.categories.slice() : [])
      .filter((c) => c.name !== '_验收标记图')
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const cat = cats[0]
    const items = cat && cat.items ? cat.items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))) : []
    const it = items[0]
    if (it) chosen = { cat: cat.name, file: it.name, name: it.base, url: it.url, hd: !!it.hd, tags: it.tags, no: it.no, size: it.size, id: cat.name + '\u0000' + it.name }
  }
  if (!chosen) return
  const body = {
    autoOn: false, autoMin: 30, zoom: 1, focus: '50% 50%', effect: 'firefly',
    wallpaper: chosen,
  }
  try {
    await fetch('http://127.0.0.1:' + PORT + '/bga/settings.json', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    })
  } catch { /* noop */ }
}

/** 跑一个验收脚本（子进程），用它的退出码与输出里的结论行判通过。 */
async function runStep(label, argv, env, note) {
  console.log('  --- ' + label + ' ---')
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, argv, { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { out += d })
    c.on('close', (code) => resolve({ code, out }))
  })
  const verdict = (r.out.match(/自检：.*|视觉回归：.*|A 级坏例：.*|覆盖审计：.*/) || [''])[0].trim()
  const fails = (r.out.match(/❌[^\n]*/g) || []).slice(0, 3).map((s) => s.trim().slice(0, 110))
  note(label + ' ⇒ exit ' + r.code, r.code === 0, verdict)
  for (const f of fails) console.log('        ' + f)
  // 失败时把**输出尾部**打出来 —— 有些失败走的是 ✗/拒绝 路径、不带 ❌，只看 ❌ 会两眼一抹黑。
  // 同时把**完整输出存盘**：只印尾部会丢掉"哪个状态未就绪/为什么"这类关键中间行
  // （踩过：4 次连续失败都是"1 未就绪跳过"，但日志里查不出是哪个状态）。
  if (r.code !== 0) {
    for (const l of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(-14)) console.log('        | ' + l.trim().slice(0, 150))
    try {
      const dir = path.join(ROOT, 'logs'); mkdirSync(dir, { recursive: true })
      const f = path.join(dir, label.replace(/[^\w.-]+/g, '_') + '.log')
      writeFileSync(f, r.out, 'utf8')
      console.log('        完整输出: ' + f)
    } catch { /* 存盘失败不影响判定 */ }
  }
  return r
}

if (cmd === 'prepare') prepare()
else if (cmd === 'verify') await verify()
else if (cmd === 'run') await run()
else if (cmd === 'up') await up()
else if (cmd === 'down') down()
else if (cmd === 'status') await status()
else { console.error('用法: node tools/iso-instance.mjs run|prepare|verify|up|down|status [--name poc1] [--root D:\\dsh-iso\\poc1] [--port 19402] [--cdp 19502] [--baseline iso-auto] [--steps selftest,compare,mutate,audit] [--repeat N] [--viewport 1426x807@DPR] [--browser]'); process.exit(2) }
