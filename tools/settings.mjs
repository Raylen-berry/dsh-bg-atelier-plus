// 底图工坊 · 设置导出 / 导入（换机器用；开发与运维脚本，不进 npm 包）
//
// 为什么需要它：本插件的设置存在 $DSH_HOME/dsh-bg-atelier/settings.json，**不随仓库走**，
// 所以换一台机器（或换用户）之后，底图 / 特效 / 配色 / 卡面不透明度与模糊 / 卡面阴影开关
// 全都会回到默认值 —— 用户 2026-09-12 反馈的"回家发现可用性很差、必须手动操作"里，
// 这一半是"配置不在仓库里"。这个脚本把那份状态导出成一个可携带的 JSON，并在新机器上一键写回。
//
// 用法：
//   node tools/settings.mjs export [--out <文件>]     # 默认 ./dsh-bg-atelier-settings-<日期>.json
//   node tools/settings.mjs import <文件> [--yes]     # 覆盖前自动备份为 settings.json.bak-<时间戳>
//   node tools/settings.mjs show                      # 打印当前生效的设置与来源路径
//
// 设计取舍：
//  · **导入只做表层校验**（类型/枚举/区间/结构），并且**永远先备份**。本插件的 host 半是
//    "原样存取"、不做 sanitize（见 index.js 的 PUT 路由），所以区间钳制必须在这里做严一点。
//  · 导入后**必须重启 DSH Desktop** 才生效（client 半在服务启动时 compose）。
//  · 底图图片本身不在设置里，只有它的路径/URL；导入会检查该图在本机是否存在，缺了就提示
//    去取图（仓库精简克隆时 `git sparse-checkout add wallpapers` 一条命令）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'dsh-bg-atelier'
const FORMAT = 'dsh-plugin-settings/1'
const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const dir = () => path.join(dshHome(), PLUGIN)
const settingsFile = () => path.join(dir(), 'settings.json')

