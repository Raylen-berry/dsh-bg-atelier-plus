// tools/verify-oracle-flow.mjs —— oracle 的**完整控制流**离线回归（不复制实现）
//
// 为什么需要：审核方指出 verify-oracle-restore.mjs 里的退出码断言用的是**复制的 exitFor()**
// 与文本断言，那只能证明"源码里写了那句话"，不能证明"整条流程真的按那个语义走"。
// 本套件把 visual-baseline.mjs 里的**真实函数**装进沙箱跑，覆盖两条完整路径：
//   A. 首次 GET 失败 → 第二次 GET 成功 → 钉图必须**被拒绝**（不得写盘）→ 不得静默成功
//   B. 轮播原本关闭 → compare 正常走完 → 还原判 'restored' → 退出码 0
// 并且直接检查"有没有发出 PUT"，而不是看字符串。
//
// 用法：node tools/verify-oracle-flow.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'visual-baseline.mjs'), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/** 从任意源文本里按"起始签名 → 配对右花括号"切出一个函数（去掉 export 前缀）。
 *  ⚠️ 必须从**函数体的左花括号**开始计数，不能从签名里第一个 `{` 开始 ——
 *    `judgeRotationRestore(need, { diskOk, memKnown } = {})` 这种解构参数会先闭合一次，
 *    导致只切出 77 字符的半截函数（这个坑踩过）。做法：先找到参数列表收尾的 ")"，再取 body。
 */
function sliceFrom(src, sig) {
  const begin = src.indexOf(sig)
  if (begin < 0) throw new Error('找不到 ' + sig)
  // 跳过参数列表：从签名的 "(" 起做圆括号配对，找到与之配对的 ")"
  let p = src.indexOf('(', begin), pd = 0
  for (; p < src.length; p++) {
    const ch = src[p]
    if (ch === '(') pd++
    else if (ch === ')') { pd--; if (pd === 0) break }
  }
  const bodyStart = src.indexOf('{', p + 1)
  let depth = 0, i = bodyStart
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return src.slice(begin, i).replace(/^export\s+/, '')
}

/**
 * 把 freezeRotation / pinWallpaper / restoreRotation 三个真函数装进沙箱。
 * 做法：从源码里切出这三个函数（连同它们依赖的 readState/cdp 桩），避免复制实现。
 *
 * getEmptyObjectReads：让前 N 次 GET 返回 `{}`（宿主 readSettings 读失败的样子，
 * HTTP 仍是 200）—— 专门复现审核方第六轮指出的两条丢设置路径。
 */
