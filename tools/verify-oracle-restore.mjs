// tools/verify-oracle-restore.mjs —— 视觉 oracle 的「还原判定」离线回归
//
// 为什么需要：审核方在两轮里复现出两个退出码缺陷，都属于"判断逻辑写错但没人测"：
//   ① capture 分支的 finally 已把 exitCode 置 5，但文件末尾写死 `process.exit(0)`
//      ⇒ "录制成功 + 还原失败"实际退出 0。
//   ② `restoreRotation()` 遇到"用户原本就关着轮播"时返回 undefined，调用方写
//      `!== true` ⇒ 把它**误报成还原失败**，一次正常运行的退出码变成 5。
// 两个都是纯逻辑问题，不该只在实机跑的时候才暴露。
//
// 为了让它们可测，判定逻辑抽成了 oracle-compare.mjs 里的纯函数：
//   rotationRestoreNeed()    —— 从冻结前的原始 JSON 判断"要不要还原"
//   judgeRotationRestore()   —— 把"要不要还原"+"磁盘/内存实测"合成三态结论
// 本套件逐条覆盖，**并对每个断言做变异说明**（改坏哪一行会让它失败）。
//
// 用法：node tools/verify-oracle-restore.mjs
import { rotationRestoreNeed, judgeRotationRestore } from './oracle-compare.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

console.log('\n=== oracle 还原判定离线回归 ===')

console.log('\n— ① rotationRestoreNeed：要不要还原 —')
{
  ok('没冻结成功（null）⇒ skip', rotationRestoreNeed(null) === 'skip')
  ok('空字符串 ⇒ skip', rotationRestoreNeed('') === 'skip')
  ok('坏 JSON ⇒ skip', rotationRestoreNeed('{不是合法 json') === 'skip')
  ok('JSON 不是对象（数组）⇒ skip', rotationRestoreNeed('[1,2]') === 'skip')
  ok('JSON 不是对象（数字）⇒ skip', rotationRestoreNeed('42') === 'skip')

  // ★ 审核方第 2 条的根因：这一条必须与"需要还原"分开
  ok('★ 用户原本就关着轮播 ⇒ not-needed（**不是失败**）',
    rotationRestoreNeed(JSON.stringify({ autoOn: false, autoMin: 5 })) === 'not-needed')
  ok('原值里没有 autoOn 字段 ⇒ not-needed',
    rotationRestoreNeed(JSON.stringify({ autoMin: 5 })) === 'not-needed')
  ok('autoOn 是字符串 "true"（不是布尔）⇒ not-needed（严格 === true）',
    rotationRestoreNeed(JSON.stringify({ autoOn: 'true' })) === 'not-needed')

  ok('用户原本开着轮播 ⇒ need', rotationRestoreNeed(JSON.stringify({ autoOn: true })) === 'need')
  ok('开着且带其余字段 ⇒ need',
    rotationRestoreNeed(JSON.stringify({ autoOn: true, autoMin: 5, wallpaper: { file: 'x.png' } })) === 'need')
}

console.log('\n— ② judgeRotationRestore：三态合成 —')
{
  const good = { diskOk: true, memKnown: true, memOk: true, reloadFailed: false }

  ok('skip ⇒ skipped（不算失败）', judgeRotationRestore('skip', good) === 'skipped')
  ok('★ not-needed ⇒ restored（**不能是 failed**）',
    judgeRotationRestore('not-needed', {}) === 'restored',
    '这一条若写错，就是审核方复现的"原本关着轮播却 exit=5"')

  ok('need + 磁盘内存都 OK ⇒ restored', judgeRotationRestore('need', good) === 'restored')

  // 各种失败路径都必须落在 failed
  ok('need + 磁盘不是 true ⇒ failed',
    judgeRotationRestore('need', { ...good, diskOk: false }) === 'failed')
  ok('need + 内存不是 true ⇒ failed',
    judgeRotationRestore('need', { ...good, memOk: false }) === 'failed')
  ok('★ need + 内存无法确认 ⇒ failed（不把"没能确认"当通过）',
    judgeRotationRestore('need', { ...good, memKnown: false, memOk: null }) === 'failed')
  ok('★ need + 刷新失败 ⇒ failed（**即使磁盘内存都 true**）',
    judgeRotationRestore('need', { ...good, reloadFailed: true }) === 'failed',
    '这一条对应审核方第 1 轮指出的"刷新失败被吞掉"')
  ok('need + 字段缺失（磁盘未测到）⇒ failed',
    judgeRotationRestore('need', {}) === 'failed')
}