// 与插件源码同口径的默认值 / 枚举 / 区间（改插件时这里要跟着改，注意别漂）
const DEFAULTS = { wallpaper: null, effect: 'firefly', accent: '#e88ca0', deep: '#241318', veil: 0, glass: 0.8, cardA: 0, cardBlur: 10, focus: '50% 50%', zoom: 1, preset: 'sakura', cardShadow: true, autoOn: false, autoMin: 30, fadeOn: true, fadeDelayMs: 0, fadeMs: 900, playlists: [], playbackSource: 'all', playbackMode: 'random', imageFraming: {}, recent: [], weId: null, weMode: 'live', weQuality: 'balanced' }
const EFFECT_IDS = ['firefly', 'bubble', 'petal', 'rain', 'off']
const PRESETS = ['sakura', 'teal', 'amber', 'violet', 'mint', 'crimson', 'mist', 'lavender', 'peach', 'mono', 'custom']
const RANGE = { veil: [0, 0.85], glass: [0, 1], cardA: [0, 1], cardBlur: [0, 24], zoom: [1, 2.2], autoMin: [1, 120], fadeDelayMs: [0, 1000], fadeMs: [100, 5000] }
// 间隔只有这 14 档（与 client.js 的 AUTO_STOPS 同口径）：导入 47 也吸附到 45，
// 否则设置文件写着 47、UI 显示 45，两边对不上。
const AUTO_STOPS = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120]
const nearestStop = (v) => AUTO_STOPS.reduce((b, s) => (Math.abs(s - v) < Math.abs(b - v) ? s : b), AUTO_STOPS[0])
const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 逐字段校验；不认识的字段丢掉并记下来（不静默吞）。返回 { settings, notes }。 */
export function validate(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const notes = []
  const out = { ...DEFAULTS }
  for (const k of Object.keys(src)) if (!(k in DEFAULTS)) notes.push('丢弃未知字段 ' + k)
  // 底图：要么 null，要么是本插件认识的那个结构
  if (src.wallpaper === null || src.wallpaper === undefined) out.wallpaper = null
  else if (typeof src.wallpaper === 'object' && typeof src.wallpaper.url === 'string' && src.wallpaper.url.startsWith('/bga/wallpapers/')) {
    out.wallpaper = {
      id: String(src.wallpaper.id || ''),
      cat: String(src.wallpaper.cat || ''),
      file: String(src.wallpaper.file || ''),
      name: String(src.wallpaper.name || ''),
      url: src.wallpaper.url,
      hd: src.wallpaper.hd === true,
      no: Number.isFinite(Number(src.wallpaper.no)) ? Number(src.wallpaper.no) : 0,
    }
  } else { notes.push('底图结构不合法 ⇒ 置空'); out.wallpaper = null }
  out.effect = EFFECT_IDS.includes(src.effect) ? src.effect : DEFAULTS.effect
  if (src.effect !== undefined && out.effect !== src.effect) notes.push('特效 ' + src.effect + ' 不认识 ⇒ 用 ' + out.effect)
  out.accent = isHex(src.accent) ? src.accent : DEFAULTS.accent
  out.deep = isHex(src.deep) ? src.deep : DEFAULTS.deep
  for (const k of Object.keys(RANGE)) {
    const n = Number(src[k])
    // 键**不存在**（老版本写的文件缺新字段）不算错，别喊"不是数字"——升级后第一次导入
    // 会拿 v1.10.0 的文件跑，那两条假警报读起来像用户文件坏了。
    if (!Number.isFinite(n)) { if (k in src) notes.push(k + ' 不是数字 ⇒ 用默认 ' + DEFAULTS[k]); continue }
    const c = clamp(n, RANGE[k][0], RANGE[k][1])
    if (c !== n) notes.push(k + ' ' + n + ' 越界 ⇒ 钳到 ' + c)
    out[k] = c
  }
  { // 档位吸附：坏值已在上面兜成默认，这里只剩"表外的数"这一种
    const snapped = nearestStop(out.autoMin)
    if (snapped !== out.autoMin) notes.push('autoMin ' + out.autoMin + ' 不是档位 ⇒ 吸附到 ' + snapped)
    out.autoMin = snapped
  }
  out.focus = (typeof src.focus === 'string' && /^-?\d+(\.\d+)?% -?\d+(\.\d+)?%$/.test(src.focus.trim())) ? src.focus.trim() : DEFAULTS.focus
  out.preset = PRESETS.includes(src.preset) ? src.preset : DEFAULTS.preset
  out.cardShadow = src.cardShadow !== false          // 默认开
  out.autoOn = src.autoOn === true                   // v1.10.0 默认关（不请自来的换图很烦）
  out.fadeOn = src.fadeOn !== false                  // v1.10.0 默认开
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 512))].slice(0,2000) : []
  const seen = new Set()
  out.playlists = (Array.isArray(src.playlists) ? src.playlists : []).slice(0,64).flatMap(p => {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || seen.has(p.id)) return []
    const name = typeof p.name === 'string' ? p.name.trim().slice(0,40) : ''
    if (!name && p.id !== 'favorites') return []
    seen.add(p.id)
    return [{id:p.id, name:p.id === 'favorites' ? '我喜欢' : name, items:ids(p.items)}]
  })
  if (!seen.has('favorites')) out.playlists.unshift({id:'favorites',name:'我喜欢',items:[]})
  out.recent = ids(src.recent).slice(0,36)
  out.playbackSource = typeof src.playbackSource === 'string' && src.playbackSource.length <= 520 && /^(all|cat:.+|list:[a-zA-Z0-9_-]{1,80})$/.test(src.playbackSource) ? src.playbackSource : 'all'
  out.playbackMode = src.playbackMode === 'ordered' ? 'ordered' : 'random'
  out.imageFraming = Object.create(null)
  if (src.imageFraming && typeof src.imageFraming === 'object' && !Array.isArray(src.imageFraming)) {
    for (const id of Object.keys(src.imageFraming).slice(0,2000)) {
      const v = src.imageFraming[id]
      if (!id || id.length > 512 || !v || typeof v !== 'object' || Array.isArray(v)) continue
      const zoom = Number(v.zoom), match = typeof v.focus === 'string' && v.focus.trim().match(/^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/)
      out.imageFraming[id] = {zoom:Number.isFinite(zoom)?clamp(zoom,1,2.2):1,
        focus:match?Math.min(100,Number(match[1]))+'% '+Math.min(100,Number(match[2]))+'%':'50% 50%'}
    }
  }
  out.weId = typeof src.weId === 'string' ? src.weId : null
  out.weMode = src.weMode === 'still' ? 'still' : 'live'
  out.weQuality = ['smooth','balanced','saver'].includes(src.weQuality) ? src.weQuality : 'balanced'
  return { settings: out, notes }
}