function loadFns({ getFailuresBeforeSuccess = 0, emptyObjectAt = [], initialAutoOn = true, renderedOverride = null, wallpaperSwitched = false } = {}) {
  const writes = []            // 记录所有 PUT
  const reads = { n: 0 }
  const settings = { autoOn: initialAutoOn, autoMin: 5, wallpaper: { file: 'x.png', cat: 'c' }, accent: '#fff' }

  const sliceFn = (sig) => {
    const begin = SRC.indexOf(sig)
    if (begin < 0) throw new Error('源码里找不到 ' + sig)
    // 从函数头扫到与之配对的收尾 "\n}"（靠花括号计数）
    return sliceFrom(SRC, sig)
  }

  const code = `
${sliceFn('async function freezeRotation(')}
${sliceFn('async function pinWallpaper(')}
${sliceFn('async function restoreRotation(')}
return { freezeRotation, pinWallpaper, restoreRotation };
`
  // restoreRotation 依赖 oracle-compare.mjs 里的纯函数 —— 一并注入**真实现**（不复制）。
  // ⚠️ isValidSettings 还依赖模块级常量 SETTINGS_KEYS，得连它一起切进来
  //    （第一版只切了函数 ⇒ ReferenceError: SETTINGS_KEYS is not defined）。
  const cmpSrc = fs.readFileSync(path.join(HERE, 'oracle-compare.mjs'), 'utf8')
  const keysBegin = cmpSrc.indexOf('const SETTINGS_KEYS = [')
  const keysEnd = cmpSrc.indexOf(']', keysBegin) + 1
  const keysSrc = cmpSrc.slice(keysBegin, keysEnd)
  const validSrc = sliceFrom(cmpSrc, 'export function isValidSettings(')
  const needSrc = sliceFrom(cmpSrc, 'export function rotationRestoreNeed(')
  const judgeSrc = sliceFrom(cmpSrc, 'export function judgeRotationRestore(')
  const logs = []
  const sandbox = {
    JSON, Object, Array, String, Number, Boolean, Math, Promise, Error, isFinite, console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERR:' + a.join(' ')) },
    sleep: async () => {},                       // 不真等
    cdpSend: null,                                // 由 readState 桩替代
    __writes: writes,
    __settings: settings,
    __reads: reads,
    __getFailuresLeft: { n: getFailuresBeforeSuccess },
    // ⚠️ 宿主的 readSettings 在**磁盘读失败时返回 `{}` 且 GET 仍报 200**（host index.js：
    //    `catch { return {} }`）。这是审核方第六轮抓出来的真路径 —— 所以桩也要能模拟它。
    //    按第 N 次 GET 计（1 起），便于精确命中"freeze 的那次"或"pin 内部的那次"。
    __emptyObjectAt: Array.isArray(emptyObjectAt) ? emptyObjectAt.slice() : [],
    __renderedOverride: renderedOverride,
    // restoreRotation 里引用的模块级标志（本次是否切换过底图）——沙箱必须提供，否则 ReferenceError
    wallpaperSwitched: !!wallpaperSwitched,
    log: () => {},
  }
  // readState：模拟页面里执行 fetch('/bga/settings.json')；GET 可按需失败若干次
  sandbox.readState = async (expr) => {
    // ⚠️ pinWallpaper 现在会多问一次客户端确认（__bgaStateProbe + **实际渲染的背景 URL**）。
    //    桩必须跟上被测函数的新依赖 —— 否则确认拿不到合法回答、钉图判失败、A2 假性失败。
    //    rendered 里要给出不含钉图文件名的 URL 时，就正是在测"钉图未渲染"这条守卫。
    if (/__bgaStateProbe/.test(expr)) {
      const wf = sandbox.__settings.wallpaper ? sandbox.__settings.wallpaper.file : null
      const renderOverride = sandbox.__renderedOverride
      const rendered = renderOverride != null ? renderOverride
        : ('url("http://x/bga/wallpapers/' + (wf ? encodeURIComponent(wf) : '') + '")')
      return JSON.stringify({
        probe: 'ok',
        autoOn: sandbox.__settings.autoOn === true,
        file: wf,
        rendered,
      })
    }
    const isPut = /method:\s*'PUT'/.test(expr)
    if (isPut) {
      const m = expr.match(/body:\s*"((?:[^"\\]|\\.)*)"/)
      let body = null
      if (m) { try { body = JSON.parse(JSON.parse('"' + m[1] + '"')) } catch { body = null } }
      writes.push(body)
      if (body) Object.assign(settings, body)
      // ⚠️ 返回的是**页面里那段 JS 的返回值**（'pinned(...) + autoOn=false' 字符串），
      //    不是 HTTP 对象 —— 真函数现在按这个前缀判断 PUT 是否确认成功。
      //    （第一版这里返回 {"ok":true}，导致 A2 假性失败。）
      return 'pinned(w) + autoOn=false'
    }
    if (/cache:'no-store'/.test(expr) || /cache: 'no-store'/.test(expr)) {
      reads.n++
      if (sandbox.__getFailuresLeft.n > 0) { sandbox.__getFailuresLeft.n--; return null }   // 模拟整次读挂掉
      const idx = sandbox.__emptyObjectAt.indexOf(reads.n)
      if (idx >= 0) { sandbox.__emptyObjectAt.splice(idx, 1); return '{}' }                  // 模拟宿主读失败：200 + {}
      return JSON.stringify(settings)
    }
    return '"ok"'
  }
  sandbox.cdp = { send: async () => ({}) }
  vm.createContext(sandbox)
  const fns = vm.runInContext('(function(){' + keysSrc + '\n' + validSrc + '\n' + needSrc + '\n' + judgeSrc + '\n' + code + '})()', sandbox, { filename: 'oracle-fns.js' })
  return { fns, writes, reads, settings, logs, sandbox }
}

