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
 */
function loadFns({ getFailuresBeforeSuccess = 0, initialAutoOn = true } = {}) {
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
  // restoreRotation 依赖 oracle-compare.mjs 里的两个纯函数 —— 一并注入真实现（不复制）
  const cmpSrc = fs.readFileSync(path.join(HERE, 'oracle-compare.mjs'), 'utf8')
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
    log: () => {},
  }
  // readState：模拟页面里执行 fetch('/bga/settings.json')；GET 可按需失败若干次
  sandbox.readState = async (expr) => {
    const isPut = /method:\s*'PUT'/.test(expr)
    if (isPut) {
      const m = expr.match(/body:\s*"((?:[^"\\]|\\.)*)"/)
      let body = null
      if (m) { try { body = JSON.parse(JSON.parse('"' + m[1] + '"')) } catch { body = null } }
      writes.push(body)
      if (body) Object.assign(settings, body)
      return JSON.stringify({ ok: true })
    }
    if (/cache:'no-store'/.test(expr) || /cache: 'no-store'/.test(expr)) {
      reads.n++
      if (sandbox.__getFailuresLeft.n > 0) { sandbox.__getFailuresLeft.n--; return null }   // 模拟读失败
      return JSON.stringify(settings)
    }
    return '"ok"'
  }
  sandbox.cdp = { send: async () => ({}) }
  vm.createContext(sandbox)
  const fns = vm.runInContext('(function(){' + needSrc + '\n' + judgeSrc + '\n' + code + '})()', sandbox, { filename: 'oracle-fns.js' })
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