function readSettings() {
  try {
    // 容忍 BOM：Windows 上人手改过 settings.json（记事本/PowerShell 5.1 的 utf8 都带 BOM）时
    // JSON.parse 会直接抛，不该因此被当成"没有设置"。
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, ''))
  } catch { return null }
}
function writeSettings(s) {
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8')
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** 底图是否真的在本机：按 url 里的「类型/文件名」到插件目录找（本脚本位于 <插件>/tools/）。 */
function wallpaperExistsOnDisk(w) {
  if (!w || !w.url) return null
  try {
    const parts = decodeURIComponent(w.url.replace('/bga/wallpapers/', '')).split('/')
    const p = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'wallpapers', ...parts)
    return fs.existsSync(p)
  } catch { return null }
}

const cmd = process.argv[2]
const args = process.argv.slice(3)
const flag = (n) => args.includes(n)

if (cmd === 'show') {
  const s = readSettings()
  console.log('设置文件：' + settingsFile() + (fs.existsSync(settingsFile()) ? '' : '（不存在，插件用默认值）'))
  console.log(JSON.stringify(s || DEFAULTS, null, 2))
} else if (cmd === 'export') {
  const cur = readSettings()
  if (!cur) { console.error('没有可导出的设置（' + settingsFile() + ' 不存在）。先在设置页里点几下再导出。'); process.exit(1) }
  const { settings } = validate(cur)
  const i = args.indexOf('--out')
  const out = i >= 0 ? args[i + 1] : path.join(process.cwd(), 'dsh-bg-atelier-settings-' + stamp().slice(0, 10) + '.json')
  const payload = { format: FORMAT, plugin: PLUGIN, pluginVersion: '1.15.0', exportedAt: new Date().toISOString(), host: os.hostname(), settings }
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
  console.log('已导出 ' + out)
  console.log('  ' + Object.keys(settings).length + ' 个字段；底图 = ' + (settings.wallpaper ? settings.wallpaper.name : '（未选）'))
  console.log('  ⚠ 底图**图片本身**不在这个文件里：新机器上要么整仓克隆，要么 `git sparse-checkout add wallpapers` 按需取图。')
} else if (cmd === 'import') {
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) { console.error('用法：node tools/settings.mjs import <文件> [--yes]'); process.exit(1) }
  let payload
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { console.error('读不了这个文件：' + e.message); process.exit(1) }
  if (payload.format !== FORMAT || payload.plugin !== PLUGIN) {
    console.error('不是本插件的设置文件（format=' + payload.format + ' plugin=' + payload.plugin + '，期望 ' + FORMAT + ' / ' + PLUGIN + '）')
    process.exit(1)
  }
  const { settings, notes } = validate(payload.settings)
  const before = readSettings()
  console.log('将写入：' + settingsFile())
  console.log('  特效 ' + settings.effect + ' · 底图 ' + (settings.wallpaper ? settings.wallpaper.name : '（未选）') + ' · 卡面阴影 ' + settings.cardShadow
    + ' · 自动切换 ' + (settings.autoOn ? settings.autoMin + ' 分钟' : '关') + ' · 渐变 ' + (settings.fadeOn ? '开' : '关'))
  for (const n of notes) console.log('  注意：' + n)
  const missing = wallpaperExistsOnDisk(settings.wallpaper)
  if (missing === false) console.log('  ⚠ 这张底图的图片文件在本机不存在：克隆时若用了 sparse，执行 `git sparse-checkout add wallpapers` 取回图片。')
  if (!flag('--yes')) { console.log('（演练模式：加 --yes 才真正写入。现有设置会先备份。）'); process.exit(0) }
  if (before) {
    const bak = settingsFile() + '.bak-' + stamp()
    fs.copyFileSync(settingsFile(), bak)
    console.log('  已备份原设置 → ' + bak)
  }
  writeSettings(settings)
  console.log('完成。**需要重启 DSH Desktop 才生效**（client 半在服务启动时 compose）。')
} else {
  console.log('底图工坊 · 设置导出/导入\n  node tools/settings.mjs show\n  node tools/settings.mjs export [--out <文件>]\n  node tools/settings.mjs import <文件> [--yes]')
  console.log('\n换机器完整流程：')
  console.log('  旧机器: node tools/settings.mjs export --out D:\\dsh-bg-atelier-settings.json')
  console.log('  新机器: git clone（或精简克隆，见 README）→ dsh plugin --profile web add link:<路径>')
  console.log('          → node tools/settings.mjs import D:\\dsh-bg-atelier-settings.json --yes → 重启 DSH Desktop')
  console.log('  另外两个插件各有自己的同款脚本：dsh-cache-control/tools/settings.mjs、dsh-browser-live/tools/settings.mjs')
}
