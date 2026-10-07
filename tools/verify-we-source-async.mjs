// tools/verify-we-source-async.mjs —— WeSource 异步语义验收（离线）
//
// 为什么需要它：重构步 2c-1 把原来的**两套**请求簿记（WeSection 的 AbortController+ref，
// 与 weRestore 的裸 fetch）合并成一套 WeSource。审核方指出："37 张卡片正常"只证明常规
// 链路可用，**不能证明异步时序等价** —— 必须逐场景验证。
//
// 这里用 vm 沙箱加载真 client.js，喂一个**可控的假 fetch**（能按指定顺序 resolve、
// 能挂起、能失败），然后断言六种时序下的行为。全是离线、不连真 DSH、不写用户设置。
//
// 六个场景（审核方指定）：
//   ① A 先发、B 后发、A 最后返回   → 旧结果不能覆盖新结果
//   ② 加载途中切换来源             → 上一来源不能写进新来源的界面
//   ③ 加载途中销毁/关闭             → 不再写入失效界面，且在飞请求被取消
//   ④ 请求失败后重试               → 失败能结束（loading 归位），重试能成功
//   ⑤ 快速连续请求                 → 最后一次赢，不产生"重复消费"式的错乱
//   ⑥ 冷启动 vs 缓存命中            → 结果一致，过程可解释（force 参数正确传递）
//
// 用法：node tools/verify-we-source-async.mjs
import fs from 'node:fs'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ---------------------------------------------------------------- 假 fetch 工厂
// 每个请求返回一个可手动 resolve/reject 的 deferred，并按 URL 记账。
function makeFetch() {
  const calls = []   // { url, signal, resolve, reject, aborted }
  const impl = (url, opts = {}) => {
    const entry = { url: String(url), opts, aborted: false, settled: false }
    const p = new Promise((resolve, reject) => {
      entry.resolve = (body, status = 200) => {
        if (entry.settled) return
        entry.settled = true
        resolve({ ok: status >= 200 && status < 300, status, json: async () => body })
      }
      entry.reject = (err) => {
        if (entry.settled) return
        entry.settled = true
        reject(err || new Error('network fail'))
      }
    })
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        entry.aborted = true
        entry.reject(new DOMException('aborted', 'AbortError'))
      })
    }
    entry.promise = p
    calls.push(entry)
    return p
  }
  return { impl, calls }
}

/** 在沙箱里加载真 client.js，返回 internals 与假 fetch 账本。 */
function loadClient() {
  const { impl, calls } = makeFetch()
  const loaded = { exports: null }
  const sandbox = {
    window: { __ModuleLoader__: { load(m) { loaded.module = m } } },
    console: { log() {}, warn() {}, error() {} },
    fetch: impl,
    AbortController,
    DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    JSON, Object, Array, String, Number, Boolean, Math, Date, Promise, Error, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      head: { appendChild() {}, removeChild() {} },
      body: {}, documentElement: { style: {} },
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
    },
  }
  sandbox.window.document = sandbox.document
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  const mod = loaded.module
  if (!mod || !mod.factory) throw new Error('client.js 未按 __ModuleLoader__ 约定注册')
  const exportsObj = {}
  mod.factory((name) => {
    if (name === 'react') return { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) }
    return {}
  })
  // factory 通常把东西挂到 module.exports 或返回对象
  const internals = (mod.exports && mod.exports.internals) || (loaded.exports && loaded.exports.internals) || null
  return { internals, calls }
}

// WeSource 不是 exports 的一部分（它是内部实现），所以从源码里定位它并单独求值。
// 这样测的是**真源码**，不是复制品 —— 复制品会与实现漂移。
function extractWeSource() {
  const begin = src.indexOf('var WeSource = (function ()')
  if (begin < 0) throw new Error('源码里找不到 WeSource 定义（重构后被改名了？）')
  // 从 var 起到该 IIFE 的 `})()` 结束
  const endMarker = '})()'
  const end = src.indexOf(endMarker, begin)
  if (end < 0) throw new Error('WeSource 的 IIFE 结束标记找不到')
  const snippet = src.slice(begin, end + endMarker.length)
  // 它依赖 weUrl()，把那个也带上
  const urlFn = src.slice(src.indexOf('var WE_PREFIX'), src.indexOf('\n', src.indexOf("function weUrl(pathPart)")))
  return urlFn + '\n' + snippet + '\nreturn WeSource\n'
}

