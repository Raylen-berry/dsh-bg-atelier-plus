// tools/verify-host-settings-io.mjs —— 宿主设置读写的**接口语义**离线验收
//
// 为什么有这一条（审核方第十五轮点名 index.js:318）：
//   原来 `readSettings()` 是 `catch { return {} }` ⇒ **读取失败 / 首次安装 / 合法空设置
//   三者不可区分**，验收工具只能在脚本层加 `isValidSettings` 去猜"这个 {} 是什么意思"。
//   写入则是直接 `fs.writeFile` 覆盖 ⇒ 写到一半进程死掉就把用户设置截断成损坏文件。
//   这两件都是**接口语义缺失**，在接口层修掉，脚本层的猜测才有资格退场。
//
// 做法沿用本仓库既有的测试缝：**从 index.js 源码里切出函数**（不复制实现），
// 在临时目录上跑真实文件系统。测的是真代码、真 IO。
//
// 用法：node tools/verify-host-settings-io.mjs
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')

/** 从源码里按签名切出函数体（与 verify-oracle-flow.mjs 同口径）。 */
function sliceFn(sig) {
  const begin = SRC.indexOf(sig)
  if (begin < 0) throw new Error('切不到：' + sig)
  let depth = 0, i = SRC.indexOf('{', begin)
  const start = i
  for (; i < SRC.length; i++) {
    const c = SRC[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(begin, i + 1)
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// 沙箱：只给这两个函数 + fs + process（它们依赖就这么点）
const fsMod = await import('node:fs')
// ⚠️ 切出来的函数用的是 `await fs.readFile(...)` 这种 **promises** 用法，
//    所以沙箱里的 `fs` 必须是 fs.promises（传整个模块会得到回调式 API ⇒ ERR_INVALID_ARG_TYPE）。
/**
 * 写入侧沙箱：必须把 `writeSettingsAt` **以及它的依赖**一起切进来。
 * ⚠️ 踩过：加"同目标串行 + 独占临时名"之后，`writeSettingsAt` 依赖模块级的
 * `writeChains`/`writeSeq` 与 `writeSettingsOnce` —— 只切它一个 ⇒ 沙箱里 ReferenceError。
 * 切片名单必须跟着实现走（和 verify-oracle-flow 那次同一类问题）。
 */
function makeWriter() {
  const code = `
let writeSeq = 0
const writeChains = new Map()
${sliceFn('async function writeSettingsOnce(')}
${sliceFn('async function writeSettingsAt(')}
return { writeSettingsAt };
`
  return (fsImpl) => new Function('fs', 'process', code)(fsImpl, process)
}

const { readSettingsResultAt, writeSettingsAt } = (() => {
  const code = `
${sliceFn('function isSettingsObject(')}
${sliceFn('async function readSettingsResultAt(')}
return { readSettingsResultAt };
`
  const r = new Function('fs', 'process', code)(fsMod.promises, process)
  return { readSettingsResultAt: r.readSettingsResultAt, writeSettingsAt: makeWriter()(fsMod.promises).writeSettingsAt }
})()

const fs = fsMod.promises

const root = mkdtempSync(path.join(tmpdir(), 'bga-io-'))
const file = path.join(root, 'settings.json')
const dir = root
const cleanup = () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } }
process.on('exit', cleanup)

console.log('=== 宿主设置读写：接口语义 ===\n— ① 读取的四种情况必须可区分 —')

// ①a 首次安装（文件不存在）
{
  const r = await readSettingsResultAt(file)
  ok('文件不存在 ⇒ status=missing（这是唯一一种"空设置"正常的情况）', r.status === 'missing', JSON.stringify(r))
  ok('missing 时 value 是空对象（调用方可安全当默认值用）',
    r.value && typeof r.value === 'object' && Object.keys(r.value).length === 0)
}

// ①b 合法内容
{
  await writeSettingsAt(file, dir, { autoOn: true, accent: '#e88ca0' })
  const r = await readSettingsResultAt(file)
  ok('合法对象 ⇒ status=ok 且拿得到值', r.status === 'ok' && r.value.autoOn === true, JSON.stringify(r.status))
}

// ①c 损坏（半截 JSON —— 正是"写一半进程被杀"会留下的东西）
{
  writeFileSync(file, '{"autoOn": true, "accent": "#e8', 'utf8')
  const r = await readSettingsResultAt(file)
  ok('★ 半截 JSON ⇒ status=corrupt（**不再伪装成空设置**）', r.status === 'corrupt', JSON.stringify(r.status))
  ok('corrupt 时 value=null（不给调用方一个假对象去覆盖写）', r.value === null)
  ok('corrupt 带可定位的 detail', typeof r.detail === 'string' && r.detail.length > 0, String(r.detail).slice(0, 60))
}

// ①d 合法 JSON 但不是对象
for (const [label, text] of [['数组', '[1,2,3]'], ['数字', '3'], ['null', 'null'], ['字符串', '"x"']]) {
  writeFileSync(file, text, 'utf8')
  const r = await readSettingsResultAt(file)
  ok('★ ' + label + ' ⇒ status=corrupt（不是"合法空设置"）', r.status === 'corrupt', JSON.stringify(r.status))
}

// ①e io-error：把"文件"指向一个目录 ⇒ 读会失败但不是 ENOENT
{
  const asDir = path.join(root, 'asdir.json')
  mkdirSync(asDir)
  const r = await readSettingsResultAt(asDir)
  ok('★ 读不了（指向目录）⇒ status=io-error，且**不与 missing/corrupt 混淆**',
    r.status === 'io-error', JSON.stringify(r.status))
}

console.log('\n— ② 写入必须原子：不留半截、不留临时文件 —')
{
  await writeSettingsAt(file, dir, { a: 1 })
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
  ok('★ 写完后目录里没有 .tmp 残留', leftovers.length === 0, leftovers.join(',') || '无')
  const r = await readSettingsResultAt(file)
  ok('写完立刻读 ⇒ ok 且内容是刚写的那份', r.status === 'ok' && r.value.a === 1)
}

console.log('\n— ③ 写入失败不许破坏已有内容 —')
{
  await writeSettingsAt(file, dir, { keep: 'me' })
  const before = readFileSync(file, 'utf8')
  let threw = false
  try {
    // 目标路径是个**目录** ⇒ rename 必然失败
    const asDir = path.join(root, 'target-is-dir')
    mkdirSync(asDir)
    await writeSettingsAt(asDir, dir, { nope: 1 })
  } catch { threw = true }
  ok('★ 写入目标不可写 ⇒ 抛错（不静默当成功）', threw)
  ok('★ 原文件内容**一位没变**（失败不破坏已有设置）', readFileSync(file, 'utf8') === before)
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
  ok('★ 失败后临时文件也被清掉', leftovers.length === 0, leftovers.join(',') || '无')
}

console.log('\n— ④ 连续写：任何时刻读到的都是"完整的某一版" —')
{
  const seen = new Set()
  for (let i = 0; i < 30; i++) {
    await writeSettingsAt(file, dir, { rev: i, pad: 'x'.repeat(2000) })
    const r = await readSettingsResultAt(file)
    if (r.status !== 'ok') { ok('★ 第 ' + i + ' 次写后读到损坏', false, JSON.stringify(r.status)); break }
    seen.add(r.value.rev)
  }
  ok('★ 30 次连写，每次读到的都是合法对象（没有一次读到半截）', seen.size === 30, '见到 ' + seen.size + ' 个版本')
}

console.log('\n— ⑤ 覆盖写必须 fail closed（纯函数，服务端与客户端共用同一判据） —')
{
  const refuse = (() => {
    const code = `
${sliceFn('function refuseOverwriteReason(')}
return refuseOverwriteReason;
`
    return new Function(code)()
  })()
  ok('状态 ok ⇒ 允许写', refuse('ok', undefined) === null)
  ok('状态 missing（首次安装）⇒ 允许写', refuse('missing', undefined) === null)
  ok('★ 状态 corrupt ⇒ **拒绝写**（默认不覆盖坏文件）', refuse('corrupt', undefined) === 'corrupt')
  ok('★ 状态 io-error ⇒ **拒绝写**', refuse('io-error', undefined) === 'io-error')
  ok('★ 显式带上 allow-overwrite=1 才放行（给"用户明确要重建"留出口）',
    refuse('corrupt', '1') === null && refuse('io-error', '1') === null)
  ok('★ 任何其它值（含 "true"/空串）都不等于放行 —— 只认精确的 "1"',
    refuse('corrupt', 'true') === 'corrupt' && refuse('corrupt', '') === 'corrupt'
    && refuse('corrupt', '01') === 'corrupt')
}

console.log('\n— ⑥ 客户端在"读到坏文件"时必须不开写闸 —')
{
  // 从 client.js 切出 load 的两段判定太脆（依赖 fetch/React）⇒ 这里只钉**判据本身**：
  // 客户端与服务端必须用同一组"危险状态"，漏一个就会留下"坏文件被默认值覆盖"的路径。
  const clientSrc = readFileSync(path.join(HERE, '..', 'client.js'), 'utf8')
  ok('★ client.js 里对 corrupt/io-error 有明确处理（不是只处理 ok）',
    /settingsReadStatus\s*===\s*'corrupt'/.test(clientSrc) && /settingsReadStatus\s*===\s*'io-error'/.test(clientSrc))
  ok('★ client.js 读到危险状态时**不开写闸**（stateLoaded 不被置真）',
    /res\.status === 'corrupt' \|\| res\.status === 'io-error'\) \{[\s\S]{0,240}?STORE\.saveStatus = 'protected'[\s\S]{0,120}?return/.test(clientSrc))
  ok('★ save() 里有第二道显式闸（不依赖 stateLoaded 的开闸条件）',
    /settingsReadStatus === 'corrupt' \|\| settingsReadStatus === 'io-error'\) return/.test(clientSrc))
  const hostSrc = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
  ok('★ index.js 用响应头把读取状态告诉客户端',
    /x-bga-settings-status/.test(hostSrc))
  ok('★ index.js 的 PUT 在危险状态下返回 409（不是 200 假装成功）',
    /refuseOverwriteReason\(cur\.status[\s\S]{0,240}?send\(409/.test(hostSrc))
}

console.log('\n— ⑦ 写合法值：读写同一判据（审核方第十六轮反例 2） —')
{
  const isObj = (() => {
    const code = `
${sliceFn('function isSettingsObject(')}
return isSettingsObject;
`
    return new Function(code)()
  })()
  ok('对象 ⇒ 合法', isObj({ a: 1 }) === true && isObj({}) === true)
  ok('★ 数组 ⇒ 不合法（原来 PUT 放行，读侧却判 corrupt ⇒ 接口自己写出自己读不了的文件）',
    isObj([1, 2]) === false)
  ok('★ 标量/null ⇒ 不合法', isObj(3) === false && isObj(null) === false
    && isObj(undefined) === false && isObj('x') === false)
  const src = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8')
  ok('★ 读侧与写侧**都**调这个判据（不是各写各的）',
    (src.match(/isSettingsObject\(parsed\)/g) || []).length >= 2)
}

console.log('\n— ⑧ 并发写：独占临时名 + 同目标串行（审核方第十六轮反例 1/5） —')
{
  /** 切出真实的"一次性写 + 串行提交"两个函数（连带它们的模块级状态）。 */
  const makeWriter = () => {
    const code = `
let writeSeq = 0
const writeChains = new Map()
${sliceFn('async function writeSettingsOnce(')}
${sliceFn('async function writeSettingsAt(')}
return { writeSettingsAt };
`
    return (fsImpl) => new Function('fs', 'process', code)(fsImpl, process)
  }
  const fsP = fsMod.promises

  // ⑧a 并发多次写：全部成功、每次读到的都是"完整的某一版"、最终是某一版、无 .tmp 残留
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'bga-cc-'))
    const target = path.join(dir, 'settings.json')
    const { writeSettingsAt: writer } = makeWriter()({ ...fsP })
    const revisions = []
    const tasks = []
    for (let i = 0; i < 40; i++) {
      revisions.push(i)
      tasks.push(writer(target, dir, { rev: i, pad: 'y'.repeat(1024) }))
    }
    // 边写边读：任何一次成功读到的内容都必须是完整 JSON（不能是半截）
    let reads = 0, bad = 0
    const reader = (async () => {
      for (let i = 0; i < 120; i++) {
        try {
          const t = readFileSync(target, 'utf8')
          JSON.parse(t); reads++
        } catch (e) { if (e.code !== 'ENOENT') bad++ }
        await new Promise((r) => setImmediate(r))
      }
    })()
    const results = await Promise.allSettled(tasks)
    await reader
    const okAll = results.every((r) => r.status === 'fulfilled')
    const final = JSON.parse(readFileSync(target, 'utf8'))
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    ok('★ 40 个并发写**全部成功**（没有 ENOENT/错乱）', okAll,
      results.filter((r) => r.status !== 'fulfilled').slice(0, 3).map((r) => String(r.reason && r.reason.code)).join(',') || '全成功')
    ok('★ 并发期间每次读到的都是完整 JSON（读到 ' + reads + ' 次，坏 ' + bad + ' 次）', bad === 0, 'bad=' + bad)
    ok('★ 最终内容是**某一版完整的**（rev=' + final.rev + '）', revisions.includes(final.rev) && final.pad.length === 1024)
    ok('★ 没有 .tmp 残留', leftovers.length === 0, leftovers.join(',') || '无')
    rmSync(dir, { recursive: true, force: true })
  }

  // ⑧b 每次写用**独占**临时名（旧实现只带 PID ⇒ 同进程并发共用同一个临时文件）
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'bga-tmp-'))
    const target = path.join(dir, 'settings.json')
    const seen = []
    const { writeSettingsAt: writer } = makeWriter()({
      mkdir: (...a) => fsP.mkdir(...a),
      rename: (...a) => fsP.rename(...a),
      unlink: (...a) => fsP.unlink(...a),
      writeFile: async (file, bytes, enc) => { seen.push(file); return fsP.writeFile(file, bytes, enc) },
    })
    await writer(target, dir, { rev: 1 })
    await writer(target, dir, { rev: 2 })
    ok('★ 两次写的临时文件名**不同**（独占）', seen.length === 2 && seen[0] !== seen[1], seen.map((s) => s.split('\\').pop()).join(' | '))
    rmSync(dir, { recursive: true, force: true })
  }

  // ⑧c 同一目标的提交**顺序 = 调用顺序**（串行化；旧实现两次 rename 交错）
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'bga-seq-'))
    const target = path.join(dir, 'settings.json')
    const order = []
    const revOfTmp = new Map()   // 临时名里有随机段 ⇒ 不能靠解析文件名，改为写入时登记
    const { writeSettingsAt: writer } = makeWriter()({
      mkdir: (...a) => fsP.mkdir(...a),
      unlink: (...a) => fsP.unlink(...a),
      writeFile: async (file, bytes, enc) => {
        const rev = JSON.parse(bytes).rev
        revOfTmp.set(file, rev)
        await new Promise((r) => setTimeout(r, rev === 1 ? 60 : 5))   // 故意让先发起的那个更慢
        await fsP.writeFile(file, bytes, enc)
        order.push('write' + rev)
      },
      rename: async (a, b) => { order.push('rename' + revOfTmp.get(a)); return fsP.rename(a, b) },
    })
    const p1 = writer(target, dir, { rev: 1 })
    const p2 = writer(target, dir, { rev: 2 })
    await Promise.all([p1, p2])
    ok('★ 先发起的先提交（晚发起的写不会插到前面）',
      order.join(',').startsWith('write1,rename1,write2,rename2'), order.join(','))
    ok('★ 最终内容是被串行执行的第二版', JSON.parse(readFileSync(target, 'utf8')).rev === 2)
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n宿主设置 IO：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