console.log('\n=== oracle 完整控制流回归（跑真函数，不复制实现）===')

console.log('\n— A. 首次 GET 失败 → 第二次成功：钉图必须被拒绝、不得写盘 —')
{
  // freezeRotation 的第一次 GET 失败 ⇒ 返回 null（无原值）
  const { fns, writes, settings } = loadFns({ getFailuresBeforeSuccess: 1, initialAutoOn: true })
  const frozen = await fns.freezeRotation(false)
  ok('freezeRotation 在读失败时返回 null', frozen === null, String(frozen))
  ok('此时**还没有任何写入**', writes.length === 0, writes.length + ' 次 PUT')

  // 关键：后续即便再读到有效值，也必须拒绝写入（没有原始依据）
  const pinned = await fns.pinWallpaper(settings.wallpaper, false, frozen ? frozen.before : null)
  ok('★ 钉图被拒绝（返回 false）', pinned === false, String(pinned))
  ok('★ 拒绝后**确实没有写盘**（autoOn 仍是原值 true）',
    writes.length === 0 && settings.autoOn === true,
    'PUT ' + writes.length + ' 次, autoOn=' + settings.autoOn)
}

console.log('\n— A2. 反证：若把二次读到的值当依据传进去，才会写入（确认守卫是真的在起作用）—')
{
  const { fns, writes, settings } = loadFns({ getFailuresBeforeSuccess: 0, initialAutoOn: true })
  const frozen = await fns.freezeRotation(false)
  ok('正常路径下 freezeRotation 返回 {raw,before}', !!(frozen && frozen.before))
  const pinned = await fns.pinWallpaper(settings.wallpaper, false, frozen.before)
  ok('有有效原始设置时允许写入', pinned === true && writes.length >= 1, 'PUT ' + writes.length + ' 次')
  ok('写入带上了全部字段（不是只写两个）', writes[0] && typeof writes[0] === 'object' && Object.keys(writes[0]).length >= 4,
    writes[0] ? Object.keys(writes[0]).length + ' 个字段' : '无')
}

console.log('\n— A3. 宿主读失败返回 {}（HTTP 200）：{} 不算有效原值 —')
{
  // 审核方第六轮复现的路径①：宿主 readSettings 磁盘读失败 ⇒ 返回 {} 且 GET 报 200。
  // 旧守卫只查"是对象" ⇒ {} 放行 ⇒ 钉图写 autoOn:false ⇒ 还原判"无需还原" ⇒ exit=0，
  // 用户的轮播被留在关。现在 {} 必须被 freezeRotation 当成读失败。
  const { fns, writes, settings } = loadFns({ emptyObjectAt: [1], initialAutoOn: true })
  const frozen = await fns.freezeRotation(false)
  ok('★ freezeRotation 把 {} 视同读失败（返回 null）', frozen === null, String(frozen))
  ok('★ 此后钉图被拒绝、0 次 PUT、autoOn 仍为 true',
    (await fns.pinWallpaper(settings.wallpaper, false, null)) === false
      && writes.length === 0 && settings.autoOn === true,
    'PUT ' + writes.length + ' 次, autoOn=' + settings.autoOn)
}

