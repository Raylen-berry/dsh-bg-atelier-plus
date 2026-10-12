// tools/verify-iso-hardening.mjs —— 第十七轮三项修复的**真实函数坏例**回归（离线，无浏览器）
//
// 为什么不用"源码里有没有某个子串"那种门禁（审核方第十七轮 §5 明确指出那只能作辅助）：
// 这里**把真实函数从源码里切出来执行**，用坏例与好例分别驱动它，断言它的**判定结果**。
//
// 覆盖：
//   ① insideTree / isolationFacts —— 相邻目录（poc5-other）、外部图库、生产图库、链接指向树外
//   ② 总控中止的记账 —— end-to-end 调真 CLI（用一个必然失败的根），断言**非零退出 + 未测被列出**
//   ③ pinAnimations —— 部分失败 / 只有宿主动画 / 插件动画已暂停，三种诊断值的判定
//
// 用法：node tools/verify-iso-hardening.mjs    （exit 0 = 三项修复都成立）
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/** 从源码里切出顶层函数（`\n}` 起行作为结束）——本仓库的通例（不 import 主程序，避免跑它的 CLI）。 */
function sliceFn(file, header) {
  const s = readFileSync(path.join(REPO, file), 'utf8')
  const i = s.indexOf(header)
  if (i < 0) throw new Error('切不到函数：' + header + ' @' + file)
  const j = s.indexOf('\n}', i)
  if (j < 0) throw new Error('切不到函数结尾：' + header)
  return s.slice(i, j + 2)
}