/** 在带假 fetch 的沙箱里求值真 WeSource。 */
function makeWeSource() {
  const { impl, calls } = makeFetch()
  const sandbox = { fetch: impl, AbortController, DOMException, JSON, Object, Promise, Error, String, encodeURIComponent }
  sandbox.window = {}
  vm.createContext(sandbox)
  const code = '(function(){' + extractWeSource() + '})()'
  const WeSource = vm.runInContext(code, sandbox, { filename: 'WeSource.js' })
  return { WeSource, calls, sandbox }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\n=== WeSource 异步语义验收 ===')

console.log('\n— ① A 先发、B 后发、A 最后返回：旧结果不能覆盖新结果 —')
{
  const { WeSource, calls } = makeWeSource()
  const pA = WeSource.library(false)
  await tick()
  const pB = WeSource.library(false)
  await tick()
  ok('发了两次请求', calls.length === 2, calls.length + ' 次')
  ok('第一次请求被取消（后发先至的前提）', calls[0].aborted === true)

  // 故意让**先发的 A 最后返回**
  calls[1].resolve({ entries: [{ id: 'B' }], weFound: true })
  await tick()
  const rB = await pB
  calls[0].resolve({ entries: [{ id: 'A' }], weFound: true })
  await tick()
  const rA = await pA

  ok('后发的 B 拿到自己的结果', rB.ok === true && rB.entries[0].id === 'B', JSON.stringify(rB.entries && rB.entries[0]))
  ok('先发的 A 因被取消而不产出结果（不会覆盖 B）', rA.aborted === true || rA.ok === false,
    JSON.stringify(rA))

  // 关键断言：A 迟到的 resolve **不会**把 inflight 的当前值改回去
  const pC = WeSource.library(false)
  await tick()
  const last = calls[calls.length - 1]
  ok('后续请求仍能正常发起（inflight 簿记没被旧请求弄坏）', !!last && last !== calls[0])
  last.resolve({ entries: [], weFound: true })
  await pC
}

console.log('\n— ② 加载途中切换来源（library → status）：互不覆盖 —')
{
  const { WeSource, calls } = makeWeSource()
  const pLib = WeSource.library(false)
  await tick()
  const pSt = WeSource.status(false)
  await tick()
  ok('两个不同 kind 各自发了一次', calls.length === 2, calls.length + ' 次')
  ok('切到 status **不会**取消 library（不同 kind 互不干扰）', calls[0].aborted === false)

  calls[1].resolve({ bridge: { running: true } })
  const rSt = await pSt
  ok('status 拿到桥状态', rSt.ok === true && rSt.bridge.running === true)

  calls[0].resolve({ entries: [{ id: 'X' }], weFound: true })
  const rLib = await pLib
  ok('library 仍拿到自己的结果（没被 status 挤掉）', rLib.ok === true && rLib.entries[0].id === 'X')

  // 同 kind 再次发起才应取消前一个
  const pLib2 = WeSource.library(false)
  await tick()
  ok('同 kind 再发一次 ⇒ 取消前一个', calls[0].aborted === true)
  calls[calls.length - 1].resolve({ entries: [], weFound: true })
  await pLib2
}

console.log('\n— ③ 加载途中销毁：不再写入，且在飞请求被取消 —')
{
  const { WeSource, calls } = makeWeSource()
  const p = WeSource.library(false)
  await tick()
  ok('请求在飞', calls.length === 1 && calls[0].aborted === false)
  WeSource.abortAll()
  await tick()
  ok('abortAll 取消了在飞请求', calls[0].aborted === true)
  const r = await p
  ok('返回里标明 aborted（调用方据此不写界面）', r.aborted === true && r.ok === false, JSON.stringify(r))

  // 销毁后再起的请求不应受之前 abort 影响
  const p2 = WeSource.library(false)
  await tick()
  const c2 = calls[calls.length - 1]
  c2.resolve({ entries: [{ id: 'after' }], weFound: true })
  const r2 = await p2
  ok('abortAll 之后新请求正常', r2.ok === true && r2.entries[0].id === 'after')
}

console.log('\n— ④ 失败后重试：失败能结束，重试能成功 —')
{
  const { WeSource, calls } = makeWeSource()
  const p1 = WeSource.library(false)
  await tick()
  calls[0].reject(new Error('boom'))
  const r1 = await p1
  ok('失败返回 ok:false 且带 error（不是抛异常）', r1.ok === false && typeof r1.error === 'string', r1.error)
  ok('失败**不是** aborted（要能区分"失败"与"被取消"）', !r1.aborted)

  // 重试
  const p2 = WeSource.library(true)   // force
  await tick()
  const c2 = calls[calls.length - 1]
  ok('重试带上了 force=1', /\?force=1/.test(c2.url), c2.url)
  c2.resolve({ entries: [{ id: 'ok' }], weFound: true })
  const r2 = await p2
  ok('重试成功', r2.ok === true && r2.entries[0].id === 'ok')

  // HTTP 非 2xx 也要走失败分支
  const p3 = WeSource.library(false)
  await tick()
  calls[calls.length - 1].resolve({}, 500)
  const r3 = await p3
  ok('HTTP 500 也算失败且 error 含状态码', r3.ok === false && /500/.test(r3.error), r3.error)
}

console.log('\n— ⑤ 快速连续请求：最后一次赢 —')
{
  const { WeSource, calls } = makeWeSource()
  const ps = []
  for (let i = 0; i < 5; i++) { ps.push(WeSource.library(false)); await tick() }
  ok('发了 5 次', calls.length === 5, calls.length + ' 次')
  const abortedCount = calls.filter((c) => c.aborted).length
  ok('前 4 次都被取消，只有最后一次在飞', abortedCount === 4, '取消 ' + abortedCount + ' 个')

  // 乱序返回：先把中间那些"已取消"的 resolve 掉，再 resolve 最后一个
  calls[1].resolve({ entries: [{ id: 'stale' }], weFound: true })
  calls[3].resolve({ entries: [{ id: 'stale2' }], weFound: true })
  await tick()
  calls[4].resolve({ entries: [{ id: 'winner' }], weFound: true })
  const rs = await Promise.all(ps)
  const winners = rs.filter((r) => r.ok && r.entries && r.entries[0] && r.entries[0].id === 'winner')
  ok('只有最后一次产出 ok 结果', winners.length === 1, 'ok 的有 ' + winners.length + ' 个')
  const stales = rs.filter((r) => r.ok)
  ok('已取消的迟到结果全部标 aborted（不会写界面）', stales.length === 1, '成功的有 ' + stales.length + ' 个')
}

console.log('\n— ⑥ 冷启动 vs 缓存命中：force 参数与结果一致性 —')
{
  const { WeSource, calls } = makeWeSource()
  // 首次（不 force）
  const p1 = WeSource.library(false)
  await tick()
  ok('首次请求不带 force', !/\?force=1/.test(calls[0].url), calls[0].url)
  calls[0].resolve({ entries: [{ id: 'cached' }], weFound: true })
  const r1 = await p1

  // 第二次（force 重扫）
  const p2 = WeSource.library(true)
  await tick()
  ok('强制刷新带 force=1', /\?force=1/.test(calls[1].url), calls[1].url)
  calls[1].resolve({ entries: [{ id: 'cached' }], weFound: true })
  const r2 = await p2

  ok('两次结果一致（缓存命中不改变内容）',
    JSON.stringify(r1.entries) === JSON.stringify(r2.entries), JSON.stringify(r1.entries))
  ok('两次都标了 ok', r1.ok && r2.ok)
  ok('url 前缀正确（走 WE_PREFIX）', calls[0].url.startsWith('/dwl/library.json') || calls[0].url.startsWith('/bga/we/library.json'), calls[0].url)

  // status 的 force 同理
  const p3 = WeSource.status(true)
  await tick()
  const lastUrl = calls[calls.length - 1].url
  ok('status 的 force 也正确传递', /\?force=1/.test(lastUrl) && /status/.test(lastUrl), lastUrl)
  calls[calls.length - 1].resolve({ bridge: { running: true } })
  await p3
}

console.log('\n— 关键补充：调用方隔离（审核方复现指出的真缺陷）—')
{
  // 原缺陷：请求槽只按 kind 记（library/status 各一个），于是 library() 一进来就
  // abort('library') —— **任何调用方都会取消别的调用方**在飞的那次。真实后果：
  // 启动恢复正在取库清单时用户打开设置页，设置页那次 library() 把恢复请求取消掉
  // ⇒ **选中的 WE 背景恢复不出来，而且不报错**。
  // 修法：key = caller + ':' + kind，同调用方同 kind 才互相取消。
  const { WeSource, calls } = makeWeSource()

  // 启动恢复先发起
  const pRestore = WeSource.library(false, null, 'restore')
  await tick()
  ok('恢复请求已发出', calls.length === 1 && calls[0].aborted === false)

  // 设置页随后发起（用户打开设置页）—— 这**不能**取消恢复那条
  const pSection = WeSource.library(false, null, 'section')
  await tick()
  ok('设置页请求已发出', calls.length === 2)
  ok('★ 设置页发起**不会**取消启动恢复（核心断言）', calls[0].aborted === false,
    calls[0].aborted ? '被取消了 —— 缺陷未修' : '未被取消')

  // 恢复那条能正常拿到结果（= 背景能恢复出来）
  calls[0].resolve({ entries: [{ id: 'the-one-user-picked' }], weFound: true })
  const rRestore = await pRestore
  ok('★ 恢复请求拿到结果（背景能恢复）', rRestore.ok === true && rRestore.entries[0].id === 'the-one-user-picked',
    JSON.stringify(rRestore.entries && rRestore.entries[0]))

  calls[1].resolve({ entries: [{ id: 'section-list' }], weFound: true })
  const rSection = await pSection
  ok('设置页也拿到自己的结果', rSection.ok === true && rSection.entries[0].id === 'section-list')

  // 同调用方再发起 ⇒ 仍应取消自己的前一个
  const pSection2 = WeSource.library(false, null, 'section')
  await tick()
  ok('同调用方（section）再发起 ⇒ 取消自己前一个', calls[1].aborted === true)
  ok('但**不影响**恢复那条（早已完成）', calls[0].aborted === false)
  calls[calls.length - 1].resolve({ entries: [], weFound: true })
  await pSection2

  // abortAll(caller) 只取消该调用方
  const p3 = WeSource.library(false, null, 'restore')
  await tick()
  const p4 = WeSource.library(false, null, 'section')
  await tick()
  const idxR = calls.length - 2, idxS = calls.length - 1
  WeSource.abortAll('section')
  await tick()
  ok('abortAll("section") 只取消 section，不动 restore', calls[idxS].aborted === true && calls[idxR].aborted === false)
  // 防御：若上面断言失败（缺陷版），这里两条 promise 可能都已 settle，await 不会挂住；
  // 若仍 pending，用 Promise.allSettled 兜底，避免整个套件以一个"未 settle 的顶层 await"
  // 崩掉（那会让退出码变成 13 而不是明确的 1，掩盖真正的断言失败）。
  calls[idxR].resolve({ entries: [], weFound: true })
  calls[idxS].resolve({ entries: [], weFound: true })
  await Promise.allSettled([p3, p4])
}

console.log('\n— 补充：返回值形状稳定（调用方依赖这些字段）—')
{
  const { WeSource, calls } = makeWeSource()
  const p = WeSource.library(false)
  await tick()
  calls[0].resolve({ entries: undefined, weFound: undefined })
  const r = await p
  ok('entries 缺失时兜成空数组（不返回 undefined）', Array.isArray(r.entries), JSON.stringify(r.entries))
  ok('weFound 缺失时兜成 false', r.weFound === false)
}

console.log('\n— 关键补充：abort 与 resolve 的时序竞态（then 分支的 aborted 保护）—')
{
  // 为什么单独测这个：真实浏览器里 abort() 与"响应已到达"可以**几乎同时**发生 ——
  // 请求已拿到响应、promise 即将 resolve，此时调用方 abort。这条路径走的是 **then 分支**，
  // 不是 catch。若只在 catch 里判 aborted，这里就会漏掉，表现为"已取消的请求仍把结果写进界面"。
  //
  // 这个场景是**做变异测试才补的**：我把源码里 then 分支的 aborted 保护删掉后，
  // 测试**仍然通过**（因为假 fetch 在 abort 时直接 reject，只走到 catch 分支）。
  // 说明原测试没覆盖这条路径 ⇒ 补上，并确认它对变异敏感。
  const { WeSource, calls } = makeWeSource()
  const p = WeSource.library(false)
  await tick()
  const call = calls[0]
  // 先 resolve（响应到达），再 abort —— 两步都在 promise 链推进之前
  call.resolve({ entries: [{ id: 'late' }], weFound: true })
  WeSource.abortAll()
  const r = await p
  ok('响应已到达但随之被 abort ⇒ 仍判 aborted、不产出 entries',
    r.aborted === true && r.ok === false, JSON.stringify(r))
}

console.log('\n— 关键补充：先 abort 后 resolve（catch 分支保护）—')
{
  const { WeSource, calls } = makeWeSource()
  const p = WeSource.library(false)
  await tick()
  WeSource.abortAll()
  // abort 已发生，响应此时才到达（迟到的"成功"）
  calls[0].resolve({ entries: [{ id: 'verylate' }], weFound: true })
  const r = await p
  ok('先 abort 后迟到的成功响应 ⇒ 仍判 aborted',
    r.aborted === true && r.ok === false, JSON.stringify(r))
}

console.log('\nWeSource 异步语义：' + pass + ' 通过 / ' + fail + ' 失败')
console.log('\n注：场景①③⑤ 里"被取消的请求即使迟到 resolve 也不产出结果"是核心 ——')
console.log('    这正是原来两套簿记（WeSection 的 ref + weRestore 的裸 fetch）里容易漏掉的那部分。')
process.exit(fail === 0 ? 0 : 1)