console.log('\n— A4. 原本关着 + 钉图自己的 GET 返回 {}：不得把整份设置写成残缺 —')
{
  // 审核方第六轮复现的路径②：freeze 正常（autoOn=false 的完整设置），
  // 但 pinWallpaper 内部那次 GET 读失败返回 {} ⇒ 旧代码 {...{}, autoOn:false, wallpaper}
  // 会把 26 字段写成 2 字段。现在 must 拒绝写。
  const { fns, writes, settings } = loadFns({ emptyObjectAt: [2], initialAutoOn: false })
  const frozen = await fns.freezeRotation(false)          // 第 1 次 GET：拿到真实设置；{} 命中第 2 次（pin 内部）
  ok('freeze 正常拿到原值', !!(frozen && frozen.before), 'autoOn=' + frozen?.before?.autoOn)
  const pinned = await fns.pinWallpaper({ file: 'y.png', cat: 'c' }, false, frozen.before)
  ok('★ 钉图被拒绝（自己那次 GET 拿到 {}）', pinned === false, String(pinned))
  ok('★ **0 次写入**（旧路径会写 2 字段残缺文件）', writes.length === 0,
    writes.length ? 'PUT 了 ' + writes.length + ' 次：' + JSON.stringify(writes[0]) : '无')
  ok('★ 设置对象原封不动（4 个字段都还在）', Object.keys(settings).length === 4,
    Object.keys(settings).join(','))
}

console.log('\n— A5. 设置说钉上了、**画面却还没渲染那张**（真机踩过的 93% 假回归根因）—')
{
  // 场景：PUT 成功、刷新成功、__bgaStateProbe 的 wallpaper 也对，
  // 但 body::before 的 backgroundImage 还是上一张 ⇒ 若就此 return true，
  // 基准会录在错误的图上，之后每次 compare 都报 ~93%（真机就是这么坏的）。
  const other = encodeURIComponent('别的图.png')
  const { fns, writes, settings } = loadFns({
    initialAutoOn: true,
    renderedOverride: 'url("http://x/bga/wallpapers/' + other + '")',
  })
  const frozen = await fns.freezeRotation(false)
  const pinned = await fns.pinWallpaper(settings.wallpaper, false, frozen.before)
  ok('★ 设置确实写入了（PUT 发生）', writes.length >= 1, 'PUT ' + writes.length + ' 次')
  ok('★ 但渲染未确认 ⇒ pinWallpaper 返回 false（不许继续）', pinned === false, String(pinned))
}

console.log('\n— B. 轮播原本关闭：整条链不应产生"失败" —')
{
  const { fns, writes } = loadFns({ getFailuresBeforeSuccess: 0, initialAutoOn: false })
  const frozen = await fns.freezeRotation(false)
  ok('原本关着时 freezeRotation 仍返回原值（供判定用）', !!(frozen && frozen.before), 'autoOn=' + frozen?.before?.autoOn)
  ok('原本关着时**不需要**改 autoOn', frozen.before.autoOn === false)
  const outcome = await fns.restoreRotation(frozen.raw, false)
  ok('★ 还原判定为 restored（无需还原 ≠ 失败）', outcome === 'restored', String(outcome))
}

console.log('\n— C. 三态契约的其余分支（走真函数）—')
{
  const { fns } = loadFns({})
  ok('无原值 ⇒ skipped', await fns.restoreRotation(null, false) === 'skipped')
  ok('坏 JSON ⇒ skipped', await fns.restoreRotation('{坏 json', false) === 'skipped')
  ok('数组 ⇒ skipped（Array.isArray 那条）', await fns.restoreRotation('[1,2]', false) === 'skipped')
}

console.log('\n— D. 还原失败必须可被判出来（磁盘没变 true 时）—')
{
  const { fns, sandbox } = loadFns({ getFailuresBeforeSuccess: 0, initialAutoOn: true })
  const frozen = await fns.freezeRotation(false)
  // 让还原阶段的回读拿不到（模拟刷新失败/内存未同步）
  sandbox.__getFailuresLeft = { n: 99 }
  const outcome = await fns.restoreRotation(frozen.raw, false)
  ok('★ 回读失败 ⇒ failed（不把"没能确认"当通过）', outcome === 'failed', String(outcome))
}

console.log('\noracle 控制流：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)