// ─────────────────────────────────────────────────── ① 路径包含判定
console.log('\n— ① insideTree / isolationFacts：路径必须**确实**在隔离树内 —')
{
  const root = mkdtempSync(path.join(tmpdir(), 'iso-hard-'))
  const tree = path.join(root, 'poc5')
  const sibling = path.join(root, 'poc5-other')
  mkdirSync(path.join(tree, 'home', 'dsh-bg-atelier', 'wallpapers'), { recursive: true })
  mkdirSync(path.join(tree, 'home', 'dsh-bg-atelier-plus'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(path.join(tree, 'home', 'dsh-bg-atelier-plus', 'settings.json'), '{}')
  // 链接指向**树外**：真实环境里图库就是 Junction，必须解析后再判
  const outside = path.join(root, 'outside-gallery')
  mkdirSync(outside, { recursive: true })
  let linkMade = true
  try { symlinkSync(outside, path.join(tree, 'link-out'), 'junction') } catch { linkMade = false }

  const src = sliceFn('tools/iso-instance.mjs', 'function insideTree') + '\n' +
    sliceFn('tools/iso-instance.mjs', 'function isolationFacts')
  const PROD_HOME = path.join(root, 'PROD')
  const fn = new Function('path', 'existsSync', 'realpathSync', 'ROOT', 'PROD_HOME',
    src + '\nreturn { insideTree, isolationFacts }')
  const { insideTree, isolationFacts } = fn(path, existsSync, realpathSync, tree, PROD_HOME)

  ok('★ 树内路径判 true', insideTree(path.join(tree, 'home', 'dsh-bg-atelier'), tree) === true)
  ok('★ 根自身判 true', insideTree(tree, tree) === true)
  ok('★ **相邻目录** poc5-other 判 false（裸前缀写法会判 true —— 审核方反例）',
    insideTree(sibling, tree) === false, sibling)
  ok('★ 不存在的路径判 false（证明不了就不算成立）',
    insideTree(path.join(tree, 'nope', 'x'), tree) === false)
  if (linkMade) {
    ok('★ 链接指向树外 ⇒ 解析后判 false', insideTree(path.join(tree, 'link-out'), tree) === false)
  } else {
    console.log('  ⚠️ 跳过链接用例（本机不能建 junction）')
  }

  const f1 = isolationFacts({ dir: path.join(tree, 'home', 'dsh-bg-atelier', 'wallpapers'), writableDir: path.join(tree, 'home', 'dsh-bg-atelier', 'wallpapers') })
  ok('★ 两个目录都在树内 + 设置文件在树内 ⇒ 全部成立',
    f1.galleryDir && f1.galleryWritableDir && f1.settingsFileInTree && !f1.galleryIsProd, f1.settingsFiles)
  const f2 = isolationFacts({ dir: 'C:\\production-gallery', writableDir: 'C:\\production-gallery' })
  ok('★ **外部图库** ⇒ galleryWritableDir 判 false（审核方反例 A）', f2.galleryWritableDir === false)
  const f3 = isolationFacts({ dir: path.join(PROD_HOME, 'dsh-bg-atelier', 'wallpapers'), writableDir: path.join(PROD_HOME, 'dsh-bg-atelier', 'wallpapers') })
  ok('★ **生产图库** ⇒ galleryIsProd 判 true（会被"图库不是生产图库"那条挡下）', f3.galleryIsProd === true)
  const f4 = isolationFacts(null)
  ok('★ 拿不到插件自报目录 ⇒ 一律 false（不猜）',
    f4.galleryDir === false && f4.galleryWritableDir === false)
  rmSync(root, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────── ② 总控中止的记账（真 CLI）
console.log('\n— ② 总控中止：异常必须计入失败、未测必须列出、退出码非零 —')
{
  // 必然失败的根：路径上放一个**文件**，mkdir/复制会 ENOTDIR ⇒ 在"准备"阶段就抛
  const base = path.join('D:\\', 'DeepSeek', 'dsh-iso', 'badroot-file')
  const root = path.join(base, 'sub')
  const r = spawnSync(process.execPath, [
    path.join(HERE, 'iso-instance.mjs'), 'run',
    '--name', 'hardening-fail', '--root', root,
    '--port', '19999', '--cdp', '19998', '--baseline', 'iso-hardfail', '--steps', 'selftest,compare',
  ], { cwd: REPO, encoding: 'utf8', timeout: 120000 })
  const out = String(r.stdout || '') + String(r.stderr || '')
  ok('★ 中止时**非零退出**（不再"中止仍成功"）', r.status !== 0, 'exit=' + r.status)
  ok('★ 打印了"中止"', /中止/.test(out))
  ok('★ **未测**被逐条列出（声明的必测项没跑到）', /未测/.test(out), (out.match(/未测[^\n]*/g) || []).slice(0, 2).join(' / ').slice(0, 120))
  ok('★ 汇总里三态分开（通过 / 失败 / 未测）', /通过 \/ \d+ 失败 \/ \d+ 未测/.test(out),
    (out.match(/隔离验收汇总：[^\n]*/) || [''])[0].trim())
}

// ─────────────────────────────────────────────────── ③ 固定相位的判定
console.log('\n— ③ pinAnimations：部分失败 / 宿主动画充数 / 插件动画已暂停 —')
{
  const src = sliceFn('tools/visual-baseline.mjs', 'async function pinAnimations')
  const mk = (diag) => new Function('readState', src + '\nreturn pinAnimations')(async () => JSON.stringify(diag))
  const cases = [
    ['★ 部分失败（pinned=1, fail=1）⇒ 判失败（审核方反例）',
      { total: 2, pinned: 1, fail: 1, pluginTotal: 1, pluginPaused: 1 }, false],
    ['★ 只有一个动画且它失败了（pinned=0, fail=1）⇒ 判失败',
      { total: 1, pinned: 0, fail: 1, pluginTotal: 0, pluginPaused: 0 }, false],
    ['★ 全是**宿主动画**（pluginTotal=0）⇒ 判失败（不能拿宿主动画充数）',
      { total: 3, pinned: 3, fail: 0, pluginTotal: 0, pluginPaused: 0 }, false],
    ['★ 插件动画没全部暂停（1/2）⇒ 判失败',
      { total: 3, pinned: 3, fail: 0, pluginTotal: 2, pluginPaused: 1 }, false],
    ['★ 一个动画都没有 ⇒ 判失败（动效层没挂载）',
      { total: 0, pinned: 0, fail: 0, pluginTotal: 0, pluginPaused: 0 }, false],
    ['★ 正常例：插件动画全部存在且已暂停 ⇒ 判成功',
      { total: 5, pinned: 5, fail: 0, pluginTotal: 3, pluginPaused: 3 }, true],
  ]
  for (const [name, diag, want] of cases) {
    const got = await mk(diag)(1200, null)
    ok(name, got === want, 'diagnostic=' + JSON.stringify(diag) + ' ⇒ ' + got)
  }
}

console.log('\n三项修复回归：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