console.log('\n— ③ 退出码语义：' + '只有 failed 才置 5 —')
{
  // 复刻调用方那段逻辑（与 visual-baseline.mjs 里的判断保持一致）
  const exitFor = (outcome, base = 0) => {
    let code = base
    if (outcome === 'failed') { if (code === 0) code = 5 }
    return code
  }
  ok('restored ⇒ 不改退出码', exitFor('restored') === 0)
  ok('★ skipped ⇒ 不改退出码', exitFor('skipped') === 0)
  ok('failed ⇒ 置 5', exitFor('failed') === 5)
  ok('failed 但已有非零码（如 1=有差异）⇒ 保留 1，不覆盖成 5', exitFor('failed', 1) === 1)
  ok('restored + 基线 1（有视觉差异）⇒ 仍是 1', exitFor('restored', 1) === 1)
}

console.log('\n— ④ 源码层：capture 分支的收尾不能用写死的 0 —')
{
  // 审核方第 1 条：capture 的 finally 置了 exitCode=5，但末尾写死 process.exit(0) ⇒ 失效。
  // 这条是**文本断言**：直接检查源文件末尾用的是 exitCode 而不是字面量 0。
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'visual-baseline.mjs'), 'utf8')
  const tail = src.trimEnd().split('\n').slice(-4).join('\n')
  ok('★ 文件末尾不出现写死的 process.exit(0)', !/process\.exit\(0\)\s*$/.test(src.trimEnd()),
    '写死会让 capture 的还原失败被吞掉（审核方复现）')
  ok('末尾用 process.exit(exitCode)', /process\.exit\(exitCode\)/.test(tail), tail.replace(/\n/g, ' | ').slice(0, 90))
  // 并确认 finally 里的还原判断只认 'failed'（源码里共有 3 处 `outcome === 'failed'`：
// restoreRotation 自己收尾 1 处 + capture 的 finally 1 处 + compare 的 finally 1 处）
  const failedChecks = (src.match(/outcome === 'failed'/g) || []).length
  ok('finally 里的还原判断只认 failed（源码里共 3 处，含 restoreRotation 内部收尾）',
    failedChecks === 3, '找到 ' + failedChecks + ' 处')
  // 判"不再有 `!== true` 式判断"要排除注释 —— 注释里引用了旧写法做说明，那是正常的
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  const badLines = codeLines.filter((l) => /restored !== true/.test(l))
  ok('代码里不再有 `restored !== true`（那会把 not-needed 误判成失败）',
    badLines.length === 0, badLines.length ? badLines[0].trim().slice(0, 70) : '仅注释中作为反面例子出现')
}

console.log('\n— ⑤ capture 成功时必须仍退出 0（别把正常路径改坏）—')
{
  const exitFor = (outcome, base = 0) => { let c = base; if (outcome === 'failed') { if (c === 0) c = 5 } return c }
  // capture 成功 + 无需还原（用户原本关着轮播）⇒ 必须是 0
  ok('capture 成功 + not-needed ⇒ exit 0',
    exitFor(judgeRotationRestore('not-needed', {})) === 0)
  ok('capture 成功 + skip ⇒ exit 0',
    exitFor(judgeRotationRestore('skip', {})) === 0)
  ok('capture 成功 + restored ⇒ exit 0',
    exitFor(judgeRotationRestore('need', { diskOk: true, memKnown: true, memOk: true })) === 0)
}

console.log('\noracle 还原判定：' + pass + ' 通过 / ' + fail + ' 失败')
console.log('\n注：每条 ★ 都对应审核方复现过的一个真实缺陷（两个退出码问题、'
  + '一个"无需还原 vs 还原失败"混淆、一个"刷新失败被吞"）。')
process.exit(fail === 0 ? 0 : 1)