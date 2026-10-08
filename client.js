// ============================================================================
// dsh-bg-atelier · Client half (packaged, boot-loaded; 版本以 package.json 为准)
// 职责: 底图绘制 + 主题 token 染色 + 琉璃卡面与 dock 特效 + WE 动效层 + 设置页。
//   · 底图按"类型"两级浏览: 一级 = 放图目录下每个子文件夹一个类型, 二级 = 该类型图库
//     (缩略图即点即换, №编号角标, 全部/高清/普通筛选)。
//   · 换图宝珠 / 手动 / 自动共享选定范围与随机或顺序播放；图单可排序，构图按图片保存。
//   · 粒子数量随画布宽度按固定间距缩放 (countFor/DENSITY); 特效与底图解耦 (无底图也照画)。
//   · 清单与设置走 /bga/* HTTP 路由, 样式自包含注入。
// 历史流水账的唯一真源在 README「更新记录」；此处只留**解释当前行为**的注释。
// 已移交 dsh-cache-control (v1.3.0): 「对话页固定宽度」整节 —— 本插件不再写任何 --dsh-chat-* 变量。
// ============================================================================

window.__ModuleLoader__.load({
  // v1.16.0: id 必须与 package.json 的包名一致 —— 客户端 bundle 是按
  // "包名/client.js" 组 URL 加载的, 宿主用包名查这个 id, 对不上就是
  // "import failed: client-modules: could not load ..." (页面直接报 Failed to load plugins)。
  id: 'dsh-bg-atelier-plus',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    // 自包含样式注入器: 不再依赖运行时-only 的 styles 全局。
    var styles = {
      insert: function (css) {
        var el = document.createElement('style')
        el.type = 'text/css'
        el.setAttribute('data-bg-atelier-styles', '1')
        el.textContent = css
        document.head.appendChild(el)
        return function () { if (el.parentNode) el.parentNode.removeChild(el) }
      },
    }

    var h = React.createElement

// 去掉文件扩展名, 底图显示名不带 .png/.jpg 等后缀。
function bareName(name) {
  var n = String(name || '')
  var i = n.lastIndexOf('.')
  return i > 0 ? n.slice(0, i) : n
}

// 当前底图的展示标签: "类型/显示名 №编号" (编号不参与显示名本身)。
function curLabel(w) {
  if (!w) return ''
  var nm = w.name || (w.file ? bareName(w.file) : '')
  nm = bareName(nm)
  var cat = w.cat ? w.cat + '/' : ''
  return cat + (nm || '底图') + (w.no ? '  №' + w.no : '')
}

// ---------------------------------------------------------------- 状态存储 --

var PRESETS = [
  { id: 'sakura',    name: '樱粉',   accent: '#e88ca0', deep: '#241318' },
  { id: 'teal',      name: '青碧',   accent: '#63c8c0', deep: '#0e1a1c' },
  { id: 'amber',     name: '琥珀',   accent: '#e0a75e', deep: '#1d1409' },
  { id: 'violet',    name: '星紫',   accent: '#9d8cff', deep: '#130f22' },
  { id: 'mint',      name: '薄荷',   accent: '#6fce9e', deep: '#0f1c14' },
  { id: 'crimson',   name: '绛红',   accent: '#d96060', deep: '#220f12' },
  { id: 'mist',      name: '雾蓝',   accent: '#7aa7e8', deep: '#101826' },
  { id: 'lavender',  name: '薰衣草', accent: '#c49ae0', deep: '#1b1424' },
  { id: 'peach',     name: '蜜桃',   accent: '#f2a183', deep: '#23120e' },
  { id: 'mono',      name: '墨黑',   accent: '#9aa0a8', deep: '#141518' },
]

// 特效选项: 流萤 / 气泡 / 落樱 / 雨丝 + 关闭 (v1.5.2 定稿, 从 8 种里挑的这 4 个)。
// 全部只画在「输入框上方那条 dock 条」与卡面辉光上, 不碰消息气泡
// (消息气泡的样式归 dsh-cache-control, 两边同时改会互相盖)。
// **硬约束**：任何特效的粒子行程必须留在画布内 —— 飘出右缘会顶大
// [data-conversation-scroll] 的 scrollWidth, 让会话区底部那条横向滚动条频闪
// (v1.4.2 修过一次, 见 tools/verify-dockfx-bounds.mjs)。
var EFFECTS = [
  { id: 'firefly', name: '流萤', hint: '18 只萤 + 14 颗星 + 2 道流星，成群掠过输入框上方 (仅会话页)' },
  { id: 'bubble',  name: '气泡', hint: '14 个大气泡从输入框底部涌起, 边缘带高光, 底部一层水面辉光' },
  { id: 'petal',   name: '落樱', hint: '14 片小花瓣边落边摆边自转, 飘到卡面上沿淡出。配二次元 / 线稿风底图' },
  { id: 'rain',    name: '雨丝', hint: '44 条细斜雨丝下落 + 卡面上沿一层被雨打湿的水光。四条里节奏最快最密' },
  { id: 'off',     name: '关闭', hint: '仅保留琉璃卡面, 不加框缘装饰' },
]

// 已知特效 id 白名单: 盘上存过的历次撤掉的特效 id (锦框/流光环/墨韵/声波/极光/
// 光带扫过/星轨环绕/浮尘光斑/墨韵涟漪) 一律归一到「流萤」, 自己选过「关闭」的保持不变。
var EFFECT_IDS = { firefly: 1, bubble: 1, petal: 1, rain: 1, off: 1 }

function normalizeEffect(v) {
  return EFFECT_IDS[v] === 1 ? v : 'firefly'
}

/** v1.16.0 外观适配三项的归一化。缺字段 = 老设置文件/新装:
 *  surface 给 0.30(原 glass .8 时的等效面透明度), preview / bubble 保持开与中等强度。 */
function stylesNumber(v, fallback, lo, hi) {
  var n = Number(v)
  if (!isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}
/** 表面不透明度的上限。用户 2026-10-01 定：**30% 封顶** —— 再高底图就被洗白了，
 *  所以 0.30 既是默认也是上限（原来 0.8 的滑杆太宽，都在没用的区间里）。 */
var SURFACE_MAX = 0.30
function normalizeStyles(value) {
  var v = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    surface: stylesNumber(v.surface, SURFACE_MAX, 0, SURFACE_MAX),
    preview: v.preview !== false,
    bubble: stylesNumber(v.bubble, 0.5, 0, 1),
  }
}

var FOCI = [
  { id: 'tl', pos: '0% 0%' },     { id: 'tc', pos: '50% 0%' },   { id: 'tr', pos: '100% 0%' },
  { id: 'cl', pos: '0% 50%' },    { id: 'cc', pos: '50% 50%' },  { id: 'cr', pos: '100% 50%' },
  { id: 'bl', pos: '0% 100%' },   { id: 'bc', pos: '50% 100%' }, { id: 'br', pos: '100% 100%' },
]

// 是否成功从 host 读到过设置（模块级、**不落盘**）：save() 的写盘闸，见 save/load 里的注释。
var stateLoaded = false

var STORE = {
  state: {
    wallpaper: null,      // { name, url } | null
    effect: 'firefly',    // 仅 firefly(流萤) / off(关闭); 旧值锦框等载入时由 normalizeEffect 归一到流萤
    accent: '#e88ca0',
    deep: '#241318',
    veil: 0,              // 底图暗纱 0..0.85 (默认 0: 与原图一致 100% 清晰)
    glass: 0.8,           // 全局表面透光 0..1 (越大越透, 默认 80%)
    cardA: 0,             // 输入框不透明度 0..1 (默认 0 → ~95% 透明)
    cardBlur: 10,         // 输入框背景模糊 px 0..24 (白底图建议调低)
    cardShadow: true,     // 卡面深色接触阴影 + 环境阴影的独立开关 (v1.5.4: 关特效不再把阴影一起关掉)
    focus: '50% 50%',     // 底图焦点 (九宫格), 裁剪时保住画面主体
    zoom: 1,              // 底图缩放 1..2.2 (绕焦点放大)
    preset: 'sakura',
    // v1.10.0 自动切换 / 渐变过渡; v1.11.0 起间隔走 AUTO_STOPS 档位, 过渡的时长与响应时间可调
    autoOn: false,        // 定时自动换图开关 (默认关: 不请自来的换图很烦)
    autoMin: 30,          // 自动切换间隔, 取 AUTO_STOPS 里的一档 (读的时候按 autoDelayMs 再吸附一次)
    fadeOn: true,         // 换图时淡入淡出, 全局生效 (点图卡 / 宝珠随机 / 自动切换都走它)
    fadeDelayMs: 0,       // 响应时间 ms 0..1000: 换图后旧图先原样多盖一会儿, 到点才开始淡出
    fadeMs: 900,          // 渐变时长 ms 100..5000: 旧图淡出那一段的长度
    playlists: [{ id: 'favorites', name: '我喜欢', items: [] }],
    playbackSource: 'all', // all | cat:<目录名> | list:<图单 id>
    playbackMode: 'random', // random | ordered
    imageFraming: {},       // 稳定图片 id → {zoom, focus}；未单独调整的图沿用旧版默认构图
    recent: [],
    // v1.7.0 WE 动效底图: 只存 entry id, 真实 entry (封面/取色/相对路径) 每次启动从 host 的
    // /bga/we/library.json 重新解析 —— 壁纸在 WE 侧取消订阅后这里自然解析不到, 静默跳过。
    weId: null,
    weMode: 'live',       // live uses the desktop bridge; still remains available.
    weQuality: 'balanced',
    // v1.16.0 (官方版分支) 三处适配开关, 见 normalizeStyles() / themeSurfaceCss() / bubbleCss():
    //   surface  —— 大面积表面(外框/侧栏/会话区)的不透明度。官方版浅色主题下这些面
    //               原本是一层近白薄纱(用户说的"盖了层白布"), 现在改成带底图色调的浅色 + 可调透明。
    //   preview  —— 高清底图分两步上屏: 先铺 640 预览(秒出), 再换中间档/原图。
    //   bubble   —— 消息气泡加一点淡阴影(和输入框卡面同源, 可调强度)。
    styles: { surface: 0.30, preview: true, bubble: 0.5 },
  },
  list: [],
  listDir: '',
  writableDir: '',
  skipped: [],
  categories: [],   // v1.1 类型清单 (fetchList 填充); 先给空数组避免首次渲染崩溃
  total: 0,         // 全部类型图片总数
  listeners: [],
  set: function (patch) {
    patch = migrateWallpaperNames(patch)
    // 清空或其它入口直接指定底图时，取消仍在解码的旧请求，防止稍后又盖回来。
    if (Object.prototype.hasOwnProperty.call(patch, 'wallpaper') || patch.weId) cancelWallpaperRequest()
    if (patch.wallpaper === null) { decodedWallpaper=null; forgetLarges() }
    var next = {}
    for (var k in this.state) next[k] = this.state[k]
    for (var p in patch) next[p] = patch[p]
    if (Object.prototype.hasOwnProperty.call(patch, 'playlists')) next.playlists = normalizePlaylists(patch.playlists)
    if (Object.prototype.hasOwnProperty.call(patch, 'recent')) next.recent = uniqueImageIds(patch.recent).slice(0, 36)
    if (Object.prototype.hasOwnProperty.call(patch, 'playbackSource')) next.playbackSource = normalizeSource(patch.playbackSource)
    if (Object.prototype.hasOwnProperty.call(patch, 'playbackMode')) next.playbackMode = patch.playbackMode === 'ordered' ? 'ordered' : 'random'
    if (Object.prototype.hasOwnProperty.call(patch, 'imageFraming')) next.imageFraming = normalizeImageFraming(patch.imageFraming)
    if (Object.prototype.hasOwnProperty.call(patch, 'styles')) next.styles = normalizeStyles(patch.styles)
    this.state = next
    STORE.save()
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i]()
  },
  /** 只通知重渲染、**不写盘**（v1.5.4）：画布宽度变了要按新数量重画粒子，
   *  那是运行时事实、不是用户设置，落到 settings.json 里只会变成噪声。 */
  touch: function () {
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i]()
  },
  save: function () {
    // 2026-09-12 加闸：**没成功读到过设置就不许写盘**。
    // 少了这道闸，一个"设置还没拉回来"的客户端（重启后抢跑、路由还没就绪、请求失败）
    // 随手点一下任何开关，就会把自己那套默认值（wallpaper: null、默认主色…）
    // 整份 PUT 覆盖掉你的真实配置 —— 这正是"底图 / 特效突然全没了"的成因之一。
    // dsh-cache-control 早就有这道闸（它 state 里的 loaded），本插件一直缺。
    if (!stateLoaded) return
    STORE.saveStatus = 'saving'
    STORE._savePending = true
    if (STORE._saveTimer) { clearTimeout(STORE._saveTimer); STORE._saveTimer = null }
    STORE._saveTimer = setTimeout(function () {
      STORE._saveTimer = null
      STORE.flushSave()
    }, 300)
  },
  // 保存串行化：上一份写完才发最新状态，避免迟到请求覆盖新图单。
  flushSave: function () {
    if (STORE._saving || !STORE._savePending) return
    STORE._saving = true
    STORE._savePending = false
    Promise.resolve().then(function () {
      return fetch('/bga/settings.json', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(STORE.state) })
    }).then(function (r) {
      if (!r.ok) throw new Error('save failed')
      STORE.saveStatus = STORE._savePending ? 'saving' : 'saved'
    }).catch(function () { STORE.saveStatus = 'error' }).then(function () {
      STORE._saving = false
      if (STORE._savePending) STORE.flushSave()
      STORE.touch()
    })
  },
  load: function () {
    return fetch('/bga/settings.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('settings unavailable'); return r.json() })
      .then(function (saved) {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid settings')
        var patch = {}
        for (var k in STORE.state) if (k in saved) patch[k] = saved[k]
        // 一份"真设置"至少要能对上我们认识的一个字段；对不上就是 {} / 路由没就绪
        // ⇒ 保持"未装载"、不许写盘（见 save 里的闸）。
        // 成功的空对象代表新安装；只有 HTTP/解析失败时禁止保存。
        if (patch.effect !== undefined) patch.effect = normalizeEffect(patch.effect)
        stateLoaded = true                    // 先开闸，再 set（set 内部会 save）
        STORE.set(patch)                      // 触发监听→重绘
      })
      .catch(function () { STORE.saveStatus = 'load-error'; STORE.touch() })
  },
  subscribe: function (fn) {
    this.listeners.push(fn)
    var self = this
    return function () {
      var i = self.listeners.indexOf(fn)
      if (i >= 0) self.listeners.splice(i, 1)
    }
  },
}

function useBga() {
  var pair = React.useState(0)
  var force = pair[1]
  React.useEffect(function () {
    return STORE.subscribe(function () { force(function (x) { return x + 1 }) })
  }, [])
  return STORE.state
}

// ---------------------------------------------------------- 底图数据与换图 --
// 扁平条目 (跨类型): { id, cat, file, base, url, hd, no, size }
// 状态 wallpaper: { id, cat, file, name(显示名=base), url, hd, no }
//   id = 类型名 + 原始文件名 (稳定, 与排序/编号无关), 用于随机去重。

function hydrateItem(it, catName) {
  return {
    id: catName + '\u0000' + it.name,
    cat: catName,
    file: it.name,
    base: it.base || bareName(it.name),
    url: it.url,
    hd: !!it.hd,
    // v1.16.4: 标签来自 host（目录声明 + 文件名 `!主体` 覆盖 + 高清时补「高清」）。
    // 一张图可能同时挂「重返未来1999」和「高清」—— 搜 6·1 两版都出来就靠它。
    tags: Array.isArray(it.tags) && it.tags.length ? it.tags.slice(0, 8) : [catName || '未分类'],
    no: it.no || 0,
    size: it.size || 0,
  }
}

function wallpaperOf(item) {
  return {
    id: item.id,
    cat: item.cat,
    file: item.file,
    name: item.base,   // 显示名 (去扩展名/去高清标记), 不随编号变化
    url: item.url,
    hd: !!item.hd,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : (item.cat ? [item.cat] : []),
    no: item.no || 0,
    // v1.16.0: size 必须一起带上 —— previewUrlOf/largeUrlOf 靠它判断"是不是大图",
    // 少了它 (原来就是漏的) 大图也会被当成小图, 直接拉几十 MB 的原图。
    size: item.size || 0,
  }
}

/** 换底图的唯一入口（点图卡 / 侧栏宝珠 / 自动切换都走它）：**先把新图解码好再切**。
 *  列表里显示的是 640px 预览，底图是几十 MB 的原图；不等它解码就切，body::before 还是空的，
 *  而上一张正在 900ms 里淡出 ⇒ 中间几帧透出深色底（先变暗再回来，就是"不自然"的来源）。
 *  等到解码成功才切；失败/超时保留现有底图，不把尚未可画的图片硬塞到渐变下面。
 *  swapSeq：连着点两张时，慢的那张不许盖掉后点的快图。 */
var swapSeq = 0
var pendingStep = null
var queuedSwap = null
var decodeJob = null
var upgradeJob = null          // 预览上屏后的"升清"任务 (v1.16.0 官方版分支)
var decodedWallpaper = null    // 已经解好的原图/预览

// 只迁移明确更名的图片引用，不改图单名称或多人组合图名。
var WALLPAPER_RENAMES = []
;['重返未来1999', '高清'].forEach(function (cat) {
  ;['2', '5', '6'].forEach(function (n) { WALLPAPER_RENAMES.push([cat, '贝利尔'+n+'.png', '贝丽尔'+n+'.png']) })
  WALLPAPER_RENAMES.push([cat, '以影像之2.png', '以影相之2.png'])
  ;['冷周六', '图图星锑'].forEach(function (name) { WALLPAPER_RENAMES.push([cat, name+'.png', name+'1.png']) })
})
WALLPAPER_RENAMES.push(['重返未来1999', '维拉.png', '维拉2.png'])
function migrateWallpaperNames(patch) {
  var result = Object.assign({}, patch)
  function ref(value) {
    if (typeof value !== 'string') return value
    WALLPAPER_RENAMES.forEach(function (entry) {
      var cat=entry[0], old=entry[1], name=entry[2]
      if (value === cat+'\0'+old) value=cat+'\0'+name
      else if (value === '/bga/wallpapers/'+encodeURIComponent(cat)+'/'+encodeURIComponent(old)) value='/bga/wallpapers/'+encodeURIComponent(cat)+'/'+encodeURIComponent(name)
    })
    return value
  }
  if (patch.wallpaper) {
    var w=patch.wallpaper
    var entry=WALLPAPER_RENAMES.find(function (e) { return w.id===e[0]+'\0'+e[1] || w.url==='/bga/wallpapers/'+encodeURIComponent(e[0])+'/'+encodeURIComponent(e[1]) })
    if (entry) result.wallpaper=Object.assign({},w,{id:entry[0]+'\0'+entry[2],cat:entry[0],file:entry[2],name:entry[2].slice(0,-4),url:'/bga/wallpapers/'+encodeURIComponent(entry[0])+'/'+encodeURIComponent(entry[2])})
  }
  if (Array.isArray(patch.playlists)) result.playlists=patch.playlists.map(function(p){return p&&Array.isArray(p.items)?Object.assign({},p,{items:p.items.map(ref)}):p})
  if (Array.isArray(patch.recent)) result.recent=patch.recent.map(ref)
  if (patch.imageFraming && typeof patch.imageFraming==='object') {
    var map=Object.create(null)
    Object.keys(patch.imageFraming).forEach(function(key){map[ref(key)]=patch.imageFraming[key]})
    // 新旧引用同时存在时，优先保留新名字上已经调好的构图。
    Object.keys(patch.imageFraming).forEach(function(key){if(ref(key)===key)map[key]=patch.imageFraming[key]})
    result.imageFraming=map
  }
  return result
}
function cancelWallpaperRequest() {
  swapSeq++
  pendingStep = null
  queuedSwap = null
  if(decodeJob){var job=decodeJob;decodeJob=null;job.cancel()}
  if(upgradeJob){var up=upgradeJob;upgradeJob=null;up.cancel()}
  if(!STORE.state.wallpaper)decodedWallpaper=null
}

// 图单只保存稳定图片 id，不移动原图；缺失图片仍留在图单，文件恢复后自动可用。
function uniqueImageIds(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter(function (id) { return typeof id === 'string' && id.length > 0 && id.length <= 512 }))).slice(0, 2000)
}
function normalizePlaylists(value) {
  var seen = new Set(), result = []
  if (Array.isArray(value)) value.slice(0, 64).forEach(function (p) {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || seen.has(p.id)) return
    var name = typeof p.name === 'string' ? p.name.trim().slice(0, 40) : ''
    if (!name && p.id !== 'favorites') return
    seen.add(p.id)
    result.push({ id: p.id, name: p.id === 'favorites' ? '我喜欢' : name, items: uniqueImageIds(p.items) })
  })
  if (!seen.has('favorites')) result.unshift({ id: 'favorites', name: '我喜欢', items: [] })
  return result
}
function normalizeSource(value) {
  return typeof value === 'string' && value.length <= 520 && /^(all|cat:.+|list:[a-zA-Z0-9_-]{1,80})$/.test(value) ? value : 'all'
}
function playlistById(id) { return STORE.state.playlists.find(function (p) { return p.id === id }) }
function normalizeFrame(value) {
  value = value || {}
  var zoom = Number(value.zoom), match = typeof value.focus === 'string' && value.focus.trim().match(/^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/)
  return {zoom:isFinite(zoom)?Math.max(1,Math.min(2.2,zoom)):1,
    focus:match?Math.min(100,Number(match[1]))+'% '+Math.min(100,Number(match[2]))+'%':'50% 50%'}
}
function normalizeImageFraming(value) {
  var result = Object.create(null)
  if (value && typeof value === 'object' && !Array.isArray(value)) Object.keys(value).slice(0,2000).forEach(function(id){
    if(id && id.length<=512 && value[id] && typeof value[id]==='object' && !Array.isArray(value[id])) result[id]=normalizeFrame(value[id])
  })
  return result
}
function framingOf(s, wallpaper) {
  var id = wallpaper && (wallpaper.id || wallpaper.url)
  var map=s.imageFraming||{},url=wallpaper&&wallpaper.url
  return normalizeFrame(id && Object.prototype.hasOwnProperty.call(map,id) ? map[id] : url && Object.prototype.hasOwnProperty.call(map,url) ? map[url] : s)
}
function framingForUrl(s,url) {
  var w = s.wallpaper && s.wallpaper.url === url ? s.wallpaper : STORE.list.find(function(it){return it.url===url})
  return framingOf(s,w)
}
function setImageFraming(patch) {
  var s=STORE.state,w=s.wallpaper,id=w&&(w.id||w.url)
  if(!id)return
  var map=Object.assign(Object.create(null),s.imageFraming)
  map[id]=normalizeFrame(Object.assign({},framingOf(s,w),patch))
  STORE.set({imageFraming:map})
}
function resetImageFraming() { setImageFraming({zoom:1,focus:'50% 50%'}) }
function sourceItems(source, items) {
  source = source || 'all'
  items = items || STORE.list
  if (source === 'all') return items
  if (source.indexOf('cat:') === 0) return items.filter(function (it) { return it.cat === source.slice(4) })
  var ids = source === 'recent' ? STORE.state.recent : (playlistById(source.slice(5)) || {}).items || []
  var byId = new Map(items.map(function (it) { return [it.id, it] }))
  return ids.map(function (id) { return byId.get(id) }).filter(Boolean)
}
function sourceLabel(source) {
  if (source === 'all') return '全部壁纸'
  if (source === 'recent') return '最近使用'
  if (source.indexOf('cat:') === 0) return source.slice(4)
  return (playlistById(source.slice(5)) || {}).name || '图单已不存在'
}
function createPlaylist(name, ids) {
  name = String(name || '').trim().slice(0, 40)
  if (!name) throw new Error('给图单起个名字吧')
  if (STORE.state.playlists.some(function (p) { return p.name.toLocaleLowerCase() === name.toLocaleLowerCase() })) throw new Error('已有同名图单，换个名字吧')
  if (STORE.state.playlists.length >= 64) throw new Error('图单已达 64 个，请先整理现有图单')
  var id = 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  STORE.set({ playlists: STORE.state.playlists.concat([{ id: id, name: name, items: uniqueImageIds(ids) }]) })
  return id
}
function renamePlaylist(id, name) {
  if (id === 'favorites') return
  name = String(name || '').trim().slice(0, 40)
  if (!name) throw new Error('图单名称不能为空')
  if (STORE.state.playlists.some(function (p) { return p.id !== id && p.name.toLocaleLowerCase() === name.toLocaleLowerCase() })) throw new Error('已有同名图单')
  STORE.set({playlists: STORE.state.playlists.map(function (p) { return p.id === id ? { id: p.id, name: name, items: p.items } : p })})
}
function removePlaylist(id) {
  if (id === 'favorites') return
  var patch = {playlists: STORE.state.playlists.filter(function (p) { return p.id !== id })}
  if (STORE.state.playbackSource === 'list:' + id) { patch.playbackSource = 'all'; patch.autoOn = false; cancelWallpaperRequest(); nextUrl = null }
  STORE.set(patch)
}
function changeMembership(ids, listIds, replace) {
  ids = uniqueImageIds(ids)
  STORE.set({playlists: STORE.state.playlists.map(function (p) {
    var add = listIds.indexOf(p.id) >= 0
    if (!add && !replace) return p
    return {id:p.id, name:p.name, items: add ? uniqueImageIds(p.items.concat(ids)) : p.items.filter(function (id) { return ids.indexOf(id) < 0 })}
  })})
}
function removeFromPlaylist(id, ids) {
  STORE.set({playlists: STORE.state.playlists.map(function (p) { return p.id === id ? {id:p.id,name:p.name,items:p.items.filter(function (i) {return ids.indexOf(i)<0})} : p })})
}
function toggleFavorite(id) {
  var fav = playlistById('favorites')
  if (fav.items.indexOf(id) >= 0) removeFromPlaylist('favorites', [id])
  else changeMembership([id], ['favorites'], false)
}
function setPlaybackSource(source) {
  cancelWallpaperRequest(); nextUrl = null
  nextFade=null;lastManualFadeAt=null
  if(normalizeSource(source)!==STORE.state.playbackSource){playbackTrail=[];playbackCursor=-1;trailSource=''}
  STORE.set({playbackSource: normalizeSource(source)})
}
function reorderPlaylist(id, moving, target) {
  var list=playlistById(id)
  if(!list || moving===target)return
  var from=list.items.indexOf(moving),to=list.items.indexOf(target)
  if(from<0||to<0)return
  var ids=list.items.slice();ids.splice(from,1);ids.splice(to,0,moving)
  if(STORE.state.playbackSource==='list:'+id)playbackTrail=playbackTrail.slice(0,playbackCursor+1)
  STORE.set({playlists:STORE.state.playlists.map(function(p){return p.id===id?{id:p.id,name:p.name,items:ids}:p})})
}
function setPlaybackMode(mode) {
  cancelWallpaperRequest();cycleDeck=[];cycleSig=''
  playbackTrail=playbackTrail.slice(0,playbackCursor+1)
  STORE.set({playbackMode:mode})
}
// 浏览历史保留重复经过的图；最近使用的去重列表不能用来实现连续后退。
var playbackTrail=[],playbackCursor=-1,trailSource=''
function syncPlaybackTrail() {
  var source=STORE.state.playbackSource,allowed=new Set(sourceItems(source).map(function(it){return it.id}))
  if(trailSource!==source){playbackTrail=[];playbackCursor=-1;trailSource=source}
  var kept=[],cursor=-1
  playbackTrail.forEach(function(id,i){if(allowed.has(id)){kept.push(id);if(i<=playbackCursor)cursor=kept.length-1}})
  playbackTrail=kept;playbackCursor=cursor
  var cur=STORE.state.wallpaper
  if(!playbackTrail.length&&cur&&allowed.has(cur.id)){playbackTrail=[cur.id];playbackCursor=0}
}
function recordWallpaper(id, historyIndex) {
  syncPlaybackTrail()
  if(!sourceItems(STORE.state.playbackSource).some(function(it){return it.id===id}))return
  if(typeof historyIndex==='number'&&playbackTrail[historyIndex]===id){playbackCursor=historyIndex;return}
  if(playbackTrail[playbackCursor]===id)return
  playbackTrail=playbackTrail.slice(0,playbackCursor+1).concat(id).slice(-100)
  playbackCursor=playbackTrail.length-1
}
function historyStep(direction, timing) {
  syncPlaybackTrail()
  var cursor=pendingStep&&typeof pendingStep.historyIndex==='number'?pendingStep.historyIndex:playbackCursor
  var cur=STORE.state.wallpaper
  if(!pendingStep&&cur&&!sourceItems(STORE.state.playbackSource).some(function(it){return it.id===cur.id}))cursor=playbackTrail.length
  var index=cursor+direction
  if(index<0||index>=playbackTrail.length)return false
  var item=sourceItems(STORE.state.playbackSource).find(function(it){return it.id===playbackTrail[index]})
  if(!item)return false
  setWallpaper(item,{historyIndex:index,source:STORE.state.playbackSource,timing:timing});return true
}
function canPreviousWallpaper() {
  syncPlaybackTrail()
  var cur=STORE.state.wallpaper
  return playbackCursor>0 || playbackTrail.length>0&&cur&&!sourceItems(STORE.state.playbackSource).some(function(it){return it.id===cur.id})
}
function previousWallpaper() { if(!weIsBackground())historyStep(-1) }
function setWallpaper(item, navigation) {
  if (wallpaperBackgrounded()) return
  navigation=navigation||{}
  // 时长在点击当下决定，不能把图片解码耗时算成用户的点击间隔。
  var timing=navigation.timing || (navigation.automatic ? normalFadeTiming() : manualFadeTiming())
  pendingStep={id:item.id,historyIndex:navigation.historyIndex}
  var request={seq:++swapSeq,wallpaper:wallpaperOf(item),navigation:navigation,timing:timing}
  // 每次点击推进逻辑位置；同一时刻只解码一张，再留一个可替换的最新目标。
  // 不为注定赶不上屏幕的中间图开一批无法真正停止的 decode()。
  queuedSwap=request
  if(decodeJob&&decodeJob.request.wallpaper.url===request.wallpaper.url){decodeJob.request=request;queuedSwap=null;return}
  var current=STORE.state.wallpaper
  if(current&&current.id===request.wallpaper.id&&current.url===request.wallpaper.url){
    queuedSwap=null;pendingStep=null
    // 已显示的图无需再解码，但旧设置补全名称、历史返回的位置仍须更新。
    if(Object.keys(request.wallpaper).some(function(key){return current[key]!==request.wallpaper[key]}))commitWallpaper(request,decodedWallpaper&&decodedWallpaper.url===current.url?decodedWallpaper.img:null)
    else recordWallpaper(request.wallpaper.id,navigation.historyIndex)
    return
  }
  pumpWallpaperRequest()
}
function commitWallpaper(request, img) {
  if(request.seq!==swapSeq || wallpaperBackgrounded())return
  var w=request.wallpaper,navigation=request.navigation
  if(navigation.source&&(navigation.source!==STORE.state.playbackSource||!sourceItems(navigation.source).some(function(it){return it.id===w.id}))){pendingStep=null;return}
  recordWallpaper(w.id,navigation.historyIndex)
  selectionFade={wallpaper:w,timing:request.timing}
  var patch={wallpaper:w}
  if(w.id&&w.url)patch.recent=[w.id].concat(STORE.state.recent.filter(function(id){return id!==w.id})).slice(0,36)
  STORE.set(patch)
  decodedWallpaper=img?{url:w.url,img:img}:null
}
function pumpWallpaperRequest() {
  if(wallpaperBackgrounded()||decodeJob||!queuedSwap)return
  // 当前画面还在过渡时，先完成并提速这段；之后只加载最新目标。
  // 这样大预览、STORE 与保存也不会追着每张尚未显示的图重绘。
  if(fadeEl&&STORE.state.fadeOn!==false&&!reducedMotion())return
  var request=queuedSwap;queuedSwap=null
  if(request.seq!==swapSeq)return
  var w=request.wallpaper
  if(!w.url||typeof Image!=='function'){commitWallpaper(request,null);return}
  var cached=wallpaperImageFor(w)
  if(cached){commitWallpaper(request,cached);return}
  var previewUrl=previewUrlOf(w), largeUrl=largeUrlOf(w)
  // 「正在看的就是这张」上面已经用 wallpaperImageFor 命中并 return 了, 所以这里不再比较
  // 当前 url —— 早先那版多写了一次 `state.wallpaper.url===w.url`, 结果换图时预览永远被判成
  // 关掉 (新旧 url 必然不同), 两段式加载一次都没生效。
  var previewOn=previewUrl!==null&&STORE.state.styles&&STORE.state.styles.preview!==false
  // 第一段: 预览(或"预览关掉时"直接用目标图) —— 这一段的解码结果照旧交给 commitWallpaper。
  startDecode(request,previewOn?previewUrl:largeUrl,true,function(){
    // 第二段: 升清。原来几十 MB 的原图在这里还要**再解一次**才能上屏, 换高清时那一下
    // 卡顿就出在这儿; 现在升清只在图片加载完成后提交 (浏览器已解好), 主线程不再重解。
    if(previewOn&&!wallpaperBackgrounded())upgradeWallpaper(request,largeUrl)
  })
}

/** 先铺预览、稍后换清晰版的目标尺寸 (长边)。0 = 不请求中间档, 直接用原图。 */
var PREVIEW_UPGRADE_DIM=3840
/** item/wallpaper 形状通用的尺寸读取 (wallpaper 对象上 size 是可选字段)。 */
function sizeOfWallpaper(w){
  if(!w)return 0
  var n=Number(w.size)
  return isFinite(n)&&n>0?n:0
}
/** 这张图是不是"大图" —— 决定要不要走"先预览再升清"。
 *  **不能只看 hd 标记**: 标记是按文件名尾部关键字认的, 「高清」目录里那 157 张文件名
 *  不带 _高清/·高清 后缀, hd 全是 false, 但它们单张 15–80MB, 正是最卡的一批。
 *  所以再按文件大小兜一条: >1.5MB 也算大图。 */
function isHeavyWallpaper(w){
  if(!w||!w.url)return false
  return w.hd===true||sizeOfWallpaper(w)>1.5*1024*1024
}
function previewUrlOf(w){
  if(!isHeavyWallpaper(w))return null
  return w.url+'?sz=preview'
}
function largeUrlOf(w){
  if(!w||!w.url)return null
  // 「升清」这档只在"真需要"时才走: 大图要中间档 (host 侧对长边 ≤3840 的原图会直接送
  // 原文件字节), 小图直接原图上屏 —— 没有可省的带宽/解码, 多一跳反而更慢。
  if(PREVIEW_UPGRADE_DIM>0&&isHeavyWallpaper(w))return w.url+'?sz=large'
  return w.url
}
function wallpaperImageFor(w){
  if(!w)return null
  if(decodedWallpaper&&decodedWallpaper.url===w.url)return decodedWallpaper.img
  var large=largeUrlOf(w)
  for(var i=0;i<decodedLarges.length;i++)if(large&&decodedLarges[i].url===large)return decodedLarges[i].img
  return null
}
/** 清晰版解码结果只留最近两张: 一张 3840 档解完约 8–33MB, 无上限会随换图一路攒内存。
 *  留两张是为了"换回去"不用重解, 又不会变成常驻大户。 */
var decodedLarges=[]
function rememberLarge(url,img){
  for(var i=0;i<decodedLarges.length;i++)if(decodedLarges[i].url===url)decodedLarges.splice(i,1)
  decodedLarges.unshift({url:url,img:img})
  if(decodedLarges.length>2)decodedLarges.length=2
}
function forgetLarges(){decodedLarges=[]}

/** 解码一张图, 成功(或"解码不可用但 onload 到了")才把结果交给 commit。
 *  onDone 只在**本次请求仍是最新**且成功后调用 —— 迟到/被顶掉的请求一律静默丢弃。 */
function startDecode(request,url,commit,onDone){
  var img=new Image(),done=false,timer=0
  var job={request:request,img:img,cancel:function(){finish(false,true)}}
  decodeJob=job
  function finish(ok, aborted){
    if(done)return
    done=true
    if(timer){clearTimeout(timer);timer=0}
    img.onload=img.onerror=null
    if(decodeJob===job)decodeJob=null
    var latest=job.request.seq===swapSeq
    if(ok&&latest&&!aborted){
      if(commit)commitWallpaper(job.request,img)
      if(onDone)onDone()
    } else {
      // 显式清空/卸载/换范围时连 src 一并解除，释放加载引用；迟到回调被 done 拦住。
      try{img.src=''}catch(e){}
      if(latest&&!aborted&&commit){pendingStep=null;console.warn('[bg-atelier-plus] 图片未能解码，保留当前底图')}
    }
    if(!aborted)pumpWallpaperRequest()
  }
  img.onload=function(){if(typeof img.decode!=='function')finish(true)}
  img.onerror=function(){finish(false)}
  timer=setTimeout(function(){finish(false)},15000)
  try{img.src=url;if(typeof img.decode==='function')img.decode().then(function(){finish(true)},function(){finish(false)})}catch(e){finish(false)}
}

/** 预览已上屏后, 在后台把清晰版加载/解码好, 只更新底图 URL 与解码缓存 (不重新记录历史、不写盘)。
 *  失败就保留预览 —— 预览只是"更软", 比留深色底好; 不弹错、不打断用户。 */
function upgradeWallpaper(request,url){
  if(!url)return
  var img=new Image(),done=false,timer=0
  var job={request:request,img:img,cancel:function(){finish(false)}}
  upgradeJob=job
  function finish(ok){
    if(done)return
    done=true
    if(timer){clearTimeout(timer);timer=0}
    img.onload=img.onerror=null
    if(upgradeJob===job)upgradeJob=null
    // 作废条件: 加载/解码失败、已进后台、或者"当前选中的已经不是这张图"。
    // **不比 swapSeq**: 预览一提交, 插件自己那条 commit→subscribe→cancelWallpaperRequest
    // 链路就会把 swapSeq 推一格 (实测 reqseq=4 / now=5), 于是清晰版每次都被判成"过期"丢掉,
    // 结果是预览铺上去了、清晰版永远不换 —— 用户看到的还是那层发软的图。
    // 换图时真正要防的是"这张清晰版盖到别的图上", 那句话由 wallpaper.url 的比较来说。
    var current=STORE.state.wallpaper
    if(!ok||wallpaperBackgrounded()||!current||current.url!==request.wallpaper.url){
      try{img.src=''}catch(e){}
      return
    }
    // **不改 STORE.state.wallpaper.url**: 那个 url 是"选中哪张图"的身份, 历史/图单/比较都用它。
    // 只把"屏幕上正在画的那一版"换成清晰版 (renderedBgUrl/rebuildBackground 都读它)。
    shownUrl=url
    shownFrame=framingForUrl(STORE.state,url)
    rememberLarge(url,img)
    if(paintBackground)paintBackground()
  }
  img.onload=function(){finish(true)}
  img.onerror=function(){finish(false)}
  timer=setTimeout(function(){finish(false)},15000)
  try{img.src=url;if(typeof img.decode==='function')img.decode().then(function(){finish(true)},function(){finish(false)})}catch(e){finish(false)}
}

function fetchList() {
  return fetch('/bga/wallpapers.json', { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status)
      return r.json()
    })
    .then(function (res) {
      var cats = (res && res.categories) || []
      var flat = []
      var enriched = []
      for (var c = 0; c < cats.length; c++) {
        var cat = cats[c]
        var catName = (cat && cat.name) || '未分类'
        var rawItems = (cat && cat.items) || []
        var items = []
        for (var i = 0; i < rawItems.length; i++) {
          var it = hydrateItem(rawItems[i], catName)
          items.push(it)
          flat.push(it)
        }
        enriched.push({
          name: catName,
          count: items.length,
          hd: 0,
          items: items,
        })
        for (var h = 0; h < items.length; h++) if (items[h].hd) enriched[enriched.length - 1].hd++
      }
      STORE.categories = enriched
      STORE.list = flat
      STORE.listDir = (res && res.dir) || ''
      STORE.writableDir = (res && res.writableDir) || ''
      STORE.skipped = (res && res.skipped) || []
      STORE.total = flat.length
      rehydrateWallpaper()
      return STORE.list
    })
}

// 持久化的旧选择可能只存了 url/name (旧版根目录图, 甚至乱码文件名)。
// 拉完最新清单后按 url / 文件名对回条目, 给当前底图补上类型/编号/高清等字段。
function rehydrateWallpaper() {
  var w = STORE.state.wallpaper
  if (!w || !STORE.list.length) return
  if (w.id && w.name) return
  var dec = null
  if (w.url) {
    try { dec = decodeURIComponent(String(w.url).split('/').pop() || '') } catch (e) { /* ignore */ }
  }
  var hit = null
  for (var i = 0; i < STORE.list.length; i++) {
    var it = STORE.list[i]
    if (w.url && it.url === w.url) { hit = it; break }
    if (!hit && dec && it.file === dec) { hit = it }
  }
  if (hit) setWallpaper(hit,{automatic:true})
}

// 持久化的旧选择可能只存了 url/name (旧版根目录图, 甚至乱码文件名)。
// 拉完最新清单后按 url / 文件名对回条目, 给当前底图补上类型/编号/高清等字段。
function rehydrateWallpaper() {
  var w = STORE.state.wallpaper
  if (!w || !STORE.list.length) return
  if (w.id && w.name) return
  var dec = null
  if (w.url) {
    try { dec = decodeURIComponent(String(w.url).split('/').pop() || '') } catch (e) { /* ignore */ }
  }
  var hit = null
  for (var i = 0; i < STORE.list.length; i++) {
    var it = STORE.list[i]
    if (w.url && it.url === w.url) { hit = it; break }
    if (!hit && dec && it.file === dec) { hit = it }
  }
  if (hit) setWallpaper(hit,{automatic:true})
}

// ---- 当前范围内换图：按图单顺序循环，或轮次式 2/3 不重复随机 ----
// 随机规则: 每轮从当前范围里随机抽出 ceil(2/3 × 总数) 张排成随机序列
// 逐张播放; 同一轮内绝不重复 (即至少播完约 2/3 之后才可能出现重复)。一轮放完
// "放回"再从总体随机取 2/3 开新一轮。换轮衔接处只避免与上一轮最后一张紧挨着。
// 池子 (新增/删除图) 变化时自动重新洗一轮。每张图按 类型+文件名 有稳定 id,
// 重复判定基于 id, 不改变任何显示名。
var cycleDeck = []
var cycleSig = ''
var cycleTail = []   // 最近播过的若干 id, 用于换轮衔接时避免刚播完又马上出现

function buildCycleDeck(ids) {
  var n = ids.length
  var m = Math.max(1, Math.min(n, Math.ceil(n * 2 / 3)))
  var arr = ids.slice()
  for (var i = 0; i < m; i++) {
    var j = i + Math.floor(Math.random() * (n - i))
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  var deck = arr.slice(0, m)
  // 换轮衔接: 新轮开头尽量避开上一轮末尾刚播过的几张 (已播的放到本轮靠后位置)。
  if (cycleTail.length) {
    var head = 0
    while (head < deck.length && cycleTail.indexOf(deck[head]) >= 0) head++
    if (head > 0) {
      var offenders = deck.splice(0, head)
      for (var o = 0; o < offenders.length; o++) deck.push(offenders[o])
    }
  }
  return deck
}

function cycleWallpaper(options) {
  if (wallpaperBackgrounded() || weIsBackground()) return
  var epoch = wallpaperEpoch
  var timing=options&&options.automatic===true ? normalFadeTiming() : manualFadeTiming()
  if(historyStep(1,timing))return
  function step(items) {
    if (epoch !== wallpaperEpoch || wallpaperBackgrounded() || weIsBackground()) return
    items = sourceItems(STORE.state.playbackSource, items)
    if (!items.length) return
    var cur = STORE.state.wallpaper
    var currentId=pendingStep?pendingStep.id:cur&&cur.id
    if(STORE.state.playbackMode==='ordered'){
      var at=items.findIndex(function(it){return it.id===currentId})
      setWallpaper(items[(at+1)%items.length],{source:STORE.state.playbackSource,timing:timing});return
    }
    var byId = {}
    var ids = []
    for (var i = 0; i < items.length; i++) {
      byId[items[i].id] = items[i]
      ids.push(items[i].id)
    }
    var sig = STORE.state.playbackSource + '\u0001' + ids.slice().sort().join('\u0001') + '\u0001' + ids.length
    if (!cycleDeck.length || sig !== cycleSig) {
      cycleDeck = buildCycleDeck(ids)
      cycleSig = sig
    }
    var picked = null
    for (var guard = 0; guard < 2 && !picked; guard++) {
      while (cycleDeck.length) {
        var id = cycleDeck.shift()
        if (currentId === id) continue   // 不与当前选择或正在解码的同张
        var it = byId[id]
        if (!it) continue
        picked = it
        break
      }
      if (!picked) { cycleDeck = buildCycleDeck(ids); cycleSig = sig }
    }
    if (!picked && items.length === 1) picked = items[0]  // 全池仅一张时退化
    if (!picked) return
    cycleTail.push(picked.id)
    while (cycleTail.length > 12) cycleTail.shift()
    setWallpaper(picked,{source:STORE.state.playbackSource,timing:timing})
  }
  if (STORE.list.length) { step(STORE.list); return }
  fetchList().then(step).catch(function (e) {
    console.error('[bg-atelier-plus] cycle failed: ' + String(e))
  })
}

// ---- 自动切换 (v1.10.0): 间隔 1..120 分钟; v1.11.0 起是 AUTO_STOPS 那 14 个**不平均**档位 ----
// 定时器只有一根、在模块作用域。**为什么带 signature**: 改个暗纱/配色也会走 STORE 监听,
// 若监听里无条件重起定时器, 间隔就永远走不满(每隔几秒动一下滑块就归零)。signature = 开关 + 间隔。
// 但**换图**是另一回事(v1.11.0 改): 上一次换图之后就重新起表 —— 手动换到满意的那张时,
// 不会正好撞上刚走完的旧表被自动切换立刻换走(用户 2026-09-28 报的"我换到满意的又给我闪走")。
var autoTimer = 0
var autoSig = ''
var autoGeneration = 0
var wallpaperSuspended = false
var wallpaperEpoch = 0

function wallpaperBackgrounded() {
  return wallpaperSuspended || (typeof document !== 'undefined' && document.hidden === true)
}

// 后台的 rAF/解码/定时器可以各自停在不同位置。丢弃未上屏工作，收拢到最后一张
// 已成功提交的图；恢复时只重画这一张、重新计时，绝不补播离开期间的次数。
function suspendWallpapers(suspended) {
  if (wallpaperSuspended === suspended) return
  wallpaperSuspended = suspended
  wallpaperEpoch++
  cancelWallpaperRequest()
  if (suspended) forgetLarges()   // 进后台就把清晰版缓存放掉: 它只是"少解一次"的加速, 不是必需品
  fadeStop()
  lastManualFadeAt = null
  selectionFade = null
  shownUrl = bgUrlOnScreen(STORE.state)
  shownFrame = framingForUrl(STORE.state, shownUrl)
  if (paintBackground) paintBackground(!suspended)
  armAuto(true)
}

function watchWallpaperVisibility() {
  var hidden = function () { suspendWallpapers(true) }
  var visible = function () { suspendWallpapers(document.hidden === true || (typeof document.hasFocus === 'function' && !document.hasFocus())) }
  document.addEventListener('visibilitychange', visible)
  document.addEventListener('freeze', hidden)
  document.addEventListener('resume', visible)
  if (window.addEventListener) {
    window.addEventListener('blur', hidden)
    window.addEventListener('focus', visible)
    window.addEventListener('pagehide', hidden)
    window.addEventListener('pageshow', visible)
  }
  visible()
  return function () {
    document.removeEventListener('visibilitychange', visible)
    document.removeEventListener('freeze', hidden)
    document.removeEventListener('resume', visible)
    if (window.removeEventListener) {
      window.removeEventListener('blur', hidden)
      window.removeEventListener('focus', visible)
      window.removeEventListener('pagehide', hidden)
      window.removeEventListener('pageshow', visible)
    }
    suspendWallpapers(true)
  }
}

/** 间隔档位(分钟), **不平均**刻度。用户 2026-09-28 要求: 1..120 一档一分钟的均匀刻度里,
 *  最常改的 1–10 分钟只占 8% 行程, 拖着点不准; 换成"等距滑杆 + 查表"后每档行程一样宽,
 *  档位本身按手感取(前段密、后段疏)。改这张表 = 改 UI 的全部档位, 别处不用动。 */
var AUTO_STOPS = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120]

/** 升序表里离 v 最近的一档。非有限值取第一档; 等距时取小的那个(结果确定, 不来回跳)。 */
function nearestStop(list, v) {
  var n = Number(v)
  if (!isFinite(n)) return list[0]
  var best = list[0]
  for (var i = 1; i < list.length; i++) if (Math.abs(list[i] - n) < Math.abs(best - n)) best = list[i]
  return best
}

/** 间隔毫秒数。读的时候也吸附一遍: 坏值(NaN/0/越界)会让 setTimeout(fn,NaN) 变成 0ms 死循环换图,
 *  那是刷爆 CPU 与 settings.json 的写法, 不能只靠 UI 滑杆的范围兜底。
 *  坏值兜 30 分钟而不是"最近档 1": 坏值绝不该变成一分钟一换。 */
function autoDelayMs() {
  var m = Number(STORE.state.autoMin)
  if (!isFinite(m)) m = 30
  return nearestStop(AUTO_STOPS, m) * 60000
}

/** 起/停定时器; force=true 时无条件重置(自动换图那一次用, 它自己先把 timer 置了 0)。 */
function armAuto(force) {
  var on = STORE.state.autoOn === true && !wallpaperBackgrounded()
  var sig = on ? String(autoDelayMs()) + ':' + STORE.state.playbackSource : ''
  if (!force && sig === autoSig) return
  autoSig = sig
  var generation = ++autoGeneration
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = 0 }
  if (on) autoTimer = setTimeout(function () { autoTick(generation) }, autoDelayMs())
}


function autoTick(generation) {
  if ((generation !== undefined && generation !== autoGeneration) || wallpaperBackgrounded() || STORE.state.autoOn !== true) return
  autoTimer = 0
  try {
    if (!decodeJob && !queuedSwap && !fadeEl) cycleWallpaper({automatic:true})
  } catch (e) { console.error('[bg-atelier-plus] auto cycle failed: ' + String(e)) }
  armAuto(true)   // 重新起表: 换图失败/池子为空也不该让自动切换悄悄停掉
}

// ---------------------------------------------------------------- 颜色工具 --

function hexRgb(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return { r: 232, g: 140, b: 160 }
  var v = parseInt(m[1], 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

function rgba(c, a) {
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')'
}

function mix(c1, c2, t) {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  }
}

var WHITE = { r: 255, g: 255, b: 255 }
var BLACK = { r: 0, g: 0, b: 0 }

/** 浅色主题的"面"色 = 底图深色往白里提亮到 surfaceTone(s). 提亮比例不算死:
 *  深色底(deep 本来就暗)需要提得更白才够对比, 浅色底只提一点即可 —— 两端都钳在
 *  0.45..0.85, 免得出现"近黑的面"或"又变回白布"。 */
function themeSurfaceTone(sh) {
  return Math.max(0.45, Math.min(0.85, sh && typeof sh.tone === 'number' ? sh.tone : 0.6))
}
/** 设置面板"可读底座"的颜色 (近乎不透明)。**必须算成字面量**再写进插件自己的样式表 ——
 *  早先版本用 `var(--bga-surface-solid)` 走 theme token, 而给 overrideTokens 塞未注册的
 *  token 名会让当前宿主把**整层 override 判废**, 后果是界面 token 全回到默认、底图被盖住
 *  (用户 2026-10-01 报的"壁纸直接不显示")。这里不碰 theme 服务, 自然没这个风险。 */
function settingsSolidColor(s) {
  var deep = hexRgb(s.deep)
  var accent = hexRgb(s.accent)
  var dark = typeof document !== 'undefined' && document.body &&
    document.body.hasAttribute && document.body.hasAttribute('data-ds-dark-theme')
  var base = dark ? mix(deep, accent, 0.06) : mix(deep, WHITE, themeSurfaceTone(s.styles))
  return rgba(base, 0.97)
}
/** 大面积表面(外框/侧栏/会话区)的不透明度。默认 0.30; styles 缺字段时按老 glass 折算
 *  (glass .8 → .30), 这样没写过 styles 的老设置文件不会突然换个观感。 */
function themeSurfaceAlpha(s) {
  var st = s && s.styles
  if (!st || typeof st !== 'object') {
    var glass = Number(s && s.glass)
    if (!isFinite(glass)) glass = 0.8
    return 0.6 - Math.max(0, Math.min(1, glass)) * 0.375    // .8 → .30, 1 → .225
  }
  return stylesNumber(st.surface, 0.30, 0, 0.8)
}

/** 消息气泡阴影 (v1.16.0 新增; v1.16.1 改成"外圈描边", v1.16.2 修回真正的气泡阴影)。
 *
 *  踩过的两个坑, 都写在这儿免得下次再犯:
 *   ① 本机开着 dsh-cache-control 的「清空气泡」⇒ 气泡 `background:transparent`, 直接在气泡上画
 *      box-shadow **看不见**(透明盒子没有轮廓)。所以阴影必须画在一个**有背景**的副本上；
 *   ② 用 `filter:drop-shadow` 会变成"文字阴影"(用户 2026-10-01 明确否掉: 要的是气泡阴影)。
 *
 *  做法: 气泡::before 当描边环 —— 它 `inset:0` + `border-radius` 继承 + 负 z-index 垫在内容底下,
 *  再用 box-shadow 往外扩出阴影。清空气泡时看起来就是"气泡形状的阴影圈", 不清空气泡时是普通卡片阴影。
 *  强度 0 = 整条规则不下发。 */
function bubbleCss(s) {
  var st = (s && s.styles) || {}
  var a = stylesNumber(st.bubble, 0.5, 0, 1)
  if (!a || !s || !s.wallpaper) return ''
  var deep = hexRgb(s.deep)
  var light = 'rgba(' + deep.r + ',' + deep.g + ',' + deep.b + ',' + (0.05 + 0.16 * a).toFixed(3) + ')'
  var dark = 'rgba(0,0,0,' + (0.10 + 0.30 * a).toFixed(3) + ')'
  var hx = (0.4 + 1.6 * a).toFixed(2)   // 横向外扩
  var vy = (0.8 + 2.4 * a).toFixed(2)   // 向下偏移
  var bl = (1.6 + 8 * a).toFixed(2)     // 接触阴影模糊
  var bl2 = (4 + 18 * a).toFixed(2)     // 环境阴影模糊
  var ring =
    'body [class*="_bubble"]{position:relative;box-shadow:0 1px 2px ' + light + ',0 6px 18px ' + dark + '}\n' +
    'body [class*="_bubble"]::before{content:"";position:absolute;z-index:-1;inset:0;' +
    'border-radius:inherit;box-shadow:inset 0 0 0 1px ' + light + ',0 ' + vy + 'px ' + bl + 'px ' + dark + ',0 ' + vy + 'px ' + bl2 + 'px ' + dark + ';' +
    'left:-' + hx + 'px;right:-' + hx + 'px;top:-' + hx + 'px;bottom:-' + hx + 'px}\n' +
    'body[data-ds-dark-theme] [class*="_bubble"]{box-shadow:0 1px 2px rgba(0,0,0,.25),0 8px 22px ' + dark + '}\n'
  return ring
}

// ------------------------------------------------------------ 主题 token 层 --

function buildTokens(s) {
  var accent = hexRgb(s.accent)
  var deep = hexRgb(s.deep)
  // v1.16.0: 浅色主题的面色改成"底图深色提亮"(原来是往纯白 96% 靠 → 整屏一层白布),
  // 面透明度改由 styles.surface 单独控制。深色主题那套值一个字没动。
  var ltint = mix(deep, WHITE, themeSurfaceTone(s.styles))
  var baseA = themeSurfaceAlpha(s)
  var layerA = Math.min(0.85, baseA + 0.06)
  var layer2A = Math.min(0.9, baseA + 0.12)
  var sideA = Math.min(0.95, baseA + 0.05)
  var tokens = {}
  tokens['--dsw-alias-bg-base'] = { light: rgba(ltint, baseA), dark: rgba(deep, baseA) }
  tokens['--dsw-alias-bg-layer-1'] = { light: rgba(ltint, layerA), dark: rgba(mix(deep, accent, 0.05), layerA) }
  tokens['--dsw-alias-bg-layer-2'] = { light: rgba(ltint, layer2A), dark: rgba(mix(deep, accent, 0.09), layer2A) }
  tokens['--dsw-alias-bg-layer-3'] = { light: rgba(ltint, layer2A), dark: rgba(mix(deep, accent, 0.11), layer2A) }
  tokens['--dsw-alias-bg-layer-4'] = { light: rgba(ltint, layer2A), dark: rgba(mix(deep, accent, 0.13), layer2A) }
  tokens['--dsw-alias-bg-module-platform'] = { light: rgba(ltint, layerA), dark: rgba(mix(deep, accent, 0.07), layerA) }
  tokens['--dsw-alias-bg-multi-select'] = { light: rgba(ltint, layerA), dark: rgba(mix(deep, accent, 0.07), layerA) }
  tokens['--dsw-alias-bg-overlay'] = { light: rgba(ltint, 0.95), dark: rgba(mix(deep, BLACK, 0.25), 0.95) }
  tokens['--dsw-alias-border-l1'] = { light: rgba(accent, 0.22), dark: rgba(accent, 0.24) }
  tokens['--dsw-alias-border-l2'] = { light: rgba(accent, 0.38), dark: rgba(accent, 0.42) }
  tokens['--dsw-alias-brand-primary'] = { light: rgba(mix(accent, BLACK, 0.12), 1), dark: rgba(accent, 1) }
  tokens['--dsw-specific-sidebar-fill'] = { light: rgba(ltint, sideA), dark: rgba(deep, sideA) }
  return tokens
}

// -------------------------------------------------------------- 动态样式表 --
// ① 琉璃卡面 (始终生效): 调色板染色半透明 + 背景模糊, 透明度由 cardA 控制
// ② 框缘特效 (按选择): 流萤 / 气泡 / 落樱 / 雨丝 / 关闭

function glassCardCss(s, accent, deep) {
  var a = 0.05 + s.cardA * 0.9                            // 0.05..0.95
  var blur = Math.round(s.cardBlur)
  var creamA = rgba(mix(accent, WHITE, 0.94), a)
  var darkA = rgba(mix(deep, accent, 0.07), a)
  var bd = blur > 0
    ? 'backdrop-filter:blur(' + blur + 'px) saturate(1.2);-webkit-backdrop-filter:blur(' + blur + 'px) saturate(1.2);'
    : ''
  return '' +
    'body [data-composer-card]{background:' + creamA + ';' + bd +
    'border-color:' + rgba(accent, 0.4) + '}\n' +
    'body[data-ds-dark-theme] [data-composer-card]{background:' + darkA + '}\n'
}

function effectCss(s, accent, deep) {
  // 卡面阴影 + 特效辉光，合成**一条** box-shadow（两条同选择器的规则会互相覆盖，
  // 不是叠加，所以必须在这里拼起来一次写完）。
  // 卡面两道阴影（v1.5.2）：接触阴影 0 1px 2px --bga-card-edge 贴边定框、环境阴影
  // 0 10px 28px --bga-card-shade 让卡面像浮在底图上；两个变量由 dynamicCss 按配色写入。
  // v1.5.4 起阴影归 cardShadow 开关、特效辉光归 effect 开关，两者独立拼装 ——
  // 选「关闭」特效时阴影仍然在。
  var parts = []
  if (s.cardShadow !== false) {
    parts.push('0 1px 2px var(--bga-card-edge)')
    parts.push('0 10px 28px var(--bga-card-shade)')
  }
  // 特效各自的主色辉光（「关闭」时没有）
  if (s.effect === 'firefly') parts.push('0 0 20px ' + rgba(accent, 0.18))
  else if (s.effect === 'bubble') parts.push('0 0 26px ' + rgba(accent, 0.22), '0 0 64px ' + rgba(accent, 0.1))
  else if (s.effect === 'petal') parts.push('0 0 22px ' + rgba(accent, 0.18))
  else if (s.effect === 'rain') parts.push('0 0 24px ' + rgba(accent, 0.16))
  if (!parts.length) return ''
  return 'body [data-composer-card]{box-shadow:' + parts.join(',') + '}\n'
}

function dynamicCss(s, withoutBackground) {
  var accent = hexRgb(s.accent)
  var deep = hexRgb(s.deep)
  var css = ':root{\n' +
    '  --bga-accent:' + s.accent + ';\n' +
    '  --bga-accent-soft:' + rgba(accent, 0.45) + ';\n' +
    '  --bga-accent-faint:' + rgba(accent, 0.16) + ';\n' +
    '  --bga-deep-glow:' + rgba(mix(deep, accent, 0.25), 0.5) + ';\n' +
    // 卡面辨识用的两道阴影 (由 effectCss 用): 深色、低浓度。
    '  --bga-card-shade:' + rgba(mix(deep, accent, 0.12), 0.3) + ';\n' +
    '  --bga-card-edge:' + rgba(deep, 0.34) + ';\n' +
    '}\n'
  if (s.wallpaper) {
    // WE 动效层接管背景时不再画底图: 两者同在根层叠上下文, 底图(-1)会盖住动效层(-2),
    // 所以这里跳过底图那两条规则（卡面染色照旧, 见下）。
    if (!withoutBackground) css += backgroundCss(s, s.wallpaper.url)
    css += glassCardCss(s, accent, deep)
  }
  // 卡面染色只在"有底图"时才加，但**特效与阴影不要求有底图**（解耦, 原因见 DockFx 注释）；
  // 阴影有自己的开关, 选「关闭」特效时这条规则仍要写出来。
  css += effectCss(s, accent, deep)
  return css
}
function backgroundCss(s, url, frame) {
  if (!url || hasWeVisual()) return ''
  var deep = hexRgb(s.deep)
  return 'body{background-color:' + s.deep + '}\n' +
    bgLayerCss('body::before', Object.assign({},s,frame||framingForUrl(s,url)), url, rgba(deep, s.veil) + ',' + rgba(deep, s.veil * 0.55))
}

/** 两层共用 cover 绘制配方；调用方传入各自图片的缩放和焦点，旧层保留切换前的构图。 */
function bgLayerCss(sel, s, url, veil) {
  var zoom = Math.max(1, Math.min(2.2, s.zoom || 1))
  return sel + '{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;' +
    'background-image:linear-gradient(' + veil + '),url("' + url + '");' +
    'background-size:cover;background-repeat:no-repeat;background-position:' + s.focus + ';' +
    'transform:scale(' + zoom.toFixed(2) + ');transform-origin:' + s.focus + '}\n'
}

// ------------------------------------------------ 渐变切换 (v1.10.0, 全局) --
// 「换图时上一张淡出、新图露出」。**全局生效**的手段是"只接一个口": 点图卡、侧栏宝珠随机、
// 自动切换最终都走到 STORE → apply 里那个 subscribe, 所以那里挂一次就全覆盖, 各换图处一行不改。
// 做法: 把上一张画在 body::after(伪元素顺序保证它在 ::before 之上 = 新图之上), 下一帧把它的
// opacity 过渡到 0。两层都是 position:fixed ⇒ 不会撑大任何祖先的 scrollWidth, v1.4.2 那条
// 「对话区横向滚动条不许被顶出来」的约束照旧安全。
// v1.11.0: 时长与「响应时间」都从设置里读 —— 响应时间 = 换图后旧图**原样**多盖一会儿(wait>0 时
// 先只插层不动它), 到点才开始淡出。
var fadeEl = null
var fadeWaitTimer = 0    // 起手延迟那一段(响应时间)
var fadeTimer = 0        // 看它淡完没 / 拆层
var fadeBusyTimer = 0    // 这一层"还在动"的截止时刻(插入后 wait+dur): 只在没有 getComputedStyle 的地方退化用
var fadeBusy = false
var fadeMotion = null
var lastManualFadeAt = null
var selectionFade = null
// STORE 是最后一次选择；shownUrl 是正在淡入的图。连点只能更新 nextUrl，
// 不能直接改 ::before：半透明旧图下面换图仍然是一次可见的硬切。
var shownUrl = null
var shownFrame = null
var nextUrl = null
var nextFade = null
var paintBackground = null

function renderedBgUrl() {
  return shownUrl === null ? bgUrlOnScreen(STORE.state) : shownUrl
}
function renderedBgFrame() {
  var url=renderedBgUrl()
  if(!shownFrame || (STORE.state.wallpaper&&STORE.state.wallpaper.url===url)) shownFrame=framingForUrl(STORE.state,url)
  return shownFrame
}

function reducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 这一层此刻是否还看得见(computed opacity > 0)。**不许只信墙钟**: 换大图时主线程会被
 *  "上万像素的图重新上屏"卡住(本机实测 long task 504ms、rAF 停 ~0.9s), 过渡的起手随之推迟 ——
 *  按插入时刻 + 时长就摘层, 会在它还剩 0.3 不透明度时把层摘掉, 屏幕上就是**闪变**(用户报的"卡没渐变")。 */
function fadeVisible() {
  if (!fadeEl) return false
  if (typeof getComputedStyle !== 'function') return fadeBusy
  try {
    var cs = getComputedStyle(document.body, '::after')
    return cs.content !== 'none' && Number(cs.opacity) > 0.001
  } catch (e) { return fadeBusy }
}

/** 看不见了才拆层，然后从刚淡入的图继续渐变到最新选择。 */
function fadeSweep() {
  if (!fadeEl) { fadeTimer = 0; return }
  if (!fadeVisible()) {
    var queued = nextUrl, timing = nextFade
    fadeStop()
    if (queued !== null && queued !== shownUrl) {
      switchFade(shownUrl, queued, timing)
      if (paintBackground) paintBackground()
    }
    pumpWallpaperRequest()
    return
  }
  scheduleFadeSweep(100)
}

function scheduleFadeSweep(ms) {
  var layer = fadeEl
  fadeTimer = setTimeout(function () { if (fadeEl === layer) { fadeTimer = 0; fadeSweep() } }, ms)
}

/** 渐变时长 ms。坏值兜 900(默认手感), 并钳到 100..5000 —— 0 会让 transition 变成一个 tick 的硬切。
 *  上限 5000 是"够慢还能看"的位置: 再长就是两张图长时间叠在一起, 调到这个数就够判断了。 */
function fadeDurMs(s) {
  var v = Number(s.fadeMs)
  if (!isFinite(v)) return 900
  return Math.max(100, Math.min(5000, Math.round(v)))
}

// 点击节奏只影响本次播放，不修改用户设定或保存文件；自动切换/恢复不参加计频。
function adaptiveFadeMs(s, gap) {
  var base=fadeDurMs(s)
  if(gap===null || !isFinite(gap) || gap<0 || gap>=1500)return base
  return Math.min(base,gap>=800?1000:gap>=400?500:300)
}
function normalFadeTiming() { return {duration:fadeDurMs(STORE.state),wait:fadeWaitMs(STORE.state)} }
function manualFadeTiming() {
  var now=typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now()
  var gap=lastManualFadeAt===null?null:now-lastManualFadeAt
  lastManualFadeAt=now
  var rapid=gap!==null&&gap>=0&&gap<1500
  var timing={duration:adaptiveFadeMs(STORE.state,gap),wait:rapid?0:fadeWaitMs(STORE.state)}
  if(rapid&&STORE.state.fadeOn!==false&&!reducedMotion())accelerateFade(timing.duration)
  return timing
}

function armFadeTimers(ms) {
  if(fadeBusyTimer)clearTimeout(fadeBusyTimer)
  if(fadeTimer)clearTimeout(fadeTimer)
  fadeBusy=true
  var layer=fadeEl
  fadeBusyTimer=setTimeout(function(){if(fadeEl===layer){fadeBusyTimer=0;fadeBusy=false}},ms)
  scheduleFadeSweep(ms+50)
}
function writeFadeOpacity(motion, opacity, transition) {
  var layer=motion.layer
  if(layer.sheet&&layer.sheet.cssRules[1]){
    layer.sheet.cssRules[1].style.transition=transition
    layer.sheet.cssRules[1].style.opacity=String(opacity)
  }else layer.textContent=motion.base+'body::after{opacity:'+opacity+';transition:'+transition+'}'+motion.rest
}
function activeFadeAnimation() {
  if(typeof document==='undefined'||!document.body||typeof document.body.getAnimations!=='function')return null
  return document.body.getAnimations({subtree:true}).find(function(a){
    return a.transitionProperty==='opacity'&&a.effect&&a.effect.target===document.body&&a.effect.pseudoElement==='::after'&&a.playState!=='finished'&&a.playState!=='idle'
  })||null
}
function accelerateFade(ms) {
  var motion=fadeMotion
  if(!motion||fadeEl!==motion.layer)return
  // 快点时不再等“开始前等待”；同一档连点不重启、不延长已加速的动画。
  if(fadeWaitTimer){clearTimeout(fadeWaitTimer);fadeWaitTimer=0;motion.duration=Math.min(ms,motion.duration);motion.start();return}
  if(ms>=motion.duration)return
  motion.duration=ms
  if(!motion.started)return // 已排好的首帧会读取最新时长
  try{
    var animation=activeFadeAnimation()
    if(animation&&typeof animation.updatePlaybackRate==='function'){
      var span=Number(animation.effect.getComputedTiming().duration)
      var rate=span/Math.max(1,ms*motion.distance)
      if(isFinite(rate)&&rate>0){
        // 同步合成线程上的播放位置后改速度，避免重设起点造成闪回。
        animation.updatePlaybackRate(rate)
        armFadeTimers(Math.max(0,span-Number(animation.currentTime||0))/rate)
        animation.finished.then(function(){if(fadeMotion===motion&&fadeEl===motion.layer){if(fadeTimer)clearTimeout(fadeTimer);fadeTimer=0;fadeSweep()}},function(){})
        return
      }
    }
  }catch(e){/* 旧运行时退回到保留当前透明度的 CSS 过渡。 */}
  if(typeof getComputedStyle!=='function')return
  var opacity=Number(getComputedStyle(document.body,'::after').opacity)
  if(!isFinite(opacity))return
  if(opacity<=0.001){fadeSweep();return}
  if(fadeBusyTimer){clearTimeout(fadeBusyTimer);fadeBusyTimer=0}
  if(fadeTimer){clearTimeout(fadeTimer);fadeTimer=0}
  motion.distance=Math.max(0,Math.min(1,opacity));motion.started=false
  writeFadeOpacity(motion,motion.distance,'none')
  getComputedStyle(document.body,'::after').opacity // 提交同一透明度的起点，不退回 1
  motion.start()
}

/** 响应时间 ms(开始淡出前先等多久)。坏值兜 0 = 不延迟, 与 v1.10.0 行为一致。
 *  钳制范围与滑杆一致(0..1000): 手改 settings.json 塞个 3000 时, 滑杆上也得能指到那个位置。 */
function fadeWaitMs(s) {
  var v = Number(s.fadeDelayMs)
  if (!isFinite(v)) return 0
  return Math.max(0, Math.min(1000, Math.round(v)))
}

function fadeStop() {
  if (fadeWaitTimer) { clearTimeout(fadeWaitTimer); fadeWaitTimer = 0 }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = 0 }
  if (fadeBusyTimer) { clearTimeout(fadeBusyTimer); fadeBusyTimer = 0 }
  fadeBusy = false
  fadeMotion = null
  nextUrl = null
  nextFade = null
  if (fadeEl) { if (fadeEl.parentNode) fadeEl.parentNode.removeChild(fadeEl); fadeEl = null }
}

function fadeRun(s, prevUrl, prevFrame, timing) {
  if (typeof document === 'undefined' || !document.head || !prevUrl) return
  // 连点护栏(v1.11.0 修): 这一层**还看得见**就别拆它、也别再插一层。
  // 拆了重来插的那层画的是同一张旧图, 但它是从 opacity:1 重新开始的 —— 而屏幕上那一刻
  // 是"旧图 × 当前透明度"(可能已经是 0.4), 于是画面先闪回全不透明、再从头淡一趟。
  // 连点时每次点击都这么闪一下 + 倒计时归零 ⇒ 看着就像渐变没生效、点的图迟迟不出现。
  // switchFade 同时冻结 ::before，等本段淡完才接上最后一次选择。
  if (fadeEl && fadeVisible()) return
  fadeStop()
  var dur = timing?timing.duration:fadeDurMs(s), wait = timing?timing.wait:fadeWaitMs(s)
  var d = hexRgb(s.deep)
  var base = bgLayerCss('body::after', Object.assign({},s,prevFrame||framingForUrl(s,prevUrl)), prevUrl, rgba(d, s.veil) + ',' + rgba(d, s.veil * 0.55))
  // 关掉动画偏好的人: 两条目标值之间没有 transition ⇒ 直接切, 不留一段糊影。
  var rest = '@media (prefers-reduced-motion:reduce){body::after{transition:none}}'
  var layer = document.createElement('style')
  layer.setAttribute('data-bg-atelier-fade', '1')
  // 接续下一段时，::after 仍可能保留上一段的 computed opacity=0。
  // 起点必须禁用 transition，否则 0→1 会反向动画，先露出新图再闪回旧图。
  layer.textContent = base + 'body::after{opacity:1;transition:none}' + rest
  document.head.appendChild(layer)
  fadeEl = layer
  fadeBusy = true
  var motion={layer:layer,base:base,rest:rest,duration:dur,distance:1,started:false,startQueued:false,start:null}
  fadeMotion=motion
  // 两次 rAF 确保起点先画过一帧。计时从终点提交后才开始，主线程卡顿不能吃掉渐变时间。
  var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16) }
  // `fadeEl !== layer` 是连换两次的护栏: 迟到的回调只许动自己那一层, 不许把新层提前推进终点帧。
  var flip = function () {
    if (fadeEl !== layer || motion.startQueued) return
    motion.startQueued=true
    raf(function () {
      if (fadeEl !== layer) return
      raf(function () {
        if (fadeEl !== layer) return
        motion.startQueued=false;motion.started=true
        var duration=Math.max(1,Math.round(motion.duration*motion.distance))
        // 只改 opacity 的声明，不重建过渡样式表。
        writeFadeOpacity(motion,0,'opacity '+duration+'ms '+(motion.distance===1?'ease':'linear'))
        armFadeTimers(duration)
      })
    })
  }
  motion.start=flip
  if (wait > 0) {
    fadeWaitTimer = setTimeout(function () { if (fadeEl !== layer) return; fadeWaitTimer = 0; flip() }, wait)
  } else { flip() }
}

/** 屏幕上的底图**换了**之后要做的事（从订阅里抽出来：离线套件跑不到那个 effect，抽出来才测得到）。
 *  ① 只在"图 → 图"时过渡 —— 从无到有、清空底图、WE 接管/退出时旧图并不在屏幕上，淡它没意义；
 *  ② 重起自动切换的表：间隔从**这一次换图**算起（谁换的都算），手动换到满意的那张就不会
 *     正好撞上刚走完的旧表被自动切换立刻换走。 */
function switchFade(prevUrl, url, timing) {
  timing=timing||(selectionFade&&selectionFade.wallpaper===STORE.state.wallpaper&&selectionFade.wallpaper.url===url?selectionFade.timing:normalFadeTiming())
  if (shownUrl === null) { shownUrl = prevUrl;shownFrame=framingForUrl(STORE.state,prevUrl) }
  if (wallpaperBackgrounded() || !url || !shownUrl || STORE.state.fadeOn === false || reducedMotion()) {
    fadeStop()
    shownUrl = url
    shownFrame = framingForUrl(STORE.state,url)
    if(!url){lastManualFadeAt=null;selectionFade=null}
  } else if (fadeVisible()) {
    nextUrl = url === shownUrl ? null : url
    nextFade = nextUrl===null?null:timing
  } else {
    fadeStop()
    if (shownUrl !== url) fadeRun(STORE.state, shownUrl, shownFrame, timing)
    shownUrl = url
    shownFrame = framingForUrl(STORE.state,url)
  }
  armAuto(true)
}

/** 此刻**真的画在屏幕上**的底图 url; 没底图或 WE 动效层接管时为空(那时旧图并不在屏幕上, 淡它没意义)。*/
function bgUrlOnScreen(s) {
  if (!s.wallpaper || hasWeVisual()) return ''
  return s.wallpaper.url
}

// -------------------------------------------------------------- 静态样式表 --

// 粒子按序号**确定性**生成 CSS: prand 对同一个 i 永远给同一个值, 所以换配色/换壁纸
// 重建整张静态样式表时萤点不会乱跳 (这里绝对不能用 Math.random)。
function prand(i) { var x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }

/**
 * 把 n 个粒子的横向位置**均匀铺**在 [lo, hi]% 区间上：先分成 n 个等宽格子、每格放一个，
 * 格内再抖一点(≤±40% 格宽)。`prand` 本身是均匀分布，但均匀分布**不等于看起来均匀** ——
 * 样本一少（14、30 个）就必然出现"两点挨在一起、旁边一大片空着"的成团现象（泊松成团）。
 * 等分格子能保证任意一小段里的期望个数恒定，随机感靠抖动保留。
 * 端点安全：i=n-1 时基准 = lo + slot×(n-0.5)，加抖动也不会越过 hi（实测见 tools/extract-real-css.mjs）。
 */
function spread(i, n, lo, hi, seed) {
  var slot = (hi - lo) / n
  return lo + slot * (i + 0.5) + (prand(seed) - 0.5) * slot * 0.8
}

// 漂移方向**按位置选**（v1.4.2）：画布左半区的萤只向右漂，右半区只向左漂。
// 为什么必须这样：画布加了 overflow:clip 治「横向滚动条频闪」（见 staticCss() 里
// .bga-dockfx-in 的注释），粒子一旦飘出画布边缘就会被硬切一刀；按位置选方向后，
// 可见行程（含 reverse）全落在画布内，观感与从前一致而不再切边。
var WANDERS_R = ['bga-wander1', 'bga-wander2']
var WANDERS_L = ['bga-wander1L', 'bga-wander2L', 'bga-wander3']

function flyRules(n) {
  var out = []
  for (var i = 0; i < n; i++) {
    var leftN = 1 + prand(i + 1) * 97
    var left = leftN.toFixed(1)
    // v1.16.5: 纵向位置改成**画布高度的百分比**（原来写死 4~46px）：卡面长高后粒子跟着铺满，
    // 不然全挤在底部一小条、上面仍是空的。90px 画布下的落点与旧版一致。
    var bottom = (4 + prand(i + 31) * 42).toFixed(1) + '%'
    var size = 3 + Math.round(prand(i + 61) * 4) * 0.5
    var dur = 8 + Math.round(prand(i + 91) * 10)
    var delay = (prand(i + 121) * 12).toFixed(1)
    var tail = i % 4 === 3 ? ' reverse' : ''
    var pool = leftN >= 50 ? WANDERS_L : WANDERS_R
    out.push('.bga-fly.f' + (i + 1) + '{left:' + left + '%;bottom:' + bottom + ';width:' + size + 'px;height:' + size +
      'px;animation:' + pool[i % pool.length] + ' ' + dur + 's linear infinite ' + delay + 's' + tail + '}')
  }
  return out
}

function starRules(n) {
  var out = []
  for (var i = 0; i < n; i++) {
    var left = (3 + prand(i + 201) * 94).toFixed(1)
    var bottom = (45 + prand(i + 231) * 38).toFixed(1) + '%'
    var size = 2.5 + Math.round(prand(i + 261) * 2) * 0.5
    var dur = (2.2 + prand(i + 291) * 2.4).toFixed(1)
    var delay = (prand(i + 321) * 4).toFixed(1)
    out.push('.bga-star.s' + (i + 1) + '{left:' + left + '%;bottom:' + bottom + ';width:' + size + 'px;height:' + size +
      'px;animation:bga-twinkle ' + dur + 's ease-in-out infinite ' + delay + 's}')
  }
  return out
}

function bubRules(n) {
  var out = []
  for (var i = 0; i < n; i++) {
    var left = (2 + prand(i + 401) * 95).toFixed(1)
    var bottom = (4.4 + prand(i + 431) * 20).toFixed(1) + '%'
    var size = 7 + Math.round(prand(i + 461) * 15)          // 7~22px
    var dur = 5.2 + prand(i + 491) * 5                      // 升得更快, 一屏里同时在飞的多
    // **负延迟**（v1.5.3）：切换瞬间气泡已在行程中途, 不会带着边框实心停在底部"等发车";
    // 配合下面 .bga-bub 的 opacity:0 双保险。
    var delay = -(prand(i + 521) * dur).toFixed(1)
    out.push('.bga-bub.b' + (i + 1) + '{left:' + left + '%;bottom:' + bottom + ';width:' + size + 'px;height:' + size +
      'px;animation-duration:' + dur.toFixed(1) + 's;animation-delay:' + delay + 's}')
  }
  return out
}

// ================= 画布宽度 → 粒子数量（数量随屏宽，密度不随屏宽） =================
// 每个特效定义一个**间距**（多少 px 一颗），数量 = round(画布宽 / 间距)，再夹进上下限。
// 间距按"本机画布 985px 下复核过的数量"折算：流萤 54.7px/颗、星与气泡与落樱 70.4、雨丝 22.4。
//
// v1.16.1（用户 2026-10-01「可能要合理微调成密度」）：
//   · 画布现在跟**输入框卡面**同宽（见 syncCanvasWidth），而卡面宽度 = 会话列 × 72%；
//     会话页宽度可调 ⇒ 卡面 600–4000px 都可能出现，密度必须自己撑住。
//   · 原来那个 `max` 是"最多几颗"的硬顶（40/30/26/30/90），是按 985px 画的，屏一宽密度就掉。
//     现在改成**自适应步长**：超过基准宽度后每多 step×0.75 才多一颗，长边略微摊薄（防 4K 压帧），
//     但不再有硬顶；min 只防"画布太小只剩两三颗"。
var CANVAS_W = 985
var DENSITY = {
  fly:   { per: 54.7, min: 6,  step: 41 },
  star:  { per: 70.4, min: 4,  step: 53 },
  bub:   { per: 70.4, min: 5,  step: 53 },
  petal: { per: 70.4, min: 4,  step: 53 },
  rain:  { per: 22.4, min: 10, step: 17 },
}
function countFor(kind) {
  var d = DENSITY[kind]
  var base = CANVAS_W >= 985
    ? 985 / d.per + (CANVAS_W - 985) / (d.step * 0.75)   // 宽了: 每 step×0.75 加一颗
    : Math.max(1, CANVAS_W / d.step)                     // 窄了: 按 step 摊
  return Math.max(d.min, Math.round(base))
}

// 规则数组是**可重建**的：画布宽度一变就按新数量重算（数量同时决定 CSS 规则条数与 DockFx 的节点数）。
var FLY_RULES = [], STAR_RULES = [], BUB_RULES = [], PETAL_RULES = [], RAIN_RULES = []
function regenerateParticles() {
  FLY_RULES = flyRules(countFor('fly'))
  STAR_RULES = starRules(countFor('star'))
  BUB_RULES = bubRules(countFor('bub'))
  PETAL_RULES = petalRules(countFor('petal'))
  RAIN_RULES = rainRules(countFor('rain'))
}
regenerateParticles()

// ---- v1.5.2 定稿留下的两条粒子特效 (同一套 prand 确定性生成, 同样不许用 Math.random) ----
// 每个 for 里的 left 区间都按 **最宽画布 (会话列宽 3840 ⇒ 画布 3872px)** 之外的常态宽度算过，
// 并留出"粒子自身尺寸 + 模糊外扩"的余量，保证行程不越出画布右缘
// （越界就会顶大会话区的 scrollWidth ⇒ 横向滚动条频闪，见 tools/verify-dockfx-bounds.mjs）。

/** 落樱：小花瓣下落 + 横摆。left 走 spread() 等分格子防泊松成团；
 *  尺寸 5–8px、985px 画布下 14 片 —— "多了叶子、不是变密了"（视觉铺满感反而约 -27%）。 */
function petalRules(n) {
  var out = []
  for (var i = 0; i < n; i++) {
    var left = spread(i, n, 4, 92, i + 601).toFixed(1)
    var w = 5 + Math.round(prand(i + 611) * 3)
    var dur = 9 + Math.round(prand(i + 621) * 6)
    var delay = (prand(i + 631) * 11).toFixed(1)
    var dx = Math.round(-26 + prand(i + 641) * 52)
    out.push('.bga-ptl i.p' + (i + 1) + '{left:' + left + '%;width:' + w + 'px;height:' + (w + 2) +
      'px;--bga-dur:' + dur + 's;--bga-delay:' + delay + 's;--bga-dx:' + dx + 'px}')
  }
  return out
}

/** 雨丝：细斜雨丝下落。left 走 spread() 等分格子（局部挤成一簇 = 泊松成团，不是数量问题）；
 *  985px 画布下 44 条、落速 0.85–1.5s（行程 110px）。粗细 1px、跨度不动。 */
function rainRules(n) {
  var out = []
  for (var i = 0; i < n; i++) {
    var left = spread(i, n, 4, 96, i + 701).toFixed(1)
    var h = 14 + Math.round(prand(i + 711) * 16)
    var dur = (0.85 + prand(i + 721) * 0.65).toFixed(2)
    // 负延迟：切到雨丝特效的瞬间就已经满屏在下，不需要等 0–3s 才逐条开始
    var delay = -(prand(i + 731) * 1.5).toFixed(2)
    out.push('.bga-rn i.r' + (i + 1) + '{left:' + left + '%;height:' + h + 'px;--bga-dur:' + dur + 's;--bga-delay:' + delay + 's}')
  }
  return out
}

// 样式表改成**函数**：数量随画布宽度变，所以每次重建都要重新读一遍上面的数组（它们在
// 末尾用 ...FLY_RULES 这类展开进来的）。画布宽变化时由 rebuildStatic() 重新插入一份。
function staticCss() {
  return [
  '@property --bga-a{syntax:"<angle>";initial-value:0deg;inherits:false}',
  '@keyframes bga-spin{to{--bga-a:360deg}}',
  '@keyframes bga-breathe{50%{opacity:0.45}}',
  '@keyframes bga-twinkle{0%,100%{transform:scale(0.7);opacity:0.35}50%{transform:scale(1.15);opacity:0.95}}',
  '@keyframes bga-wander1{0%{opacity:0;transform:translate(0,0)}10%{opacity:0.9}45%{opacity:0.7;transform:translate(130px,-14px)}80%{opacity:0.9}100%{opacity:0;transform:translate(260px,-2px)}}',
  '@keyframes bga-wander2{0%{opacity:0;transform:translate(0,0)}14%{opacity:0.85}50%{opacity:0.6;transform:translate(90px,-20px)}85%{opacity:0.85}100%{opacity:0;transform:translate(190px,-6px)}}',
  '@keyframes bga-wander3{0%{opacity:0;transform:translate(0,0)}12%{opacity:0.8}40%{opacity:0.65;transform:translate(-80px,-16px)}78%{opacity:0.85}100%{opacity:0;transform:translate(-170px,-4px)}}',
  // 向左的镜像版 (v1.4.2): 右半区的萤用这两条, 保证它们不飘出画布右缘。
  '@keyframes bga-wander1L{0%{opacity:0;transform:translate(0,0)}10%{opacity:0.9}45%{opacity:0.7;transform:translate(-130px,-14px)}80%{opacity:0.9}100%{opacity:0;transform:translate(-260px,-2px)}}',
  '@keyframes bga-wander2L{0%{opacity:0;transform:translate(0,0)}14%{opacity:0.85}50%{opacity:0.6;transform:translate(-90px,-20px)}85%{opacity:0.85}100%{opacity:0;transform:translate(-190px,-6px)}}',
  '@keyframes bga-meteor{0%{opacity:0;transform:translateX(0) rotate(-4deg)}6%{opacity:0.9}18%{opacity:0;transform:translateX(58vw) rotate(-4deg)}100%{opacity:0;transform:translateX(58vw) rotate(-4deg)}}',
  '@keyframes bga-meteor2{0%{opacity:0;transform:translateX(0) rotate(3deg)}5%{opacity:0.85}16%{opacity:0;transform:translateX(-52vw) rotate(3deg)}100%{opacity:0;transform:translateX(-52vw) rotate(3deg)}}',
  '@keyframes bga-rot{to{transform:rotate(360deg)}}',
  // ---- 特效画布 (v1.16.3: 吸附到输入框卡面, 一条几何规则) ----
  // 走过的弯路, 记在这儿免得再犯:
  //   · 最初画布在宿主那个"居中收缩"的 flex 行里, 量出来只有 194px（整行 434px），
  //     粒子按 194px 算密度只剩 6 只, 超出的还被 clip 切掉;
  //   · 然后改成 position:fixed + JS 按「会话列/卡面」绝对坐标写 --bga-fx-*。**这条路是错的**:
  //     卡面会随输入内容长高、窄屏/侧栏折叠都会换几何, 一旦量滞后画布就停在旧位置 ——
  //     用户反复报"特效不在对话框内"。拿绝对像素对是治标;
  //   · 中间还试过百分比 inset(`--bga-fx-x`): 定位容器的宽度口径与目测不一致(实测 10.5%
  //     缩出来是 118px, 而卡面真正差 186px), 算不准。
  // 现在只留一条几何规则: 画布的定位容器（本机 = `Dc7zOa_composerSeat`, 与卡面**上沿对齐**）
  // 比卡面宽, 所以用**左右内缩量**把它缩到卡面宽度。
  // 三个量都是"卡面相对容器"的偏移: 内缩量 l/r + 上偏 oy + 高度 h。v1.16.5 起高度**跟着卡面走**
  // （以前写死 90px）: 用户往输入框里塞图, 卡面会长到 300px+, 而画布还停在顶部 90px ——
  // 底部一大截没有特效（"空白区域断层"）。现在画布 = 卡面矩形本身, 粒子高度也按卡面高度铺。
  '.bga-dockfx{position:absolute;top:var(--bga-fx-oy,0px);left:var(--bga-fx-inset-l,10%);right:var(--bga-fx-inset-r,10%);height:var(--bga-fx-h,90px);z-index:0;pointer-events:none;overflow:clip}',
  // 画布 overflow:clip 治「横向滚动条频闪」：粒子/流星都是 left% + translate 漂移,
  // overflow:visible 时飘出右缘会把外层 [data-conversation-scroll]（overflow:auto）的
  // scrollWidth 顶大 ⇒ 会话区底部横滚条反复出现。clip 不生成滚动容器、不顶祖先;
  // 配合 flyRules 的「按位置选漂移方向」, 粒子行程全在画布内, clip 只当兜底。
  '.bga-dockfx-in{position:absolute;left:0;right:0;bottom:0;top:0;overflow:clip}',
  '.bga-fly{position:absolute;width:5px;height:5px;border-radius:50%;corner-shape:round;background:var(--bga-accent);box-shadow:0 0 12px 3px var(--bga-accent-soft);opacity:0}',
  ...FLY_RULES,
  '.bga-star{position:absolute;width:3px;height:3px;border-radius:50%;corner-shape:round;background:var(--bga-accent);box-shadow:0 0 7px 1.5px var(--bga-accent-soft);opacity:0;animation:bga-twinkle 2.8s ease-in-out infinite}',
  ...STAR_RULES,
  '.bga-meteor{position:absolute;left:-8%;bottom:48px;width:70px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--bga-accent),transparent);opacity:0;animation:bga-meteor 9s linear infinite 4s}',
  // m2 起点收进画布内（原 right:-6% 起手就探出右缘）, 免得流星从边缘"凭空冒头"。
  '.bga-meteor.m2{left:auto;right:0;bottom:66px;width:94px;height:2.5px;animation:bga-meteor2 13s linear infinite 7.5s}',
  // ---- 特效: 气泡 (与流萤共用 .bga-dockfx 这块画布) ----
  // 气泡: 个头 7~22px、边缘带高光+外辉, 底部铺一层"水面"辉光带, 让整串气泡有出处。
  // 升程/水面高度都随画布高度 (v1.16.5, 见 syncParticleScale): 卡面高 300px 时气泡还只升 92px
  // 就成了"底部一小团", 上不去。
  '@keyframes bga-rise{0%{transform:translateY(0) scale(.5);opacity:0}12%{opacity:.95}68%{opacity:.72}100%{transform:translateY(calc(-1 * var(--bga-fx-rise,92px))) scale(1.35);opacity:0}}',
  '.bga-bub{position:absolute;border-radius:50%;corner-shape:round;border:2px solid var(--bga-accent-soft);background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.95),var(--bga-accent-faint) 60%,var(--bga-accent-soft) 100%);box-shadow:0 0 10px var(--bga-accent-faint),inset 0 -2px 6px var(--bga-accent-faint);opacity:0;animation:bga-rise 7s ease-in infinite}',
  ...BUB_RULES,
  '@keyframes bga-bubsurf{0%,100%{opacity:.3;transform:scaleX(1)}50%{opacity:.62;transform:scaleX(1.05)}}',
  '.bga-bubsurf{position:absolute;left:-2%;right:-2%;bottom:0;height:clamp(22px,22%,34px);border-radius:50%;corner-shape:round;filter:blur(13px);background:var(--bga-accent-soft);opacity:.4;animation:bga-bubsurf 6.5s ease-in-out infinite}',
  // ---- 落樱 / 雨丝 (都在同一块 .bga-dockfx-in 画布上; 画布 overflow:clip,
  //      每条的行程都按"不碰到画布边缘"设计, clip 只当兜底)。
  // 落樱: 花瓣用 border-radius:50% 0 50% 0 出叶形 (corner-shape:round 保住这个形状,
  //    否则会被主题的全局 corner-shape 改成方圆角)。落到底部前淡出, 不会"拍"在卡面上。
  '@keyframes bga-fall{0%{transform:translate(0,-10px) rotate(0);opacity:0}12%{opacity:.85}88%{opacity:.7}100%{transform:translate(var(--bga-dx,0px),var(--bga-fx-fall,104px)) rotate(300deg);opacity:0}}',
  '.bga-ptl i{position:absolute;top:-12px;background:linear-gradient(150deg,var(--bga-accent),var(--bga-accent-soft));border-radius:50% 0 50% 0;corner-shape:round;opacity:0;animation:bga-fall var(--bga-dur,11s) linear infinite var(--bga-delay,0s)}',
  ...PETAL_RULES,
  // 雨丝: 细斜雨丝下落 + 底部一层"被雨打湿"的水光。雨丝左移 22px, left 起点 4% 起,
  //    两端都不触画布边。条数见 RAIN_RULES。
  '@keyframes bga-drop{0%{transform:translate(0,-16px) rotate(12deg);opacity:0}10%{opacity:.75}100%{transform:translate(-22px,var(--bga-fx-drop,110px)) rotate(12deg);opacity:0}}',
  '@keyframes bga-wet{0%,100%{opacity:.09}50%{opacity:.2}}',
  '.bga-rn i{position:absolute;top:-14px;width:1px;background:linear-gradient(180deg,transparent,var(--bga-accent));opacity:0;animation:bga-drop var(--bga-dur,2s) linear infinite var(--bga-delay,0s)}',
  ...RAIN_RULES,
  '.bga-wet{position:absolute;left:8%;right:8%;bottom:0;height:10px;border-radius:50%;corner-shape:round;background:var(--bga-accent);filter:blur(9px);opacity:.14;animation:bga-wet 3.4s ease-in-out infinite}',
  // ---- 侧边栏宝珠 ----
  // --bga-orb-dy / --bga-orb-dx 由 dsh-browser-live 叠列模式写入（纯平移让位，不影响布局盒）
  // DSH 主题有全局 `*,:before,:after{corner-shape:var(--dsw-corner-shape)}`（默认方圆角），
  // 凡 border-radius:50% 的"真圆"都会被画成圆角方块 —— 圆形控件必须写 corner-shape:round 豁免。
  '.bga-orb{border:none;background:none;padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center}',
  '.bga-orb-core{display:block;width:18px;height:18px;border-radius:50%;corner-shape:round;border:1px solid rgba(255,255,255,.4);box-shadow:0 0 9px var(--bga-accent-soft,rgba(0,0,0,.2));transition:transform .18s;transform:translate(var(--bga-orb-dx,0px),var(--bga-orb-dy,0px))}',
  '.bga-orb:hover .bga-orb-core{transform:translate(var(--bga-orb-dx,0px),var(--bga-orb-dy,0px)) scale(1.18)}',
  // ---- 设置页 ----
  '.bga-page{display:flex;flex-direction:column;gap:22px;max-width:760px}',
  '.bga-h{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 4px}',
  '.bga-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 10px;line-height:1.6}',
  '.bga-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;max-height:264px;overflow-y:auto;padding-right:4px;scrollbar-width:thin;scrollbar-color:var(--bga-accent-soft,rgba(0,0,0,.2)) transparent}',
  '.bga-card{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;cursor:pointer;background:var(--dsw-alias-bg-layer-1);padding:0;text-align:left;transition:border-color .15s,transform .15s}',
  '.bga-card:hover{transform:translateY(-2px);border-color:var(--dsw-alias-border-l2)}',
  '.bga-card.on{border-color:var(--bga-accent,var(--dsw-alias-brand-primary));box-shadow:0 0 0 1px var(--bga-accent,var(--dsw-alias-brand-primary)) inset}',
  '.bga-thumb{width:100%;height:86px;object-fit:cover;display:block;background:var(--dsw-alias-bg-layer-2)}',
  '.bga-none{width:100%;height:86px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
  '.bga-name{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;display:flex;align-items:center;justify-content:center;gap:4px}',
  '.bga-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
  '.bga-swatches{display:flex;gap:8px;flex-wrap:wrap}',
  '.bga-swatch{display:flex;flex-direction:column;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}',
  '.bga-swatch.on{border-color:var(--bga-accent);box-shadow:0 0 0 1px var(--bga-accent) inset}',
  '.bga-dots{display:flex;gap:4px}',
  '.bga-dot{width:14px;height:14px;border-radius:50%;corner-shape:round;border:1px solid rgba(0,0,0,.15)}',
  '.bga-field{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.bga-field input[type=color]{width:34px;height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:none;padding:1px;cursor:pointer}',
  '.bga-field input[type=range]{width:130px;accent-color:var(--bga-accent,var(--dsw-alias-brand-primary))}',
  // 取值格定宽右对齐: "0 毫秒" → "950 毫秒" → "1 秒" 字数一变, 同一行后面的控件就横着跳
  // (响应时间旁边紧挨着渐变时长)。58px 按最长的 "1000 毫秒" 定 —— 实际取值到不了这么长,
  // 留的是余量。等宽数字防抖。
  '.bga-field .bga-val{flex:0 0 auto;min-width:58px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
  '.bga-fxopts{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}',
  '.bga-fxopt{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);text-align:left;color:var(--dsw-alias-label-primary)}',
  '.bga-fxopt.on{border-color:var(--bga-accent);box-shadow:0 0 0 1px var(--bga-accent) inset}',
  '.bga-fxopt b{display:block;font-size:13px;margin-bottom:4px}',
  '.bga-fxopt span{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
  '.bga-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:6px 12px;cursor:pointer}',
  '.bga-btn:hover{border-color:var(--dsw-alias-border-l2)}',
  '.bga-foci{display:grid;grid-template-columns:repeat(3,26px);gap:4px}',
  '.bga-focus{width:26px;height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
  '.bga-focus i{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-secondary);display:block}',
  '.bga-focus.on{border-color:var(--bga-accent);box-shadow:0 0 0 1px var(--bga-accent) inset}',
  '.bga-focus.on i{background:var(--bga-accent)}',
  '.bga-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.7;border-left:2px solid var(--bga-accent,var(--dsw-alias-brand-primary));padding-left:10px}',
  '.bga-we-controls{margin:16px 0;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:rgba(248,250,252,.94)}body[data-ds-dark-theme] .bga-we-controls{background:rgba(18,24,34,.92)}',
  '.bga-we-properties{margin-top:18px}.bga-we-group{margin:10px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}',
  '.bga-we-group summary{padding:12px 14px;cursor:pointer;font-size:13px;font-weight:600}.bga-we-group[open] summary{border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.bga-we-field{display:grid;grid-template-columns:minmax(120px,1fr) minmax(150px,1.2fr);align-items:center;gap:16px;padding:10px 14px;font-size:12px}.bga-we-field+ .bga-we-field{border-top:1px solid var(--dsw-alias-border-l1)}',
  '.bga-we-range{display:flex;align-items:center;gap:10px}.bga-we-range input[type=range]{flex:1;min-width:60px;accent-color:var(--bga-accent,var(--dsw-alias-brand-primary))}.bga-we-range input[type=number]{width:70px}',
  '.bga-we-properties input:not([type=range]):not([type=checkbox]):not([type=color]),.bga-we-properties select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;min-width:0}',
  '.bga-we-field input[type=checkbox]{justify-self:end;width:18px;height:18px;accent-color:var(--bga-accent,var(--dsw-alias-brand-primary))}.bga-we-field input[type=color]{justify-self:end;width:48px;height:30px;border:0;background:transparent}',
  '.bga-we-presets{margin-top:18px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:14px}.bga-we-presets .bga-row{margin-top:8px}.bga-we-controls button:disabled{opacity:.5;cursor:default}',
  '.bga-we-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}.bga-we-toolbar input{flex:1;min-width:140px}.bga-we-toolbar input,.bga-we-toolbar select{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}',
  '.bga-we-library{max-height:360px;overflow-y:auto;padding:3px;align-content:start}.bga-we-card{cursor:default}.bga-we-pick{display:block;width:100%;border:0;padding:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.bga-we-pick:focus-visible{outline:2px solid var(--bga-accent);outline-offset:-3px}.bga-we-card-title{display:block;padding:8px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bga-we-card-meta{display:flex;gap:6px;padding:0 8px 8px;font-size:11px;opacity:.8}.bga-we-card-actions{display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 8px}.bga-we-card .bga-note{padding:0 8px 8px}',
  '.bga-we-actions{padding:10px 0;flex-wrap:wrap}.bga-we-current{margin:12px 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}.bga-we-current strong{overflow-wrap:anywhere}.bga-we-current .bga-row{margin-top:8px}.bga-we-empty{padding:24px;text-align:center}.bga-we-controls .bga-row{flex-wrap:wrap}',
  '@media(max-width:650px){.bga-we-field{grid-template-columns:1fr;gap:8px}.bga-we-field input[type=checkbox]{justify-self:start}}',
  // ---- v1.1: 当前底图条 + 类型卡 + 二级图库 ----
  '.bga-cur{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);margin-bottom:10px}',
  '.bga-curbox{position:relative;display:block;width:64px;height:42px;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);flex:none}',
  '.bga-curbox.off{opacity:.45}',
  '.bga-curbox.off::before{display:none}',
  '.bga-cur-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}',
  '.bga-cur-info{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.5}',
  '.bga-cur-info small{display:block;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.bga-card:disabled{opacity:.5;cursor:default}',
  '.bga-card:disabled:hover{transform:none;border-color:var(--dsw-alias-border-l1)}',
  '.bga-catgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:12px;max-height:300px;overflow-y:auto;padding-right:4px;scrollbar-width:thin;scrollbar-color:var(--bga-accent-soft,rgba(0,0,0,.2)) transparent}',
  '.bga-cat{display:flex;gap:10px;align-items:center;padding:10px}',
  '.bga-cat-thumbs{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;width:118px;flex:none}',
  '.bga-mini{width:57px;height:40px;object-fit:cover;border-radius:6px;display:block;background:var(--dsw-alias-bg-layer-2)}',
  '.bga-emptymini{width:57px;height:40px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:10px;background:var(--dsw-alias-bg-layer-2)}',
  '.bga-cat-meta{min-width:0;flex:1}',
  '.bga-cat-meta b{display:block;font-size:13px;color:var(--dsw-alias-label-primary);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.bga-cat-meta span{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.4}',
  '.bga-grid.tall{max-height:min(58vh,560px)}',
  '.bga-back{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 10px;cursor:pointer}',
  '.bga-back:hover{border-color:var(--dsw-alias-border-l2)}',
  '.bga-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;padding:3px 12px;cursor:pointer;line-height:1.5}',
  '.bga-chip:hover{border-color:var(--dsw-alias-border-l2)}',
  '.bga-chip.on{color:var(--dsw-alias-label-primary);border-color:var(--bga-accent,var(--dsw-alias-brand-primary));box-shadow:0 0 0 1px var(--bga-accent,var(--dsw-alias-brand-primary)) inset}',
  '.bga-thumbwrap{position:relative;display:block}',
  '.bga-no{position:absolute;left:4px;top:4px;font-size:9px;line-height:1.2;padding:2px 5px;border-radius:5px;background:rgba(0,0,0,.6);color:#fff;pointer-events:none}',
  // 标签气泡 (v1.16.5): 用户附图那套 —— 圆角胶囊 + 淡色底 + 同色系描边。
  // 颜色由 tagPill() 按标签名调色板算成**字面量**下发 (不碰 theme token, 见 settingsSolidColor 注释)。
  '.bga-tagpill{font-style:normal;display:inline-flex;align-items:center;min-height:20px;font-size:10.5px;line-height:1.5;border-radius:999px;padding:1px 9px;white-space:nowrap;flex:none;border:1px solid transparent}',
  '.bga-name em{font-style:normal;font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:0 4px;flex:none}',
  // ---- v1.2: 加载动画 (转圈) + 类型卡缩略图盒子 ----
  '.bga-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:26px 0;color:var(--dsw-alias-label-secondary);font-size:12px}',
  '.bga-spin{width:15px;height:15px;border-radius:50%;corner-shape:round;border:2px solid rgba(160,170,190,.3);border-top-color:var(--bga-accent,#7aa7e8);animation:bga-rot .7s linear infinite}',
  '.bga-thumbwrap::before,.bga-curbox::before,.bga-minibox::before{content:"";position:absolute;left:50%;top:50%;z-index:0;border-radius:50%;corner-shape:round;border:2px solid rgba(160,170,190,.28);border-top-color:var(--bga-accent,#7aa7e8);animation:bga-rot .7s linear infinite}',
  '.bga-thumbwrap::before{width:20px;height:20px;margin:-10px 0 0 -10px}',
  '.bga-curbox::before{width:15px;height:15px;margin:-8px 0 0 -8px}',
  '.bga-minibox::before{width:13px;height:13px;margin:-7px 0 0 -7px}',
  '.bga-thumbwrap img{position:relative;z-index:1}',
  '.bga-minibox{position:relative;display:block;width:57px;height:40px;border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}',
  '.bga-minibox img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1}',
  // ---- 「文件目录与类型说明」抽屉 (点开才显示说明正文) ----
  '.bga-foldbtn{display:inline-flex;align-items:center;gap:4px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;padding:3px 10px;border-radius:8px;cursor:pointer}',
  '.bga-foldbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--bga-accent,var(--dsw-alias-brand-primary))}',
  '.bga-foldbody{margin-top:8px;border-left:2px solid var(--bga-accent,var(--dsw-alias-brand-primary));padding-left:10px;display:flex;flex-direction:column;gap:6px}',
  // 卡面阴影的独立小开关：一行小字 + 原生勾选框
  '.bga-tiny{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
  '.bga-tiny:hover{color:var(--dsw-alias-label-primary)}',
  '.bga-tiny input{width:13px;height:13px;margin:0;accent-color:var(--bga-accent,var(--dsw-alias-brand-primary));cursor:pointer}',
  ].join('\n') + '\n' + studioCss()
}

function studioCss() { return `
.bga-studio{--bga-panel:rgba(250,252,255,.9);--bga-panel-soft:rgba(238,242,250,.78);--bga-line:rgba(110,132,168,.23);--bga-text:#182337;--bga-muted:#596780;max-width:1080px;width:100%;gap:18px;color:var(--bga-text);font-size:14px;line-height:1.55;container-type:inline-size}
body[data-ds-dark-theme] .bga-studio{--bga-panel:rgba(16,23,37,.94);--bga-panel-soft:rgba(30,42,61,.83);--bga-line:rgba(152,174,208,.23);--bga-text:#edf2fa;--bga-muted:#a5b3c9}
.bga-studio *,.bga-dialog *{box-sizing:border-box}.bga-studio button,.bga-dialog button{font:inherit}.bga-studio button:focus-visible,.bga-studio input:focus-visible,.bga-studio select:focus-visible,.bga-studio summary:focus-visible,.bga-dialog :focus-visible{outline:2px solid var(--bga-accent,#7190cb);outline-offset:3px}
.bga-studio button:disabled{cursor:default;opacity:.45}.bga-studio .bga-btn.bga-active:disabled{opacity:1;background:transparent}.bga-muted{color:var(--bga-muted,#a5b3c9);font-size:12px;line-height:1.65}.bga-error{color:#df655b;font-size:13px}
.bga-studio-heading{display:flex;align-items:center;gap:14px}.bga-studio-heading>div{flex:1}.bga-studio-heading h2{font-size:24px;line-height:1.3;margin:0;letter-spacing:.04em}.bga-studio-heading p{margin:5px 0 0}.bga-save-state{font-size:12px;color:var(--bga-muted);white-space:nowrap}
.bga-hero{position:relative;overflow:hidden;aspect-ratio:2.75;min-height:210px;max-height:360px;border-radius:20px;background:linear-gradient(125deg,#233550,#10192a);border:1px solid var(--bga-line);isolation:isolate}.bga-hero-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.bga-hero-shade{position:absolute;inset:0;background:linear-gradient(0deg,rgba(5,12,23,.9),rgba(5,12,23,.1) 80%)}.bga-hero-info{position:absolute;inset:auto 26px 22px;display:flex;flex-direction:column;gap:4px;color:#fff}.bga-hero-info strong{font-size:25px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 15px #0006}.bga-hero-info>span:last-child{font-size:12px;color:#e0e8f4}.bga-eyebrow{font-size:11px;letter-spacing:.14em;color:#d2dded}
.bga-player{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 18px;margin-top:-4px;border:1px solid var(--bga-line);border-radius:14px;background:var(--bga-panel)}.bga-studio .bga-btn,.bga-dialog .bga-btn{min-height:36px;padding:7px 13px;border:1px solid var(--bga-line,rgba(140,165,200,.3));border-radius:9px;background:var(--bga-panel-soft,rgba(120,145,185,.1));color:inherit;white-space:nowrap;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s}.bga-studio .bga-btn:hover:not(:disabled),.bga-dialog .bga-btn:hover:not(:disabled){border-color:var(--bga-accent,#7190cb)}.bga-studio .bga-primary,.bga-dialog .bga-primary{background:#426cb4;border-color:#426cb4;color:#fff}.bga-studio .bga-active{color:var(--bga-accent,#7190cb);border-color:var(--bga-accent,#7190cb)}
.bga-player-source{display:flex;flex-direction:column;align-items:flex-start;gap:3px;max-width:100%}.bga-source-control{display:flex;align-items:center;gap:10px;font-size:12px;max-width:100%}.bga-source-control>span{color:var(--bga-muted);flex:none}.bga-studio select,.bga-input{min-height:36px;min-width:0;border:1px solid var(--bga-line,rgba(140,165,200,.3));border-radius:8px;background:var(--bga-panel,rgba(120,145,185,.1));color:var(--bga-text,inherit);padding:7px 10px;font:inherit;font-size:13px}.bga-studio select{max-width:100%}.bga-source-control select{max-width:260px;width:100%}.bga-studio option,.bga-studio optgroup{background:var(--bga-panel);color:var(--bga-text)}.bga-input::placeholder{color:var(--bga-muted,#8896ae)}
.bga-tabs{display:flex;gap:6px;padding:5px;background:var(--bga-panel);border:1px solid var(--bga-line);border-radius:12px}.bga-tabs button{flex:1;min-height:39px;border:0;border-radius:8px;background:transparent;color:var(--bga-muted);font-size:13px;cursor:pointer}.bga-tabs button[aria-selected=true]{color:var(--bga-text);background:var(--bga-panel-soft);box-shadow:inset 0 -2px var(--bga-accent,#7190cb)}
.bga-tab-panel{min-width:0}.bga-library{display:grid;grid-template-columns:168px minmax(0,1fr);gap:20px}.bga-library-nav{padding:12px 8px;background:var(--bga-panel);border:1px solid var(--bga-line);border-radius:14px;align-self:start;min-width:0}.bga-nav-item{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:8px 10px;border:0;border-radius:8px;color:var(--bga-muted);background:transparent;cursor:pointer;text-align:left;font-size:13px!important}.bga-nav-item>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1}.bga-nav-item small{font-size:11px;opacity:.8}.bga-nav-item.on{color:var(--bga-text);background:var(--bga-panel-soft);box-shadow:inset 2px 0 var(--bga-accent,#7190cb)}.bga-nav-item:hover{color:var(--bga-text);background:var(--bga-panel-soft)}.bga-nav-heading{display:flex;align-items:center;justify-content:space-between;margin:15px 8px 5px;font-size:11px;letter-spacing:.06em;color:var(--bga-muted)}.bga-nav-hint{font-size:12px;color:var(--bga-muted);margin:6px 10px 14px}.bga-folder-list{margin-top:16px;border-top:1px solid var(--bga-line);padding-top:12px}.bga-folder-list summary{font-size:12px;padding:4px 9px 9px;color:var(--bga-muted);cursor:pointer}
.bga-sort-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px}.bga-picture.drop-target{border-color:var(--bga-accent);box-shadow:inset 0 0 0 3px var(--bga-accent)}.bga-order-number{position:absolute;top:7px;left:7px;padding:2px 7px;border-radius:6px;background:#11233bdd;color:white;font-size:12px}.bga-order-actions{justify-content:flex-end}.bga-order-actions .bga-drag-handle{margin-right:auto;cursor:grab}.bga-drag-handle:active{cursor:grabbing}.bga-framing-controls{border:0;padding:0;margin:0;min-width:0}.bga-frame-reset{margin-top:16px}.bga-framing-controls:disabled{opacity:.5}.bga-player-source>.bga-row{gap:12px;max-width:100%}.bga-player-source .bga-source-control{min-width:0}.bga-sort-bar+.bga-library-toolbar input:disabled,.bga-sort-bar+.bga-library-toolbar select:disabled{opacity:.45}
.bga-library-main{min-width:0}.bga-library-heading{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px}.bga-library-heading h3{font-size:17px;line-height:1.4;margin:0 0 3px;overflow-wrap:anywhere}.bga-library-heading>.bga-row{gap:4px}.bga-library-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;min-width:0}.bga-library-toolbar .bga-input{flex:1;width:100px}.bga-library-toolbar select{width:118px;flex:none}.bga-library-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:13px;max-height:560px;overflow:auto;align-content:start;padding:2px 3px 5px;scrollbar-width:thin;scrollbar-color:var(--bga-accent) transparent}
.bga-picture{border:1px solid var(--bga-line);background:var(--bga-panel);border-radius:12px;overflow:hidden;min-width:0;transition:border-color .15s}.bga-picture:hover{border-color:var(--bga-accent)}.bga-picture.current,.bga-picture.picked{border-color:var(--bga-accent);box-shadow:0 0 0 1px var(--bga-accent)}.bga-picture-pick{display:block;padding:0;width:100%;border:0;color:inherit;background:transparent;cursor:pointer;text-align:left}.bga-picture-image{position:relative;display:block;aspect-ratio:16/10;overflow:hidden;background:var(--bga-panel-soft)}.bga-picture-image img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s}.bga-picture-pick:hover img{transform:scale(1.03)}.bga-picture-name{display:block;font-size:13px;font-weight:600;padding:9px 10px 2px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.bga-tags{flex:1 1 auto;min-width:0;display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}.bga-tags::-webkit-scrollbar{display:none}.bga-tagbar{margin:0 0 12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.bga-tagchip{border:0;padding:0;cursor:pointer;background:none}.bga-tagchip .bga-tagpill{opacity:.72;transition:opacity .15s}.bga-tagchip:hover .bga-tagpill{opacity:1}.bga-tagchip.on .bga-tagpill{opacity:1;box-shadow:0 0 0 1px currentColor inset}.bga-picture-badge{position:absolute;left:7px;bottom:7px;padding:3px 7px;border:1px solid #ffffff35;border-radius:6px;color:#fff;background:#11233bdd;font-size:10px;line-height:1.4}.bga-check{position:absolute;right:8px;top:8px;background:#152238b3;border:1px solid #e1e9f1;border-radius:5px;width:23px;height:23px;text-align:center;color:#fff}.bga-picture.picked .bga-check{background:#426cb4}.bga-picture-foot{display:flex;align-items:center;padding:0 6px 5px 10px;gap:4px}.bga-picture-foot .bga-icon-btn{flex:none}.bga-picture-foot>.bga-muted{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px}.bga-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border:0;border-radius:7px;background:transparent;color:inherit;font-size:20px!important;cursor:pointer}.bga-icon-btn:hover{background:rgba(120,145,185,.15)}.bga-icon-btn.active{color:var(--bga-accent,#7190cb)}
.bga-batch{display:flex;align-items:center;gap:7px;flex-wrap:wrap;background:var(--bga-panel);border:1px solid var(--bga-line);border-radius:10px;padding:9px;margin-bottom:12px;font-size:12px}.bga-batch>span{margin-right:auto}.bga-empty{text-align:center;padding:48px 20px;border:1px dashed var(--bga-line);border-radius:14px;background:var(--bga-panel);color:var(--bga-muted);font-size:13px}.bga-empty b{color:var(--bga-text);font-size:15px}.bga-empty p{margin:8px 0 16px}
.bga-details{margin-top:18px;border-top:1px solid var(--bga-line);padding-top:12px;font-size:12px}.bga-details>summary{color:var(--bga-muted);cursor:pointer;min-height:30px}.bga-details[open]>summary{margin-bottom:12px}.bga-directory{padding:10px;background:var(--bga-panel-soft);border-radius:8px;overflow-wrap:anywhere;margin-bottom:12px;font-size:12px}.bga-studio-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--bga-muted);font-size:11px;padding:2px 0 12px}.bga-text-btn{border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px!important;text-decoration:underline;text-underline-offset:4px}
.bga-panel-stack{display:grid;gap:16px}.bga-panel-stack>section,.bga-tab-panel>section{background:var(--bga-panel);border:1px solid var(--bga-line);border-radius:14px;padding:22px}.bga-studio .bga-h{font-size:16px;color:var(--bga-text);margin:0 0 10px}.bga-studio .bga-sub{color:var(--bga-muted);font-size:12px;margin:0 0 18px}.bga-control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 30px;margin:16px 0;border:0;padding:0;min-width:0}.bga-control-grid .bga-field{display:grid;grid-template-columns:minmax(0,1fr) 65px;gap:10px;color:var(--bga-muted);font-size:13px}.bga-control-grid .bga-field input[type=range]{grid-row:2;grid-column:1/-1;width:100%;margin:0;height:18px}.bga-control-grid .bga-val{grid-row:1;grid-column:2;font-size:12px}.bga-control-grid:disabled{opacity:.45}.bga-studio .bga-tiny{font-size:13px;color:var(--bga-text);gap:9px;margin:8px 0}.bga-studio .bga-tiny input{width:16px;height:16px}.bga-focus-row{display:flex;gap:20px;justify-content:space-between;align-items:center;border-top:1px solid var(--bga-line);padding-top:16px}.bga-focus-row b{font-size:13px;font-weight:500}.bga-focus-row p{margin:4px 0 0}.bga-studio .bga-fxopts{grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px}.bga-studio .bga-fxopt{padding:15px 12px;background:var(--bga-panel-soft);color:var(--bga-text)}.bga-studio .bga-fxopt span{color:var(--bga-muted);font-size:12px}.bga-studio .bga-swatch{flex:1;min-width:62px;background:var(--bga-panel-soft);color:var(--bga-text);padding:12px 8px}.bga-studio .bga-swatches{gap:8px}
.bga-dialog{width:min(460px,calc(100vw - 32px));max-height:85vh;overflow:auto;padding:25px;border:1px solid rgba(140,165,200,.35);border-radius:18px;background:#f5f8fd;color:#1e2d44;font-family:inherit;box-shadow:0 24px 100px #0006}.bga-dialog::backdrop{background:rgba(4,9,18,.65);backdrop-filter:blur(5px)}body[data-ds-dark-theme] .bga-dialog{background:#131f31;color:#eef3fa}.bga-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:20px}.bga-dialog h3{font-size:19px;margin:0}.bga-form-label{display:grid;gap:9px;font-size:13px}.bga-dialog .bga-input{width:100%;color:inherit;background:rgba(120,145,185,.1);margin:0}.bga-dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:24px}.bga-dialog-actions>.bga-danger{margin-right:auto}.bga-danger{color:#d56868!important}.bga-list-choices{display:grid;gap:5px;max-height:260px;overflow:auto}.bga-list-choice{display:flex;align-items:center;gap:12px;padding:12px 10px;border-radius:8px;background:rgba(120,145,185,.08);cursor:pointer;font-size:14px}.bga-list-choice input{width:17px;height:17px;accent-color:#7190cb}.bga-list-choice span{flex:1;overflow-wrap:anywhere}.bga-list-choice small{opacity:.65;flex:none}.bga-create-inline{display:flex;gap:8px;border-top:1px solid rgba(140,165,200,.25);padding-top:18px;margin-top:18px}.bga-delete-confirm{border-top:1px solid rgba(140,165,200,.25);margin-top:20px;padding-top:12px;font-size:13px}
@container(max-width:700px){.bga-library{grid-template-columns:140px minmax(0,1fr);gap:14px}.bga-library-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bga-player{gap:14px}.bga-player-source{width:100%}.bga-hero{min-height:185px}.bga-hero-info strong{font-size:21px}.bga-control-grid{gap:18px}}
@container(max-width:500px){.bga-library{grid-template-columns:1fr}.bga-library-nav{display:flex;gap:4px;flex-wrap:wrap}.bga-nav-item{width:auto;max-width:100%;flex:1 1 110px}.bga-nav-heading{width:100%;margin:8px 8px 0}.bga-nav-hint{width:100%;margin:2px 10px}.bga-folder-list{width:100%;margin-top:8px;padding-top:8px}.bga-library-toolbar{flex-wrap:wrap}.bga-library-toolbar .bga-input{flex-basis:100%}.bga-library-toolbar select{flex:1}.bga-control-grid{grid-template-columns:1fr}.bga-player>.bga-row{display:grid;grid-template-columns:1fr 1fr;width:100%}.bga-player>.bga-row .bga-btn{width:100%}.bga-hero-info{inset:auto 17px 17px}.bga-studio-heading h2{font-size:21px}.bga-panel-stack>section,.bga-tab-panel>section{padding:16px}.bga-source-control{width:100%}.bga-source-control select{flex:1;max-width:100%}}
@media(prefers-reduced-motion:reduce){.bga-studio *{transition:none!important}.bga-picture-pick:hover img{transform:none}}
` }


// ---------------------------------------------- 画布实宽 → 重建样式表 --
// **必须在模块作用域**：DockFx（模块级组件）每次渲染后要调 syncCanvasWidth，
// apply() 里的 resize 监听也要调它。踩过的坑：把 syncCanvasWidth 定义在 apply()
// 内部、而 DockFx 在模块作用域调用 ⇒ 组件一挂载就 ReferenceError, 整块 dock 被 React
// 卸掉（表现为"对话框特效全无"）。离线 harness 现在会真跑 useEffect 并渲染 DockFx, 这类错当场炸。
var disposeStatic = null
function rebuildStatic() {
  if (disposeStatic) disposeStatic()
  disposeStatic = styles.insert(staticCss())
}
var canvasTimer = 0
/** 量画布实宽 → 按新宽度重算数量 → 重建样式表 + 通知重渲染。
 *  只在"变化超过 24px"时才动：拖窗口边缘会连续触发 resize，不设闸会把整张样式表
 *  一帧重建一次。 */
/** 画布的左右内缩量 + 上偏 + 高度 = 输入框卡面相对**画布定位祖先**的矩形。
 *  为什么绕这一圈: 画布的定位祖先（`.bga-dockfx` 往上第一个 position 非 static 的祖先，
 *  本机 = `Dc7zOa_composerSeat`，1131px）比输入框卡面（912px）宽，且卡面在里面是**居中**的，
 *  所以要用"卡面相对它的偏移"把画布缩进去。写相对量而不是页面绝对坐标: 容器挪动/卡面变宽/
 *  侧栏折叠都会跟着走，不会像 v1.16.1 那样"停在旧位置"。
 *  高度也必须量（v1.16.5）: 卡面随输入内容（尤其附图）长高，写死 90px 会让下半截没有特效。
 *  读不到就保持上一次的值（CSS 里那条兜底规则）。 */
function syncCanvasInset() {
  if (typeof document === 'undefined' || !document.querySelector) return
  var el = document.querySelector('.bga-dockfx')
  var card = document.querySelector('[data-composer-card]')
  if (!el || !card || !el.getBoundingClientRect || !card.getBoundingClientRect) return
  // 画布往上第一个有盒子的、position 非 static 的祖先 = 它真正的定位祖先
  var host = el.parentElement
  while (host && host !== document.body) {
    var r = host.getBoundingClientRect ? host.getBoundingClientRect() : null
    if (r && r.width > 0 && getComputedStyle(host).position !== 'static') break
    host = host.parentElement
  }
  if (!host || host === document.body || !host.getBoundingClientRect) return
  var box = host.getBoundingClientRect()
  var cr = card.getBoundingClientRect()
  if (!box.width || !cr.height) return
  var left = Math.round(cr.left - box.left)
  var right = Math.round(box.right - cr.right)
  if (left < 0) left = 0
  if (right < 0) right = 0
  if (left + right >= box.width - 40) return          // 明显量错就保持上一次 / CSS 默认
  var oy = Math.round(cr.top - box.top)
  if (oy < 0) oy = 0
  var h = Math.round(cr.height)
  // 卡面一长高，几何三个量都变。**内联写在 .bga-dockfx 上**而不是写 <html>: 画布是单例,
  // 内联的优先级比 CSS 规则高且不用等下一帧, 也不会把主题层卷进来。
  if (el.style) {
    el.style.setProperty('--bga-fx-inset-l', left + 'px')
    el.style.setProperty('--bga-fx-inset-r', right + 'px')
    el.style.setProperty('--bga-fx-oy', oy + 'px')
    el.style.setProperty('--bga-fx-h', h + 'px')
  }
}

/** 画布高度 → 粒子纵向几何。基准 = 写死 90px 那版的观感（用户已验收过）:
 *  bottom 4~46px、行程 92px。卡面长高时这些量**等比例放大**, 否则粒子全挤在底部一小条,
 *  上面还是一大片空的（等于把"断层"从画布外挪到画布内）。上限 200px: 再高收益只有噪声,
 *  却要按面积付渲染成本。 */
var FX_BASE_H = 90
var fxScaledH = 0
function canvasScale(h) {
  if (!isFinite(h) || h <= 0) return 1
  return Math.min(200, h) / FX_BASE_H
}
function syncParticleScale() {
  if (typeof document === 'undefined' || !document.querySelector) return
  var el = document.querySelector('.bga-dockfx')
  var h = el && el.getBoundingClientRect ? el.getBoundingClientRect().height : 0
  if (!h) return
  // 拖动窗口边缘 / 输入框长高会连发——比例只在高度真的变了才重写（写变量本身很便宜，
  // 但 ResizeObserver 一秒能发几十次，这里留个 4px 闸门）。
  if (Math.abs(h - fxScaledH) < 4) return
  fxScaledH = h
  var k = canvasScale(h)
  var setVar = function (name, value) {
    if (document.documentElement && document.documentElement.style && document.documentElement.style.setProperty) {
      document.documentElement.style.setProperty(name, value)
    }
  }
  setVar('--bga-fx-rise', Math.round(92 * k) + 'px')        // 气泡升程
  setVar('--bga-fx-fall', Math.round(104 * k) + 'px')       // 落樱行程
  setVar('--bga-fx-drop', Math.round(110 * k) + 'px')       // 雨丝行程
}

function syncCanvasWidth() {
  if (typeof document === 'undefined' || !document.querySelector) return
  // v1.16.3: 几何交给 CSS + 一条相对内缩量（见 staticCss 里 .bga-dockfx 的注释）。
  // 这里只做三件事：① 刷新卡面矩形; ② 刷新粒子纵向比例; ③ 量画布实宽 → 重算粒子数量（密度）。
  syncCanvasInset()
  syncParticleScale()
  var el = document.querySelector('.bga-dockfx')
  var w = el && el.getBoundingClientRect ? Math.round(el.getBoundingClientRect().width) : 0
  if (!w) {
    var ref = document.querySelector('[data-composer-card]')
    w = ref && ref.getBoundingClientRect ? Math.round(ref.getBoundingClientRect().width) : 0
  }
  if (!w) return
  w = Math.max(120, w)
  if (Math.abs(w - CANVAS_W) < 24) return
  CANVAS_W = w
  regenerateParticles()
  rebuildStatic()
  STORE.touch()          // 让 DockFx 用新数量重渲染（不写盘，见 STORE.touch 注释）
}
// 窗口/侧栏尺寸一变就重量一次 (带 300ms 去抖: 拖窗口边缘会连发几十次 resize)。
function scheduleCanvasSync(delay) {
  if (canvasTimer) clearTimeout(canvasTimer)
  canvasTimer = setTimeout(function () { canvasTimer = 0; syncCanvasWidth() }, typeof delay === 'number' ? delay : 300)
}

// ---------------------------------------------------------- 流萤 dock -------

// 输入框上方那条 0 高度 dock 画布: 按当前特效渲染各自的 DOM。
// 只负责建节点, 动画全在 staticCss() 里 (纯 CSS, 不跑 JS 定时器)。
function DockFx() {
  var s = useBga()
  // 特效不要求"有底图"（解耦）：点「清除底图」只影响背景, 不该让特效一起无声消失。
  if (s.effect === 'off') return null
  var kids = []
  var i
  if (s.effect === 'firefly') {
    for (i = 1; i <= FLY_RULES.length; i++) kids.push(h('div', { key: 'f' + i, className: 'bga-fly f' + i }))
    for (i = 1; i <= STAR_RULES.length; i++) kids.push(h('div', { key: 's' + i, className: 'bga-star s' + i }))
    kids.push(h('div', { key: 'meteor', className: 'bga-meteor' }))
    kids.push(h('div', { key: 'meteor2', className: 'bga-meteor m2' }))
  } else if (s.effect === 'bubble') {
    kids.push(h('div', { key: 'surf', className: 'bga-bubsurf' }))
    for (i = 1; i <= BUB_RULES.length; i++) kids.push(h('div', { key: 'b' + i, className: 'bga-bub b' + i }))
  } else if (s.effect === 'petal') {
    var petals = []
    for (i = 1; i <= PETAL_RULES.length; i++) petals.push(h('i', { key: 'p' + i, className: 'p' + i }))
    kids.push(h('div', { key: 'ptl', className: 'bga-ptl' }, petals))
  } else if (s.effect === 'rain') {
    var drops = []
    for (i = 1; i <= RAIN_RULES.length; i++) drops.push(h('i', { key: 'r' + i, className: 'r' + i }))
    kids.push(h('div', { key: 'wet', className: 'bga-wet' }))
    kids.push(h('div', { key: 'rn', className: 'bga-rn' }, drops))
  } else {
    return null
  }
  // 每次渲染后量一次画布实宽（数量按它算）。syncCanvasWidth 自己带 24px 闸门，
  // 量到变化才重建样式表 + 通知重渲染，所以这里不会形成渲染循环。
  React.useEffect(function () { syncCanvasWidth() })
  return h('div', { className: 'bga-dockfx', 'aria-hidden': 'true' },
    h('div', { className: 'bga-dockfx-in' }, kids))
}

// ---------------------------------------------------------- 侧边栏宝珠 ------

function Orb() {
  var s = useBga()
  return h('button', {
    className: 'bga-orb',
    title: '换一张 · ' + sourceLabel(s.playbackSource) + (s.wallpaper ? '（当前：' + curLabel(s.wallpaper) + '）' : ''),
    'aria-label': '换一张 · ' + sourceLabel(s.playbackSource),
    onClick: cycleWallpaper,
  }, h('span', {
    className: 'bga-orb-core',
    style: { background: 'radial-gradient(circle at 35% 30%, ' + s.accent + ', ' + s.deep + ')' },
  }))
}

// ---------------------------------------------------- 叠列协同：宝珠被动让位 --
// 与 dsh-browser-live 的「叠列」约定：browser-live 的客户端发现本插件宝珠
// （.bga-orb）与 wallet 峰谷卡（.dshw_footRing）共存时，会把「宝珠上 + 地球下」
// 这一对以峰谷卡中心为对称轴上下居中；卡片与宝珠空档较大时还会把整列右移吸附到
// 卡片左侧。几何全部由 dsh-browser-live 单点写入 --bga-orb-dy/--bga-orb-dx，
// 本插件只提供被动 CSS 变量（见 staticCss()），避免两处周期测量互相打架。

// ---------------------------------------------------------------- 设置页 ----

function Section(title, sub) {
  var kids = Array.prototype.slice.call(arguments, 2)
  return h('section', null,
    h('h3', { className: 'bga-h' }, title),
    sub ? h('p', { className: 'bga-sub' }, sub) : null,
    h.apply(null, ['div', null].concat(kids)))
}

/** 模糊滑杆的档位。用户 2026-10-01: **0–2px 每 0.1 可调**（21 档），2px 之后保持原来的粗档
 *  (3/4/6/8/12/16/24)。 */
var BLUR_STOPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5,
  1.6, 1.7, 1.8, 1.9, 2, 3, 4, 6, 8, 12, 16, 24]

/** px 值显示：整数就不带小数点，否则显示一位小数（卡面模糊 0–2 段是 0.1 一档）。 */
function fmtPx(v) {
  var n = Number(v)
  if (!isFinite(n)) return '—'
  var r = Math.round(n * 10) / 10
  return (Math.abs(r - Math.round(r)) < 0.001 ? String(Math.round(r)) : r.toFixed(1)) + 'px'
}

/** 滑杆。给了 stops = **不平均档位**滑杆: 控件是等距的 0..n-1 档, 真正的值查表(见 AUTO_STOPS),
 *  回调交出去的也是表里的值。原生 step 表达不了不平均刻度, 所以映射放在这里。 */
function Slider(label, value, min, max, onChange, unit, stops) {
  var val = value, lo = min, hi = max
  // 分钟要的是整数刻度; 毫秒 50ms 一档(够细, 又不至于拖半天才能从 900 挪到 5000);
  // 其余(0..1 / px / 倍率)保留 0.01 的细档。
  var step = unit === 'min' ? '1' : unit === 'ms' ? '50' : '0.01'
  if (stops) { val = stops.indexOf(nearestStop(stops, value)); lo = 0; hi = stops.length - 1; step = '1' }
  // 显示用的是**值**：有 stops 时 val 是档位序号，直接显示就成了"9 分钟"这种事。
  var shownVal = stops ? stops[val] : val
  var shown = unit === 'px' ? fmtPx(shownVal)
    : unit === 'ms' ? (shownVal >= 1000 ? (shownVal / 1000) + ' 秒' : Math.round(shownVal) + ' 毫秒')
    : unit === 'x' ? '×' + Number(shownVal).toFixed(2)
    : unit === 'min' ? (shownVal >= 60 ? (shownVal / 60) + ' 小时' : Math.round(shownVal) + ' 分钟')
    : Math.round(shownVal * 100) + '%'
  return h('label', { className: 'bga-field' }, label + ' ',
    h('input', { type: 'range', 'aria-label': label, min: String(lo), max: String(hi), step: step, value: String(val),
      onChange: function (e) { onChange(stops ? stops[Number(e.target.value)] : Number(e.target.value)) } }),
    // 定宽格子(见 .bga-val): 拖动时数字长短变化不许把后面的控件挤走
    h('span', { className: 'bga-val' }, shown))
}

/** 一行小字 + 原生勾选框的小开关（「卡面阴影」用, 它从特效里独立出来）。 */
function TinySwitch(label, value, onChange) {
  return h('label', { className: 'bga-tiny' },
    h('input', { type: 'checkbox', checked: !!value, onChange: function (e) { onChange(e.target.checked) } }),
    label)
}

// ------------------------------------------------------------- 标签气泡 -----
// 用户 2026-10-01 附图那套: 每个标签是一个**小气泡**(圆角胶囊, 淡色底 + 同色系描边 + 名).
// 颜色跟当前配色走: accent 往白/深里混出底色, 文字色按底色亮度选深/浅 (任何 accent 下都读得清)。
// 文字色/底色都是**字面量**算出来的, 不写 theme token —— 见 settingsSolidColor() 的注释。
function tagPill(name, style) {
  var s = STORE.state || {}
  var accent = hexRgb(s.accent || '#e88ca0')
  var deep = hexRgb(s.deep || '#241318')
  var body = typeof document !== 'undefined' ? document.body : null
  var light = !(body && body.hasAttribute && body.hasAttribute('data-ds-dark-theme'))
  var bg = mix(accent, light ? WHITE : deep, light ? 0.76 : 0.7)
  var line = mix(accent, light ? WHITE : deep, 0.52)
  var luma = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255
  var fg = luma > 0.62 ? rgba(mix(accent, BLACK, 0.7), 0.95) : rgba(mix(accent, WHITE, 0.88), 0.96)
  return h('em', {
    className: 'bga-tagpill' + (style ? ' ' + style : ''),
    style: { background: rgba(bg, light ? 0.95 : 0.9), borderColor: rgba(line, 0.55), color: fg },
    title: name,
  }, name)
}
function tagPills(tags) {
  return h('div', { className: 'bga-tags' }, (tags || []).map(function (t) { return tagPill(t) }))
}
function tagPool(items) {
  var seen = {}, out = []
  items.forEach(function (it) {
    (it.tags || []).forEach(function (t) {
      if (!t || seen[t]) return
      seen[t] = 1
      out.push(t)
    })
  })
  return out.sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN') }).slice(0, 12)
}

// ------------------------------------------------- 二级图库网格 (memo 隔离) --
// 底图列表卡片多(几十~上百张)时, 拖动滑杆/改颜色等操作会让 SettingsPage 频繁
// 重渲染; 用 React.memo 让"数据引用、筛选、选中项都没变"的网格跳过重渲染,
// 图卡本身不重建, 显著减卡顿。点击卡片直接写 STORE, 不依赖父级回调。
// 图库卡片的选择、收藏和图单操作使用独立按钮，避免嵌套按钮。
var ItemGrid = React.memo(function ItemGrid(props) {
  var drag=React.useRef(null),overPair=React.useState(null),over=overPair[0],setOver=overPair[1]
  function move(it,index){if(props.items[index])props.onReorder(it.id,props.items[index].id)}
  return h('div', {className:'bga-library-grid'}, props.items.map(function (it,index) {
    var current = props.curId === it.id, checked = props.selected.indexOf(it.id) >= 0, favorite = props.favorites.indexOf(it.id) >= 0
    return h('article', {key:it.id, className:'bga-picture' + (current ? ' current' : '') + (checked ? ' picked' : '') + (over===it.id?' drop-target':''),
      onDragOver:function(e){if(props.reordering&&drag.current&&drag.current!==it.id){e.preventDefault();e.dataTransfer.dropEffect='move';setOver(it.id)}},
      onDragLeave:function(e){if(!e.currentTarget.contains(e.relatedTarget))setOver(null)},
      onDrop:function(e){if(!props.reordering||!drag.current)return;e.preventDefault();props.onReorder(drag.current,it.id);drag.current=null;setOver(null)}},
      h('button', {type:'button', className:'bga-picture-pick', 'aria-label':(props.multi ? '勾选 ' : '使用壁纸 ')+it.base,
        'aria-pressed': props.multi ? checked : current, onClick:function () {props.onPick(it)}},
        h('span', {className:'bga-picture-image'},
          h('img', {src:it.url+'?sz=preview',alt:'',loading:'lazy',decoding:'async',draggable:false}),
          props.reordering?h('span',{className:'bga-order-number'},index+1):null,
          current ? h('span', {className:'bga-picture-badge'}, '✓ 当前选择') : null,
          props.multi ? h('span', {className:'bga-check', 'aria-hidden':'true'}, checked ? '✓' : '') : null),
        h('span', {className:'bga-picture-name', title:it.base + ' · ' + (it.tags||[]).join(' / ')}, it.base)),
      props.reordering?h('div',{className:'bga-picture-foot bga-order-actions'},
        h('button',{type:'button',className:'bga-icon-btn bga-drag-handle',draggable:true,'aria-label':'拖动排序 '+it.base,'aria-describedby':'bga-sort-hint',
          onDragStart:function(e){drag.current=it.id;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(it.id));e.dataTransfer.setDragImage(e.currentTarget.closest('article'),20,20)},
          onDragEnd:function(){drag.current=null;setOver(null)},
          onKeyDown:function(e){if(e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();move(it,index+(e.key==='ArrowLeft'?-1:1))}}},'⠿'),
        h('button',{type:'button',className:'bga-icon-btn','aria-label':'向前移动 '+it.base,disabled:index===0,onClick:function(){move(it,index-1)}},'←'),
        h('button',{type:'button',className:'bga-icon-btn','aria-label':'向后移动 '+it.base,disabled:index===props.items.length-1,onClick:function(){move(it,index+1)}},'→')):
      h('div', {className:'bga-picture-foot'},
        tagPills(it.tags),
        h('button', {type:'button',className:'bga-icon-btn'+(favorite?' active':''),'aria-label':(favorite?'取消喜欢 ':'喜欢 ')+it.base,'aria-pressed':favorite,onClick:function(){toggleFavorite(it.id)}}, favorite?'♥':'♡'),
        h('button', {type:'button',className:'bga-icon-btn','aria-label':'将 '+it.base+' 加入图单',title:'加入图单',onClick:function(){props.onAdd([it.id])}}, '+')))
  }))
})

function PlaylistDialog(props) {
  var s = useBga(), data = props.data, editing = data.mode === 'edit', adding = data.mode === 'add'
  var existing = playlistById(data.id), ids = data.ids || []
  var namePair = React.useState(editing && existing ? existing.name : ''), name = namePair[0], setName = namePair[1]
  var checkedPair = React.useState(ids.length===1 ? s.playlists.filter(function(p){return p.items.indexOf(ids[0])>=0}).map(function(p){return p.id}) : []), checked=checkedPair[0],setChecked=checkedPair[1]
  var errorPair=React.useState(''), error=errorPair[0],setError=errorPair[1]
  var confirmPair=React.useState(false), confirming=confirmPair[0],setConfirming=confirmPair[1]
  var ref=React.useRef(null)
  React.useEffect(function(){
    var prior=document.activeElement, dialog=ref.current
    if(dialog && dialog.showModal) dialog.showModal()
    return function(){if(dialog && dialog.open)dialog.close();if(prior && prior.isConnected && prior.focus)prior.focus()}
  },[])
  function run(fn) { try {fn();props.onClose()} catch(e){setError(e.message)} }
  var title=editing?'编辑图单':adding?(ids.length>1?'将 '+ids.length+' 张壁纸加入图单':'收藏到图单'):'新建图单'
  return h('dialog',{ref:ref,className:'bga-dialog','aria-labelledby':'bga-dialog-title',onCancel:function(e){e.preventDefault();props.onClose()},onClick:function(e){if(e.target===e.currentTarget)props.onClose()}},
    h('form',{onSubmit:function(e){e.preventDefault();run(function(){
      if(editing)renamePlaylist(data.id,name)
      else if(adding)changeMembership(ids,checked,ids.length===1)
      else {var id=createPlaylist(name,ids);if(props.onCreated)props.onCreated(id)}
    })}},
      h('div',{className:'bga-dialog-head'},h('h3',{id:'bga-dialog-title'},title),h('button',{type:'button',className:'bga-icon-btn','aria-label':'关闭图单窗口',onClick:props.onClose},'×')),
      adding ? h('div',null,
        h('p',{className:'bga-muted'},ids.length>1?'可同时加入多个图单。':'勾选想收录的图单，取消勾选即可移出。'),
        h('div',{className:'bga-list-choices'},s.playlists.map(function(p){return h('label',{key:p.id,className:'bga-list-choice'},
          h('input',{type:'checkbox',checked:checked.indexOf(p.id)>=0,onChange:function(e){setChecked(e.target.checked?checked.concat(p.id):checked.filter(function(id){return id!==p.id}))}}),
          h('span',null,p.name),h('small',null,p.items.length+' 张'))})),
        h('div',{className:'bga-create-inline'},
          h('input',{className:'bga-input',value:name,maxLength:40,'aria-label':'新图单名称',placeholder:'也可以新建一个图单',onChange:function(e){setName(e.target.value);setError('')}}),
          h('button',{type:'button',className:'bga-btn',disabled:!name.trim(),onClick:function(){run(function(){createPlaylist(name,ids)})}},'创建并加入')))
        : h('label',{className:'bga-form-label'},'图单名称',h('input',{className:'bga-input',value:name,maxLength:40,autoFocus:true,placeholder:'例如：夜间工作、喜欢的角色',onChange:function(e){setName(e.target.value);setError('')}})),
      error ? h('p',{className:'bga-error',role:'alert'},error) : null,
      h('div',{className:'bga-dialog-actions'},
        editing ? h('button',{type:'button',className:'bga-btn bga-danger',onClick:function(){setConfirming(!confirming)}},'删除图单') : null,
        h('button',{type:'button',className:'bga-btn',onClick:props.onClose},'取消'),
        h('button',{type:'submit',className:'bga-btn bga-primary',disabled:adding?(ids.length>1&&!checked.length):!name.trim()},adding?(ids.length>1?'加入所选图单':'保存'):(editing?'保存名称':'创建图单'))),
      confirming ? h('div',{className:'bga-delete-confirm'},
        h('p',null,'删除“'+(existing?existing.name:'')+'”？原图片会保留。'+(s.playbackSource==='list:'+data.id?' 该图单的轮播会暂停。':'')),
        h('button',{type:'button',className:'bga-btn bga-danger',onClick:function(){run(function(){removePlaylist(data.id);if(props.onDeleted)props.onDeleted()})}},'确认删除图单')) : null))
}

function PlaybackSourceSelect() {
  var s=useBga(), currentKnown=s.playbackSource==='all'||s.playbackSource.indexOf('list:')===0&&!!playlistById(s.playbackSource.slice(5))||STORE.categories.some(function(c){return 'cat:'+c.name===s.playbackSource})
  return h('label',{className:'bga-source-control'},h('span',null,'切换范围'),
    h('select',{'aria-label':'切换范围',value:s.playbackSource,onChange:function(e){setPlaybackSource(e.target.value)}},
      h('option',{value:'all'},'全部壁纸'),
      !currentKnown ? h('option',{value:s.playbackSource},sourceLabel(s.playbackSource)+'（暂不可用）') : null,
      h('optgroup',{label:'我的图单'},s.playlists.map(function(p){return h('option',{key:p.id,value:'list:'+p.id},p.name+' · '+sourceItems('list:'+p.id).length+' 张')})),
      h('optgroup',{label:'文件夹'},STORE.categories.map(function(c){return h('option',{key:c.name,value:'cat:'+c.name},c.name+' · '+c.count+' 张')}))))
}
function PlaybackModeSelect() {
  var s=useBga()
  return h('label',{className:'bga-source-control'},h('span',null,'播放顺序'),
    h('select',{'aria-label':'播放顺序',value:s.playbackMode,onChange:function(e){setPlaybackMode(e.target.value)}},
      h('option',{value:'random'},'随机播放'),h('option',{value:'ordered'},'顺序播放')))
}

function AppearancePanel() {
  var s=useBga(),frame=framingOf(s,s.wallpaper),hasImage=!!s.wallpaper
  var st=s.styles||{}
  function patchStyles(values){STORE.set({styles:Object.assign({},STORE.state.styles||{},values)})}
  var fxHint={firefly:'轻盈的光点与流星',bubble:'柔和上浮的透明气泡',petal:'缓缓飘落的花瓣',rain:'细密的斜向雨丝',off:'保持安静，不显示装饰'}
  return h('div',{className:'bga-panel-stack'},
    Section('这张壁纸的构图',hasImage?'缩放与焦点仅为“'+curLabel(s.wallpaper)+'”保存，换回来会自动恢复。':'先选择一张静态壁纸，再调整构图。',
      h('fieldset',{className:'bga-framing-controls',disabled:!hasImage},
        h('div',{className:'bga-control-grid'},Slider('壁纸缩放',frame.zoom,1,2.2,function(v){setImageFraming({zoom:v})},'x')),
        h('div',{className:'bga-focus-row'},h('div',null,h('b',null,'画面焦点'),h('p',{className:'bga-muted'},'选择裁剪时保留的位置')),
          h('div',{className:'bga-foci','aria-label':'画面焦点'},FOCI.map(function(fc,i){return h('button',{key:fc.id,type:'button',className:'bga-focus'+(frame.focus===fc.pos?' on':''),'aria-label':['左上','上方','右上','左侧','居中','右侧','左下','下方','右下'][i],'aria-pressed':frame.focus===fc.pos,onClick:function(){setImageFraming({focus:fc.pos})}},h('i',null))}))),
        h('button',{type:'button',className:'bga-text-btn bga-frame-reset',onClick:resetImageFraming},'恢复这张图的默认构图'))),
    Section('画面与透明度', '这些设置应用于所有壁纸。',
      h('div',{className:'bga-control-grid'},
        Slider('壁纸暗纱',s.veil,0,0.85,function(v){STORE.set({veil:v})}),
        Slider('界面透明度',s.glass,0,1,function(v){STORE.set({glass:v})}))),
    // v1.16.0 分支: 浅色主题下外框/侧栏/会话区原来是一层近白薄纱（底图"盖了层白布"）。
    // 这里换成带底图色调的浅色 + 单独的不透明度调节。
    // v1.16.1（用户 2026-10-01）：去掉"官方客户端"字样；上限收在 30%（再高就把底图洗白了）。
    Section('界面底色', '会话区/侧栏/外框的底色。调低底图更清楚, 调高文字更稳; 上限 30%。',
      h('div',{className:'bga-control-grid'},
        Slider('表面不透明度',st.surface,0,SURFACE_MAX,function(v){patchStyles({surface:v})}),
        Slider('气泡阴影强度',st.bubble,0,1,function(v){patchStyles({bubble:v})})),
      TinySwitch('高清底图先出预览图，再升清',st.preview!==false,function(v){patchStyles({preview:v})}),
      h('p',{className:'bga-muted'},'表面不透明度管的是大面积表面(会话区/侧栏/外框); 输入框卡面与「界面透明度」在下面「输入框」一节。气泡阴影跟着气泡里的文字走(清空气泡也看得见), 0 = 关掉。')),
    Section('配色',null,
      h('div',{className:'bga-swatches'},PRESETS.map(function(p){return h('button',{key:p.id,type:'button',className:'bga-swatch'+(s.preset===p.id?' on':''),'aria-pressed':s.preset===p.id,onClick:function(){STORE.set({preset:p.id,accent:p.accent,deep:p.deep})}},
        h('span',{className:'bga-dots'},h('span',{className:'bga-dot',style:{background:p.accent}}),h('span',{className:'bga-dot',style:{background:p.deep}})),p.name)})),
      h('details',{className:'bga-details'},h('summary',null,'自定义颜色'),h('div',{className:'bga-row'},
        h('label',{className:'bga-field'},'强调色 ',h('input',{type:'color',value:s.accent,onChange:function(e){STORE.set({accent:e.target.value,preset:'custom'})}})),
        h('label',{className:'bga-field'},'深色底 ',h('input',{type:'color',value:s.deep,onChange:function(e){STORE.set({deep:e.target.value,preset:'custom'})}}))))),
    // v1.16.1: 卡面模糊前 2px 才是用户真正在调的区间, 24px 的线性滑杆里那一段只占 8% 行程。
    // 用 Slider 的 stops 机制把前段拉长: 0 / .5 / 1 / 1.5 / 2 各占 1/6 行程, 2px 之后
    // 回到 3/4/6/8/12/16/24 的粗档 (用户 2026-10-01: "0~2px 敏感调节, 后面保持现状")。
    Section('输入框',null,h('div',{className:'bga-control-grid'},
      Slider('卡面不透明度',s.cardA,0,1,function(v){STORE.set({cardA:v})}),
      Slider('卡面模糊',s.cardBlur,0,24,function(v){STORE.set({cardBlur:v})},'px',BLUR_STOPS)),
      TinySwitch('显示卡面阴影',s.cardShadow!==false,function(v){STORE.set({cardShadow:v})})),
    Section('输入框装饰',null,h('div',{className:'bga-fxopts'},EFFECTS.map(function(fx){return h('button',{key:fx.id,type:'button',className:'bga-fxopt'+(s.effect===fx.id?' on':''),'aria-pressed':s.effect===fx.id,onClick:function(){STORE.set({effect:fx.id})}},h('b',null,fx.name),h('span',null,fxHint[fx.id]))}))))
}

function PlaybackPanel() {
  var s=useBga(), count=sourceItems(s.playbackSource).length
  return h('div',{className:'bga-panel-stack'},
    Section('轮播',null,h('div',{className:'bga-row'},h(PlaybackSourceSelect),h(PlaybackModeSelect)),
      h('p',{className:'bga-muted'},count?'“换一张”、侧栏宝珠和自动轮播都从这里选图。':'这个范围暂时没有可用壁纸，加入图片后即可切换。'),
      h('p',{className:'bga-muted'},s.playbackMode==='ordered'?'按图单排列顺序循环；文件夹按图库顺序播放。':'随机播放，同轮内尽量不重复。'),
      TinySwitch('自动轮播',s.autoOn===true,function(v){STORE.set({autoOn:v})}),
      h('fieldset',{className:'bga-control-grid',disabled:!s.autoOn},Slider('切换间隔',s.autoMin,1,120,function(v){STORE.set({autoMin:v})},'min',AUTO_STOPS)),
      h('p',{className:'bga-muted'},'手动换图后重新计时；后台暂停，回到前台后重新计算完整间隔。')),
    Section('渐变',null,TinySwitch('渐变切换',s.fadeOn!==false,function(v){STORE.set({fadeOn:v})}),
      h('fieldset',{className:'bga-control-grid',disabled:s.fadeOn===false},
        Slider('开始前等待',s.fadeDelayMs,0,1000,function(v){STORE.set({fadeDelayMs:v})},'ms'),
        Slider('渐变时长',s.fadeMs,100,5000,function(v){STORE.set({fadeMs:v})},'ms')),
      h('p',{className:'bga-muted'},'手动连点会随节奏加快：1 秒、500 毫秒、300 毫秒。停顿 1.5 秒后恢复设定时长，正在渐变的画面也会提速。'),
      h('p',{className:'bga-muted'},'只会缩短，不会延长；快速连点时跳过开始前等待。自动轮播沿用设定时长。')))
}

// 低频管理操作收进抽屉；下载轮询随组件卸载清理。
function LibraryTools(props) {
  var pair=React.useState(null),prog=pair[0],setProg=pair[1],live=React.useRef(true),timer=React.useRef(0)
  function poll() {
    fetch('/bga/wallpapers/fetch-status',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('状态读取失败');return r.json()}).then(function(st){
      if(!live.current)return
      setProg(st)
      if(st.running)timer.current=setTimeout(poll,1000)
      else if(st.finishedAt)props.refresh()
    }).catch(function(){if(live.current)setProg({error:'暂时无法读取下载进度，请稍后重试'})})
  }
  React.useEffect(function(){live.current=true;poll();return function(){live.current=false;clearTimeout(timer.current)}},[])
  function download(){
    setProg({running:true})
    fetch('/bga/wallpapers/fetch',{method:'POST'}).then(function(r){if(!r.ok)throw new Error('下载请求失败');return r.json()}).then(function(r){if(r.error)throw new Error(r.error);if(live.current)poll()}).catch(function(e){if(live.current)setProg({error:e.message})})
  }
  return h('details',{className:'bga-details'},h('summary',null,'管理壁纸文件'),
    h('p',{className:'bga-muted'},'将图片放入下方文件夹，再刷新图库。子文件夹会自动显示在“文件夹”中。'),
    h('div',{className:'bga-directory'},STORE.writableDir||STORE.listDir||'正在读取目录'),
    STORE.writableDir&&STORE.listDir&&STORE.writableDir!==STORE.listDir ? h('p',{className:'bga-muted'},'当前图片来源：'+STORE.listDir) : null,
    h('div',{className:'bga-row'},h('button',{type:'button',className:'bga-btn',onClick:props.refresh,disabled:props.loading},props.loading?'刷新中…':'刷新图库'),
      h('button',{type:'button',className:'bga-btn',onClick:download,disabled:!!(prog&&prog.running)},prog&&prog.running?'下载中…':'下载内置壁纸')),
    prog&&(prog.running||prog.finishedAt||prog.error) ? h('p',{className:prog.error?'bga-error':'bga-muted',role:'status'},prog.error||((prog.done||0)+' / '+(prog.total||0)+' 张 · 已下载 '+(prog.downloaded||0)+' · 跳过 '+(prog.skipped||0)+(prog.failed?' · 失败 '+prog.failed:''))) : null,
    STORE.skipped.length ? h('p',{className:'bga-muted'},'已略过 '+STORE.skipped.length+' 个不支持的文件。') : null)
}

function SettingsPage() {
  var s=useBga(),cur=s.wallpaper, favorites=playlistById('favorites').items
  var frame=framingOf(s,cur)
  var tabPair=React.useState('library'),tab=tabPair[0],setTab=tabPair[1]
  var sourcePair=React.useState('all'),source=sourcePair[0],setSource=sourcePair[1]
  var queryPair=React.useState(''),query=queryPair[0],setQuery=queryPair[1]
  var qualityPair=React.useState('all'),quality=qualityPair[0],setQuality=qualityPair[1]
  // v1.16.5: 标签筛选。标签气泡点一下就按它筛（一次一个, 再点取消）。
  var tagPair=React.useState(''),tagFilter=tagPair[0],setTagFilter=tagPair[1]
  var multiPair=React.useState(false),multi=multiPair[0],setMulti=multiPair[1]
  var sortPair=React.useState(false),sorting=sortPair[0],setSorting=sortPair[1]
  var pickedPair=React.useState([]),picked=pickedPair[0],setPicked=pickedPair[1]
  var modalPair=React.useState(null),modal=modalPair[0],setModal=modalPair[1]
  var loadPair=React.useState(true),loading=loadPair[0],setLoading=loadPair[1]
  var errorPair=React.useState(''),error=errorPair[0],setError=errorPair[1]
  var life=React.useRef(true),loadSeq=React.useRef(0)
  var weRefresh=React.useState(0)[1]
  React.useEffect(function(){
    var update=function(){weRefresh(function(n){return n+1})}
    WE_WATCHERS.push(update)
    return function(){var i=WE_WATCHERS.indexOf(update);if(i>=0)WE_WATCHERS.splice(i,1)}
  },[])
  function refresh(){
    var seq=++loadSeq.current;setLoading(true);setError('')
    fetchList().then(function(){if(life.current&&seq===loadSeq.current){setLoading(false);STORE.touch()}}).catch(function(){if(life.current&&seq===loadSeq.current){setLoading(false);setError('图库暂时无法加载，请重试。')}})
  }
  React.useEffect(function(){life.current=true;refresh();return function(){life.current=false;loadSeq.current++}},[])
  React.useEffect(function(){if(source.indexOf('list:')===0&&!playlistById(source.slice(5))){setSource('all');setPicked([]);setSorting(false)}},[s.playlists,source])
  function browse(value){setSource(value);setPicked([]);setQuery('');setQuality('all');setTagFilter('');setSorting(false)}
  function add(ids){setModal({mode:'add',ids:ids})}
  var choose=React.useCallback(function(it){
    if(multi)setPicked(function(prev){return prev.indexOf(it.id)>=0?prev.filter(function(id){return id!==it.id}):prev.concat(it.id)})
    else {releaseWeForStatic();setWallpaper(it)}
  },[multi])
  var openAdd=React.useCallback(function(ids){setModal({mode:'add',ids:ids})},[])
  var reorderCurrent=React.useCallback(function(from,to){if(source.indexOf('list:')===0)reorderPlaylist(source.slice(5),from,to)},[source])
  var items=React.useMemo(function(){
    var q=query.trim().toLocaleLowerCase()
    // v1.16.4: 搜索也匹配**标签** —— 图在「高清」目录里但标签带「重返未来1999」时,
    // 搜"重返"或"6·1"都能把它翻出来(用户要的"搜 6·1 出两版")。
    return sourceItems(source).filter(function(it){
      if(quality!=='all'&&(quality==='hd'?!it.hd:it.hd))return false
      if(tagFilter&&(it.tags||[]).indexOf(tagFilter)<0)return false
      if(!q)return true
      var hay=(it.base+' '+it.cat+' '+(it.tags||[]).join(' ')).toLocaleLowerCase()
      return hay.indexOf(q)>=0
    })
  },[source,query,quality,tagFilter,s.playlists,source==='recent'?s.recent:null,STORE.list])
  // 标签气泡栏的候选: 当前来源 + 清晰度筛出来的图里出现过的标签（最多 12 个, 按名排）。
  var tagPoolItems=React.useMemo(function(){
    return tagPool(sourceItems(source).filter(function(it){return quality==='all'||(quality==='hd'?!!it.hd:!it.hd)}))
  },[source,quality,s.playlists,STORE.list])
  var pool=sourceItems(s.playbackSource), activeList=source.indexOf('list:')===0?playlistById(source.slice(5)):null
  var missing=activeList?activeList.items.length-sourceItems(source).length:0, liveBg=weIsBackground()
  var curFavorite=cur&&favorites.indexOf(cur.id)>=0
  var tabs=[['library','图库'],['appearance','外观'],['playback','切换'],['dynamic','动态壁纸']]
  function tabKeys(e){
    var i=tabs.findIndex(function(t){return t[0]===tab}),next
    if(e.key==='ArrowRight')next=(i+1)%tabs.length
    else if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length
    else if(e.key==='Home')next=0
    else if(e.key==='End')next=tabs.length-1
    else return
    e.preventDefault();setTab(tabs[next][0]);e.currentTarget.parentNode.querySelectorAll('[role=tab]')[next].focus()
  }
  function navItem(key,label,count){return h('button',{key:key,type:'button',className:'bga-nav-item'+(source===key?' on':''),'aria-pressed':source===key,onClick:function(){browse(key)}},h('span',null,label),h('small',null,count))}
  var library=h('div',{className:'bga-library'},
    h('aside',{className:'bga-library-nav','aria-label':'图库与图单'},
      navItem('all','全部壁纸',STORE.list.length),navItem('list:favorites','♥ 我喜欢',sourceItems('list:favorites').length),navItem('recent','最近使用',sourceItems('recent').length),
      h('div',{className:'bga-nav-heading'},h('span',null,'我的图单'),h('button',{type:'button',className:'bga-icon-btn','aria-label':'新建图单',title:'新建图单',onClick:function(){setModal({mode:'create'})}},'+')),
      s.playlists.filter(function(p){return p.id!=='favorites'}).map(function(p){return navItem('list:'+p.id,p.name,sourceItems('list:'+p.id).length)}),
      s.playlists.length===1?h('p',{className:'bga-nav-hint'},'把喜欢的画面，收进自己的图单。'):null,
      h('details',{className:'bga-folder-list',open:true},h('summary',null,'文件夹'),STORE.categories.map(function(c){return navItem('cat:'+c.name,c.name,c.count)}))),
    h('div',{className:'bga-library-main'},
      h('div',{className:'bga-library-heading'},h('div',null,h('h3',null,sourceLabel(source)),h('span',{className:'bga-muted'},items.length+' 张'+(missing?' · '+missing+' 张文件暂不可用':''))),
        h('div',{className:'bga-row'},source!=='recent'?h('button',{type:'button',className:'bga-btn'+(s.playbackSource===source?' bga-active':''),disabled:s.playbackSource===source||!sourceItems(source).length,onClick:function(){setPlaybackSource(source)}},s.playbackSource===source?'✓ 当前切换范围':'设为切换范围'):null,
          activeList&&activeList.id!=='favorites'?h('button',{type:'button',className:'bga-icon-btn','aria-label':'编辑图单 '+activeList.name,onClick:function(){setModal({mode:'edit',id:activeList.id})}},'⋯'):null)),
      activeList?h('div',{className:'bga-sort-bar'},h('button',{type:'button',className:'bga-btn','aria-pressed':sorting,disabled:sourceItems(source).length<2,onClick:function(){setSorting(!sorting);setMulti(false);setPicked([]);setQuery('');setQuality('all');setTagFilter('')}},sorting?'完成排序':'调整顺序'),
        h('span',{id:'bga-sort-hint',className:'bga-muted'},sorting?'拖动卡片下方手柄，或用左右箭头调整。':'顺序播放时，按这里的排列切换。')):null,
      h('div',{className:'bga-library-toolbar'},
        h('input',{type:'search',className:'bga-input',value:query,disabled:sorting,'aria-label':'搜索静态壁纸',placeholder:'搜索名称或类型',onChange:function(e){setQuery(e.target.value)}}),
        h('select',{'aria-label':'清晰度筛选',value:quality,disabled:sorting,onChange:function(e){setQuality(e.target.value)}},h('option',{value:'all'},'全部清晰度'),h('option',{value:'hd'},'高清'),h('option',{value:'normal'},'普通')),
        h('button',{type:'button',className:'bga-btn','aria-pressed':multi,disabled:sorting,onClick:function(){setMulti(!multi);setPicked([])}},multi?'完成':'多选')),
      // 标签气泡栏 (v1.16.5): 点一下按该标签筛, 再点取消。气泡只显示标签名, 与卡片上的气泡同一套样式。
      !sorting&&tagPoolItems.length>1?h('div',{className:'bga-tagbar',role:'group','aria-label':'按标签筛选'},
        tagPoolItems.map(function(t){return h('button',{key:t,type:'button',className:'bga-chip bga-tagchip'+(tagFilter===t?' on':''),'aria-pressed':tagFilter===t,title:'筛选标签：'+t,onClick:function(){setTagFilter(tagFilter===t?'':t);setPicked([])}},tagPill(t))})):null,
      multi?h('div',{className:'bga-batch'},h('span',{role:'status'},'已选 '+picked.length+' 张'),
        h('button',{type:'button',className:'bga-btn',disabled:!items.length,onClick:function(){setPicked(items.map(function(it){return it.id}))}},'全选结果'),
        h('button',{type:'button',className:'bga-btn',disabled:!picked.length,onClick:function(){add(picked)}},'加入图单'),
        activeList?h('button',{type:'button',className:'bga-btn',disabled:!picked.length,onClick:function(){removeFromPlaylist(activeList.id,picked);setPicked([])}},'移出此图单'):null):null,
      error?h('div',{className:'bga-empty',role:'alert'},error,h('button',{type:'button',className:'bga-btn',onClick:refresh},'重试')):
        loading&&!STORE.list.length?h('div',{className:'bga-empty',role:'status'},'正在加载图库…'):
        items.length?h(ItemGrid,{items:items,curId:cur&&cur.id,favorites:favorites,multi:multi,selected:picked,onPick:choose,onAdd:openAdd,reordering:sorting&&!!activeList,onReorder:reorderCurrent}):
          h('div',{className:'bga-empty'},h('b',null,query||quality!=='all'?'没有找到匹配的壁纸':source==='recent'?'还没有使用记录':activeList?'这个图单还是空的':'这里还没有壁纸'),
            h('p',null,activeList&&!query?'去图库挑选图片，用“＋”收进来。':query?'试试更短的关键词，或调整清晰度筛选。':'选择一张喜欢的壁纸，从这里开始。'),
            activeList?h('button',{type:'button',className:'bga-btn',onClick:function(){browse('all')}},'去图库选图'):null),
      h(LibraryTools,{refresh:refresh,loading:loading})))
  if(!stateLoaded) return h('div',{className:'bga-page bga-studio'},h('div',{className:'bga-empty',role:'status'},
    h('b',null,STORE.saveStatus==='load-error'?'暂时无法读取设置':'正在打开底图工坊…'),
    STORE.saveStatus==='load-error'?h('p',null,'连接恢复后即可整理图单，现有设置会保留。'):null,
    STORE.saveStatus==='load-error'?h('button',{type:'button',className:'bga-btn',onClick:function(){STORE.saveStatus='loading';STORE.touch();STORE.load()}},'重新连接'):null))
  return h('div',{className:'bga-page bga-studio'},
    h('header',{className:'bga-studio-heading'},h('div',null,h('h2',null,'底图工坊'),h('p',{className:'bga-muted'},'收藏画面，编成你的图单。')),
      h('span',{className:'bga-save-state',role:'status'},STORE.saveStatus==='error'?'保存失败':STORE.saveStatus==='saving'?'正在保存…':stateLoaded?'已保存':'正在连接…'),
      STORE.saveStatus==='error'?h('button',{type:'button',className:'bga-btn',onClick:function(){STORE.save();STORE.touch()}},'重试保存'):null),
    h('div',{className:'bga-hero'},
      cur&&cur.url?h('img',{className:'bga-hero-image',src:cur.url,alt:'当前选择：'+curLabel(cur),style:{objectPosition:frame.focus,transform:'scale('+frame.zoom+')',transformOrigin:frame.focus}}):null,
      h('div',{className:'bga-hero-shade'}),
      h('div',{className:'bga-hero-info'},h('span',{className:'bga-eyebrow'},liveBg?'静态底图预览':'当前选择'),h('strong',null,cur?bareName(cur.name||cur.file):'从一张喜欢的壁纸开始'),h('span',null,liveBg?'正在使用动态壁纸；在图库选择图片可切回静态':cur?(cur.cat||'')+(cur.hd?' · 高清':''):'浏览图库，或创建你的第一个图单'))),
    h('div',{className:'bga-player'},
      h('div',{className:'bga-row'},
        h('button',{type:'button',className:'bga-btn',disabled:liveBg||!canPreviousWallpaper(),onClick:previousWallpaper,title:'返回当前范围内上一次选择'},'上一张'),
        h('button',{type:'button',className:'bga-btn bga-primary',disabled:!pool.length||liveBg,onClick:cycleWallpaper},'换一张'),
        h('button',{type:'button',className:'bga-btn',disabled:(!pool.length||liveBg)&&!s.autoOn,onClick:function(){STORE.set({autoOn:!s.autoOn})}},s.autoOn?'暂停轮播':'开始轮播'),
        h('button',{type:'button',className:'bga-btn'+(curFavorite?' bga-active':''),disabled:!cur||!cur.id,onClick:function(){toggleFavorite(cur.id)}},curFavorite?'♥ 已喜欢':'♡ 喜欢'),
        h('button',{type:'button',className:'bga-btn',disabled:!cur||!cur.id,onClick:function(){add([cur.id])}},'＋ 图单')),
      h('div',{className:'bga-player-source'},h('div',{className:'bga-row'},h(PlaybackSourceSelect),h(PlaybackModeSelect)),h('span',{className:'bga-muted'},liveBg?'静态轮播已暂挂':pool.length?(s.autoOn?'每 '+s.autoMin+' 分钟切换':'轮播已暂停'):'暂无可切换图片'))),
    h('div',{className:'bga-tabs',role:'tablist','aria-label':'底图工坊设置'},tabs.map(function(t){return h('button',{key:t[0],type:'button',role:'tab',id:'bga-tab-'+t[0],'aria-controls':'bga-panel-'+t[0],'aria-selected':tab===t[0],tabIndex:tab===t[0]?0:-1,onClick:function(){setTab(t[0])},onKeyDown:tabKeys},t[1])})),
    h('div',{className:'bga-tab-panel',role:'tabpanel',id:'bga-panel-'+tab,'aria-labelledby':'bga-tab-'+tab},tab==='library'?library:tab==='appearance'?h(AppearancePanel):tab==='playback'?h(PlaybackPanel):h(WeSection)),
    h('footer',{className:'bga-studio-footer'},h('span',null,STORE.list.length+' 张壁纸 · '+s.playlists.length+' 个图单'),cur?h('button',{type:'button',className:'bga-text-btn',onClick:function(){STORE.set({wallpaper:null})}},'清除静态底图'):null),
    modal?h(PlaylistDialog,{key:modal.mode+':'+(modal.id||'')+':'+(modal.ids||[]).join('|'),data:modal,onClose:function(){setModal(null)},onCreated:function(id){browse('list:'+id)},onDeleted:function(){browse('all')}}):null)
}


// ------------------------------------------------------------ WE 壁纸库 ----
// Wallpaper Engine 接入。host 侧 /bga/we/* 路由提供库清单与媒体流;
// 这里三块: WeSection(设置页列表) + WE_LAYER(全屏动效层, 挂 <html>) + WE 配色联动。
// scene 可用桌面原生桥接收 WE 实时画面；静态模式和连接失败时保留静态近似。

var WE_TYPE_LABEL = {
  video: ['视频', '#3b82f6'],
  web: ['网页', '#22c55e'],
  scene: ['场景', '#a855f7'],
  application: ['程序', '#eab308'],
  unknown: ['暂不支持', '#6b7280'],
}

// ---------------------------------------------------------------- WE 端点前缀
// WE 库/媒体/静态图/启动这几个端点的**唯一准星**。原来 6 处硬编码 '/bga/we/...' 散在
// 函数、fetch、按钮回调里，改前缀要满文件找。
//
// 现在有两套端点可用（移植期并存）：
//   '/bga/we'  —— 本插件自己的 host 半（we/routes.js）
//   '/dwl'     —— 独立的 dsh-WE-library 插件（已建库 + 实机验证）
// 切哪边只改这一个常量。两边共用同一份扫描代码（新插件就是从这移植过去的），
// 实测 library.json 返回**同样的 37 条、同样的 id 序列**，所以切换时视觉 oracle
// 应当完全没有差异 —— 那正是这次切换的验收判据。
// 当前值：'/dwl'（独立插件）。回退就把这行改回 '/bga/we'。
var WE_PREFIX = '/dwl'
function weUrl(pathPart) { return WE_PREFIX + pathPart }

function weMediaUrl(entry, rel) {
  var segs = String(rel).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  return weUrl('/media/') + encodeURIComponent(entry.id) + '/' + segs
}

// scene 类的高清静态图（host 侧解 scene.pkg 合成，见 we/still.js）
function weStillUrl(id) { return weUrl('/still/') + encodeURIComponent(id) + '.webp' }

// ---------------------------------------------------------------- WE 库数据来源层
// 库浏览要的两个接口（库清单 + 桥状态）原先内联在 WeSection 的 load() 里，另一处
// weRestore 又自己 fetch 了一遍 library.json。抽成一层有两个好处：
//   ① 将来把库浏览 UI 整体搬到独立插件时，这层可以直接换成"调新插件的 API"，UI 不用动；
//   ② abort/竞态处理只有一份 —— 现在 WeSection 里那套 AbortController + requests 簿记，
//      和 weRestore 里裸 fetch 的写法是两套，容易漏。
// 只做**数据**，不碰渲染；实时消费链路（weStartNative/getDisplayMedia）完全不经这里。
var WeSource = (function () {
  // ⚠️ 请求槽**按调用方隔离**，不是按 kind 共享。这是修一个真缺陷：
  //   原来 `inflight` 只按 kind 记（library/status 各一个槽），于是 `library()` 一进来
  //   就 `abort('library')` —— **任何调用方都会取消别的调用方**在飞的那次。
  //   实际后果：启动恢复（weRestore）正在取库清单时，用户一打开设置页，设置页那次
  //   `library()` 就把恢复请求取消掉 ⇒ **选中的 WE 背景恢复不出来**，而且不报错。
  //   审核方复现指出了这一点；我原来那句"启动时的独立读、与设置页无竞争"的注释是**错的**。
  // 现在：key = 调用方名 + kind，同调用方同 kind 才互相取消（那才是真正的"后发覆盖先发"）。
  var inflight = {}   // "caller:kind" -> AbortController
  function slot(caller, kind) { return String(caller) + ':' + kind }
  function abort(key) {
    if (inflight[key]) { try { inflight[key].abort() } catch (e) { /* noop */ } inflight[key] = null }
  }
  /** 取消某个调用方的所有在飞请求（组件卸载用；不传 caller 则全取消）。 */
  function abortAll(caller) {
    for (var k in inflight) {
      if (caller === undefined || k.indexOf(String(caller) + ':') === 0) abort(k)
    }
  }

  /**
   * 取库清单。force=true 让 host 跳过缓存重扫。返回 {ok, entries, weFound, error}。
   * caller 用来隔离请求槽（见上方注释）；不给就落到 'default'。
   */
  function library(force, signal, caller) {
    var key = slot(caller || 'default', 'library')
    abort(key)
    var ctl = new AbortController()
    inflight[key] = ctl
    if (signal) signal.addEventListener('abort', function () { try { ctl.abort() } catch (e) { /* noop */ } })
    return fetch(weUrl('/library.json') + (force ? '?force=1' : ''), { cache: 'no-store', signal: ctl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (d) {
        if (ctl.signal.aborted) return { ok: false, aborted: true }
        return { ok: true, entries: d.entries || [], weFound: !!d.weFound }
      })
      .catch(function (e) {
        if (ctl.signal.aborted) return { ok: false, aborted: true }
        return { ok: false, error: String((e && e.message) || e) }
      })
  }

  /** 取桥状态（原生桥是否可用/在跑）。caller 同 library，用来隔离请求槽。 */
  function status(force, signal, caller) {
    var key = slot(caller || 'default', 'status')
    abort(key)
    var ctl = new AbortController()
    inflight[key] = ctl
    if (signal) signal.addEventListener('abort', function () { try { ctl.abort() } catch (e) { /* noop */ } })
    return fetch(weUrl('/status') + (force ? '?force=1' : ''), { cache: 'no-store', signal: ctl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (d) {
        if (ctl.signal.aborted) return { ok: false, aborted: true }
        return { ok: true, bridge: d.bridge }
      })
      .catch(function (e) {
        if (ctl.signal.aborted) return { ok: false, aborted: true }
        return { ok: false, error: String((e && e.message) || e) }
      })
  }

  return { library: library, status: status, abort: abort, abortAll: abortAll }
})()

// 先铺 192px 的 preview.gif（秒出），同时让 host 去解包出高清静态图，好了再换上去。
// 解包一次约 5s，不值得让用户对着空白等，也不该阻塞请求。
var WE_NOTICES = new Map()
var WE_QUALITY = {
  smooth: { name: '流畅', fps: 60 },
  balanced: { name: '均衡', fps: 45 },
  saver: { name: '省资源', fps: 30 },
}
var WE_STATS = new Map(), WE_STATS_WATCHERS = []
function weStats(id, data) { if (data) WE_STATS.set(id, data); else WE_STATS.delete(id); WE_STATS_WATCHERS.forEach(function (f) { f() }) }
function weNotice(id, message) {
  WE_NOTICES.set(id, message)
  if (WE_NOTICES.size > 256) WE_NOTICES.delete(WE_NOTICES.keys().next().value)
  weNotify()
}

// The companion WE window follows DSH's native content rectangle. WE reads the
// actual cursor itself; this video layer never consumes clicks or keyboard input.
function weStartNative(entry, root) {
  var bridge = window.dshWallpaper, destroyed = false, generation = 0
  var bridgeVisible = !document.hidden
  var stream = null, video = null, token = null, timer = null, stillCleanup = null
  var stopStats = null, placeholder = root.querySelector ? root.querySelector('img') : null
  function stopRun() {
    generation++
    clearTimeout(timer)
    if (stopStats) { stopStats(); stopStats = null }
    if (placeholder) placeholder.style.display = ''
    weStats(entry.id, null)
    var old = token; token = null
    if (stream) { stream.getTracks().forEach(function (t) { t.stop() }); stream = null }
    if (video) { video.remove(); video = null }
    if (old) bridge.stop(old).catch(function () {})
  }
  function fallback(message) {
    stopRun()
    console.error('[bga-live] ' + message)
    weNotice(entry.id, message + '；当前保留静态预览')
    if (!entry.stillReady && !stillCleanup) {
      var img = root.querySelector('img')
      if (img) stillCleanup = weUpgradeToStill(entry.id, img, message + '；')
    }
  }
  async function start() {
    if (destroyed || !bridgeVisible) return
    stopRun()
    var run = generation
    token = 'bga-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    var requested = token
    weNotice(entry.id, '正在连接 WE 原生场景…')
    timer = setTimeout(function () { if (!destroyed && run === generation) fallback('实时连接超时') }, 25000)
    try {
      var ready = await bridge.start(entry.id, requested)
      if (destroyed || run !== generation) { bridge.stop(requested).catch(function () {}); return }
      var quality = WE_QUALITY[STORE.state.weQuality] || WE_QUALITY.balanced
      // Windows window capture here stalls badly when forced to rescale. Keep
      // native pixels and adjust cadence only; mouse alignment remains exact.
      var next = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: quality.fps, max: quality.fps }, cursor: 'never' }, audio: false })
      if (destroyed || run !== generation) { next.getTracks().forEach(function (t) { t.stop() }); bridge.stop(requested).catch(function () {}); return }
      stream = next
      video = document.createElement('video')
      video.muted = true; video.autoplay = true; video.playsInline = true
      video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none'
      video.srcObject = stream
      root.appendChild(video)
      stream.getVideoTracks()[0].addEventListener('ended', function () {
        if (!destroyed && run === generation && bridgeVisible) fallback('WE 实时连接已结束')
      }, { once: true })
      await video.play()
      if (destroyed || run !== generation) return
      clearTimeout(timer)
      if (placeholder) placeholder.style.display = 'none'
      stopStats = weWatchFrames(entry.id, video)
      weNotice(entry.id, 'WE 原生实时场景 · 鼠标跟随 · ' + quality.name + '模式')
    } catch (e) {
      if (!destroyed && run === generation) fallback('实时背景未连接：' + String(e.message || e).slice(0, 180))
    }
  }
  var setVisible = function (visible) {
    if (bridgeVisible === visible) return
    bridgeVisible = visible
    if (!visible) { stopRun(); weNotice(entry.id, '窗口隐藏，实时背景已暂停') }
    else start()
  }
  var visibility = function () { setVisible(!document.hidden) }
  var unwatch = bridge.onVisibility ? bridge.onVisibility(setVisible) : null
  document.addEventListener('visibilitychange', visibility)
  // Start after weShow attaches the fallback image and root to the document.
  timer = setTimeout(start, 0)
  return function () {
    destroyed = true; stopRun()
    document.removeEventListener('visibilitychange', visibility)
    if (unwatch) unwatch()
    if (stillCleanup) stillCleanup()
  }
}
// Count presented frames; update only the small status component, never theme CSS.
function weWatchFrames(id, video) {
  if (!video.requestVideoFrameCallback) return function () {}
  var stopped = false, handle, first = null, frames = 0, previous = null, longest = 0
  function frame(now) {
    if (stopped) return
    if (first === null) first = now
    if (previous !== null) longest = Math.max(longest, now - previous)
    previous = now; frames++
    if (now - first >= 2000) {
      weStats(id, { fps: Math.round((frames - 1) * 10000 / (now - first)) / 10, width: video.videoWidth, height: video.videoHeight, gap: Math.round(longest) })
      frames = 1; first = now; longest = 0
    }
    handle = video.requestVideoFrameCallback(frame)
  }
  handle = video.requestVideoFrameCallback(frame)
  return function () { stopped = true; if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle) }
}
function WeLiveStatus(props) {
  var state = React.useState(0), bump = state[1]
  React.useEffect(function () { var f = function () { bump(function (n) { return n + 1 }) }; WE_STATS_WATCHERS.push(f); return function () { var i = WE_STATS_WATCHERS.indexOf(f); if (i >= 0) WE_STATS_WATCHERS.splice(i, 1) } }, [])
  var s = WE_STATS.get(props.id)
  return h('span', { className: 'bga-note', role: 'status' }, s ? '实时 ' + s.fps + ' 帧/秒 · ' + s.width + ' × ' + s.height + (s.gap > 100 ? ' · 检测到卡顿，可选省资源模式' : '') : '帧率将在播放后显示')
}
function weUpgradeToStill(id, img, prefix) {
  var controller = new AbortController(), timer, disposed = false
  function note(message) {
    WE_NOTICES.set(id, (prefix || '') + message)
    if (WE_NOTICES.size > 256) WE_NOTICES.delete(WE_NOTICES.keys().next().value)
    weNotify()
  }
  async function check(method, count) {
    if (disposed || !img.isConnected) return
    try {
      var response = await fetch(weUrl('/still?id=') + encodeURIComponent(id), { method: method, cache: 'no-store', signal: controller.signal })
      var result = await response.json()
      if (disposed) return
      if (!response.ok || result.state === 'error' || result.state === 'busy') throw new Error(result.error || 'HTTP ' + response.status)
      if (result.state === 'ready') { img.src = weStillUrl(id); note('静态近似图已就绪'); return }
      if (count >= 120) { note('仍在生成，稍后刷新查看；当前保留预览图'); return }
      note(result.state === 'queued' ? '静态图排队中，当前显示预览图' : '正在生成静态近似图…')
      timer = setTimeout(function () { check('GET', count + 1) }, 1500)
    } catch (e) {
      if (!disposed) note('静态图未生成：' + String(e.message || e).slice(0, 180) + '。保留预览图；失败后冷却一分钟再试。')
    }
  }
  // Called after the image is attached; disposal cancels polls, not a shared host job.
  timer = setTimeout(function () { check('POST', 0) }, 0)
  return function () { disposed = true; clearTimeout(timer); controller.abort() }
}

// "0.1 0.6 1" -> [r,g,b] 浮点；非法返回 null (与 host scanner 同规则)
function weParseSchemeColor(s) {
  if (typeof s !== 'string') return null
  var p = s.trim().split(/\s+/).map(Number)
  return p.length >= 3 && p.every(function (n) { return isFinite(n) }) ? [p[0], p[1], p[2]] : null
}

// schemeColor -> 底图工坊的 accent/deep: 主色直接采用, 深色取同色相暗调。
// 走 STORE.set 进现有持久化链路, 用户之后在「配色」区手动改即覆盖。
function weApplySchemeColor(rgbFloat) {
  var rgb = rgbFloat.map(function (x) { return Math.round(Math.max(0, Math.min(1, x)) * 255) })
  var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255
  var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  var hDeg = 0, sat = 0
  if (max !== min) {
    var d = max - min
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    hDeg = max === r ? (g - b) / d + (g < b ? 6 : 0)
      : max === g ? (b - r) / d + 2
      : (r - g) / d + 4
    hDeg *= 60
  }
  var hx = function (hH, hS, hL) { // HSL(0-360,0-1,0-1) -> #rrggbb
    var f = function (n) {
      var k = (n + hH / 30) % 12
      var a = hS * Math.min(hL, 1 - hL)
      var v = hL - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
      return Math.round(255 * v).toString(16).padStart(2, '0')
    }
    return '#' + f(0) + f(8) + f(4)
  }
  STORE.set({
    accent: hx(hDeg, Math.max(sat, 0.35), 0.62),
    deep: hx(hDeg, Math.min(sat + 0.15, 0.9), 0.10),
    preset: 'custom',
  })
}

// ---- 全屏动效层 (video / web / scene 三态) ----
// **必须 append 到 documentElement, 不能挂 body**: DSH 应用根节点带 transform/filter 类属性时
// 自成 stacking context, body 子树里的负 z-index 会被钳在它自己的背景之后。挂 html 上则与底图的
// body::before(-1) 同属根层叠上下文: 本层 -2 < -1, 观感 = 动效垫在暗纱与界面之下。
//
// 「应用了动效」必须连带两件事, 否则画面不动（实机踩过的两个坑）:
//   ① 有底图时 dynamicCss 不再画底图 —— body::before(-1) 会盖死动效层(-2);
//   ② 主题 token 把应用外框调成半透明 —— 没底图时 .frame 用 DSH 默认不透明底色,
//      半透明的 --dsw-alias-bg-base 只在有底图时才下发。
// 这两件事都发生在重建样式时, 所以用 WE_WATCHERS 把 apply() 里的 rebuildStyle/rebuildTokens 接进来。
var WE_LAYER = { root: null, cleanup: null }
var WE_WATCHERS = []

function weActive() { return !!WE_LAYER.root }

// ---------------------------------------------------------------- 背景来源（background source）
// 「现在是谁在当背景」这件事，重构前散在 15 处判断里、且**两种信号混用**：
//   · STORE.state.weId  = 用户**意图**（选了一张 WE 壁纸，但可能还没挂上/已失败回落静态）
//   · weActive()        = WE 动效层**真的挂上了**（实际生效）
// 两处混用是有意的、也是必要的（例如"换一张"按钮在意图阶段就该禁用、不该等它挂上），
// 但散落着写会有两个问题：① 想加第三种背景来源（例如未来的静态 WE 合成图独立成源）就得
// 满文件改；② 不同地方对"算不算有背景"的口径会悄悄漂移。
//
// 所以集中到这里：**判断只从这两个函数走**，别再散写 `s.weId || weActive()`。
//   hasWeIntent()  —— 用户选了 WE（意图）
//   hasWeVisual()  —— WE 真的在画面里（实际）
//   weIsBackground() —— "WE 是否正占着背景位"：两种信号取或（与原有 15 处的口径完全一致）
//   hasAnyBackground(s) —— 有没有任何一种背景（静态底图或 WE）；给 token/样式计算用
function hasWeIntent() { return !!STORE.state.weId }
function hasWeVisual() { return weActive() }
function weIsBackground() { return hasWeIntent() || hasWeVisual() }
function hasAnyBackground(s) { return !!(s && s.wallpaper) || weIsBackground() }
// 换回静态底图的统一入口：先把 WE 意图与实际都撤掉，再交给调用方去设静态底图。
// 顺序不能反 —— 先 setWallpaper 再 weDispose 的话，中间那一刻两种来源同时在场。
function releaseWeForStatic() {
  if (!weIsBackground()) return false
  weDispose()
  STORE.set({ weId: null })
  return true
}

function weNotify() {
  for (var i = 0; i < WE_WATCHERS.length; i++) {
    try { WE_WATCHERS[i]() } catch (e) { /* noop */ }
  }
}

function weDispose() {
  if (!WE_LAYER.root) return
  try { if (WE_LAYER.cleanup) WE_LAYER.cleanup() } catch (e) { /* noop */ }
  WE_LAYER.cleanup = null
  WE_LAYER.root.remove()
  WE_LAYER.root = null
  weNotify()
}

function weShow(entry) {
  weDispose()
  var root = document.createElement('div')
  root.setAttribute('aria-hidden', 'true')
  root.style.cssText = 'position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden'
  WE_LAYER.root = root

  if (entry.type === 'video' && /\.(mp4|webm)$/i.test(entry.file || '')) {
    var v = document.createElement('video')
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
    v.src = weMediaUrl(entry, entry.file)
    root.appendChild(v)
    var play = function () { v.play().catch(function () { /* 自动播放策略拦截时静默 */ }) }
    v.addEventListener('canplay', play, { once: true })
    var onVis = function () { if (document.hidden) v.pause(); else play() }
    document.addEventListener('visibilitychange', onVis)
    WE_LAYER.cleanup = function () {
      document.removeEventListener('visibilitychange', onVis)
      v.pause(); v.removeAttribute('src'); v.load()
    }
  } else if (entry.type === 'web' && /\.html?$/i.test(entry.file || '')) {
    var f = document.createElement('iframe')
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none'
    f.setAttribute('sandbox', 'allow-scripts')
    f.src = weMediaUrl(entry, entry.file)
    root.appendChild(f)
    WE_LAYER.cleanup = function () { f.src = 'about:blank' }
  } else if (entry.type === 'scene') {
    // The host reports unsupported unpacked projects explicitly; selection
    // never changes manual colors, including when generation fails.
    // 高清静态图优先（host 已解包好），否则先 gif 再后台升级
    var still = entry.stillReady ? weStillUrl(entry.id) : null
    var src = still || (entry.previewRel ? weMediaUrl(entry, entry.previewRel) : null)
    var img = document.createElement('img')
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
    if (src) img.src = src
    root.appendChild(img)
    if (STORE.state.weMode !== 'still' && window.dshWallpaper) WE_LAYER.cleanup = weStartNative(entry, root)
    else {
      if (!still) WE_LAYER.cleanup = weUpgradeToStill(entry.id, img)
      if (STORE.state.weMode !== 'still') weNotice(entry.id, '原生桥尚未加载，当前为静态近似；安装桥后需重启 DSH')
    }
  } else if (entry.previewRel) {
    var img2 = document.createElement('img')
    img2.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
    img2.src = weMediaUrl(entry, entry.previewRel)
    root.appendChild(img2)
  }
  document.documentElement.appendChild(root)
  weNotify()
}

// 启动时把上次用的 WE 底图接回来 (STORE.state.weId 是唯一落盘的东西)。
function weRestore() {
  if (weActive()) return
  var id = STORE.state.weId
  if (!id) return
  // 走 WeSource 而不是自己再 fetch 一遍：库清单的取法只该有一份。
  // **必须带 caller='restore'**（见 WeSource 顶部注释）：否则设置页那次 library() 会把
  // 这条恢复请求取消掉，导致"选中的 WE 背景恢复不出来"且不报错。
  // 上面那句旧的"与设置页无竞争"是在请求槽按 kind 共享时写的，**当时是错的**。
  WeSource.library(false, null, 'restore')
    .then(function (result) {
      if (!result.ok) return   // host 路由没就绪: 下次启动再说
      var hit = (result.entries || []).filter(function (e) { return e.id === id })[0]
      if (hit && STORE.state.weId === id && !hasWeVisual()) weShow(hit)
    })
    .catch(function () { /* host 路由没就绪: 下次启动再说 */ })
}

function weColorHex(value) {
  var rgb = String(value || '').trim().split(/\s+/).map(Number)
  return '#' + [0, 1, 2].map(function (i) { return Math.round(Math.max(0, Math.min(1, rgb[i] || 0)) * 255).toString(16).padStart(2, '0') }).join('')
}
function WeProperties(props) {
  var pair = React.useState({ fields: [], values: {}, presets: [], loading: true, busy: false, error: '', dirty: false, note: '' })
  var state = pair[0], set = pair[1], alive = React.useRef(false), request = React.useRef(0), dirty = React.useRef(false)
  var applied = React.useRef(null), working = React.useRef(false)
  var presetPair = React.useState(''), preset = presetPair[0], setPreset = presetPair[1]
  var namePair = React.useState(''), name = namePair[0], setName = namePair[1]
  var bridge = window.dshWallpaper
  function accept(result, note) { applied.current = result; dirty.current = false; set({ fields: result.fields, values: result.values, presets: result.presets, loading: false, busy: false, error: '', dirty: false, note: note || '' }) }
  function read() {
    if (working.current || dirty.current) return
    if (!bridge || !bridge.properties) { set(function (s) { return Object.assign({}, s, { loading: false, error: '桌面桥更新后，完全退出并重启 DSH 才能加载属性面板。' }) }); return }
    var seq = ++request.current
    bridge.properties(props.id).then(function (r) { if (alive.current && seq === request.current && !dirty.current) accept(r) })
      .catch(function (e) { if (alive.current && seq === request.current) set(function (s) { return Object.assign({}, s, { loading: false, error: String(e.message || e) }) }) })
  }
  React.useEffect(function () {
    alive.current = true; read()
    var onReady = function () { if (!dirty.current && String(WE_NOTICES.get(props.id)).indexOf('WE 原生实时场景') === 0) read() }
    WE_WATCHERS.push(onReady)
    return function () { alive.current = false; request.current++; var i = WE_WATCHERS.indexOf(onReady); if (i >= 0) WE_WATCHERS.splice(i, 1) }
  }, [props.id])
  function change(key, value) {
    request.current++
    set(function (s) {
      var values = Object.assign({}, s.values); values[key] = value
      var baseline = applied.current ? applied.current.values : {}
      dirty.current = Object.keys(values).some(function (k) { return values[k] !== baseline[k] })
      return Object.assign({}, s, { values: values, dirty: dirty.current, note: '' })
    })
  }
  function discard() {
    if (!working.current && applied.current) { request.current++; accept(applied.current, '已放弃未应用的更改') }
  }
  async function action(kind) {
    if (!bridge || !bridge.properties || working.current) return
    working.current = true
    var seq = ++request.current; set(function (s) { return Object.assign({}, s, { busy: true, error: '', note: '' }) })
    try {
      if (kind === 'save' && state.dirty) await bridge.properties(props.id, 'apply', state.values)
      var result = await bridge.properties(props.id, kind, kind === 'apply' ? state.values : undefined, kind === 'save' ? name.trim() : preset)
      if (alive.current && seq === request.current) { accept(result, kind === 'save' ? '预设已保存' : kind === 'reset' ? '已恢复默认值' : '已应用到 DSH 背景'); if (kind === 'save') setPreset(name.trim()) }
    } catch (e) { if (alive.current && seq === request.current) set(function (s) { return Object.assign({}, s, { busy: false, error: String(e.message || e) }) }) }
    finally { working.current = false }
  }
  function field(p) {
    var value = state.values[p.key], input
    if (p.type === 'bool') input = h('input', { type: 'checkbox', checked: !!value, 'aria-label': p.text, onChange: function (e) { change(p.key, e.target.checked) } })
    else if (p.type === 'slider') input = h('div', { className: 'bga-we-range' },
      h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: value == null ? p.min : value, 'aria-label': p.text, onChange: function (e) { change(p.key, Number(e.target.value)) } }),
      h('input', { type: 'number', min: p.min, max: p.max, step: p.step, value: value == null ? '' : value, 'aria-label': p.text + '数值', onChange: function (e) { var v = Number(e.target.value); if (Number.isFinite(v)) change(p.key, Math.max(p.min, Math.min(p.max, v))) } }))
    else if (p.type === 'color') input = h('input', { type: 'color', value: weColorHex(value), 'aria-label': p.text, onChange: function (e) { var hex = e.target.value; change(p.key, [1, 3, 5].map(function (i) { return (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5) }).join(' ')) } })
    else if (p.type === 'combo') input = h('select', { value: String(value), 'aria-label': p.text, onChange: function (e) { var option = p.options.find(function (o) { return String(o.value) === e.target.value }); if (option) change(p.key, option.value) } }, p.options.map(function (o) { return h('option', { key: String(o.value), value: String(o.value) }, o.label) }))
    else if (p.type === 'textinput') input = h('input', { type: 'text', maxLength: 200, value: value || '', 'aria-label': p.text, onChange: function (e) { change(p.key, e.target.value) } })
    else input = h('span', { className: 'bga-note' }, p.note)
    return h('div', { key: p.key, className: 'bga-we-field' }, h('span', null, p.text), input)
  }
  var groups = []
  state.fields.forEach(function (p) { var g = groups.find(function (x) { return x.name === p.group }); if (!g) { g = { name: p.group, fields: [] }; groups.push(g) } g.fields.push(p) })
  return h('section', { className: 'bga-we-properties', 'aria-label': '场景属性' },
    h('div', { className: 'bga-row' }, h('strong', null, '场景属性'), h('span', { className: 'bga-note' }, state.dirty ? '有未应用的更改' : state.note || '仅控制 DSH 中的壁纸')),
    state.loading ? h('p', { className: 'bga-note' }, '正在读取场景属性…') : null,
    state.error ? h('div', { role: 'alert', className: 'bga-note' }, state.error, h('button', { type: 'button', className: 'bga-btn', disabled: state.busy || state.dirty, onClick: read }, '重新读取')) : null,
    state.fields.length ? h('fieldset', { disabled: state.busy, style: { border: 0, padding: 0, margin: 0 } },
      h('div', { className: 'bga-row bga-we-actions' },
        h('button', { type: 'button', className: 'bga-btn', disabled: !state.dirty, onClick: function () { action('apply') } }, state.busy ? '处理中…' : '应用到此背景'),
        h('button', { type: 'button', className: 'bga-btn', disabled: !state.dirty, onClick: discard }, '放弃修改'),
        h('button', { type: 'button', className: 'bga-btn', onClick: function () { action('reset') } }, '恢复默认')),
      groups.map(function (g, i) { return h('details', { key: g.name, className: 'bga-we-group', open: i === 0 }, h('summary', null, g.name, h('span', { className: 'bga-note' }, ' · ' + g.fields.length + ' 项')), g.fields.map(field)) }),
      h('p', { className: 'bga-note' }, '调整后点击应用。拖动滑块不会反复重启场景。音量默认静音；自定义图片等文件选项仍需在 WE 设置。'),

      h('div', { className: 'bga-we-presets' }, h('strong', null, '我的预设'),
        h('div', { className: 'bga-row' }, h('input', { type: 'text', placeholder: '例如：安静办公', maxLength: 40, value: name, 'aria-label': '预设名称', onChange: function (e) { setName(e.target.value) } }), h('button', { type: 'button', className: 'bga-btn', disabled: !name.trim(), onClick: function () { action('save') } }, '保存当前设置')),
        h('div', { className: 'bga-row' }, h('select', { value: preset, 'aria-label': '已保存预设', onChange: function (e) { setPreset(e.target.value) } }, h('option', { value: '' }, '选择预设'), state.presets.map(function (s) { return h('option', { key: s, value: s }, s) })), h('button', { type: 'button', className: 'bga-btn', disabled: !preset, onClick: function () { action('load') } }, '加载')))) : null)
}

// ---- WE library: data loading, selection and independently rendered cards ----
function weFilterLibrary(entries, query, type) {
  var needle = String(query || '').trim().toLocaleLowerCase()
  return entries.filter(function (entry) {
    return (type === 'all' || entry.type === type) && (!needle ||
      [entry.title, entry.id].concat(entry.tags || []).join(' ').toLocaleLowerCase().indexOf(needle) >= 0)
  })
}

function WeLibraryCard(props) {
  var entry = props.entry, label = WE_TYPE_LABEL[entry.type] || WE_TYPE_LABEL.unknown
  var pair = React.useState({ busy: false, note: '', error: false }), state = pair[0], set = pair[1]
  var pending = React.useRef(null), mounted = React.useRef(false)
  React.useEffect(function () {
    mounted.current = true
    return function () { mounted.current = false; if (pending.current) pending.current.abort() }
  }, [])
  async function open() {
    if (pending.current) return
    var controller = new AbortController(); pending.current = controller
    set({ busy: true, note: '', error: false })
    try {
      var response = await fetch(weUrl('/open-in-we?id=') + encodeURIComponent(entry.id), { method: 'POST', cache: 'no-store', signal: controller.signal })
      var result = await response.json()
      if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status)
      if (mounted.current) set({ busy: false, note: result.message || (result.targeted ? '已发送到 WE' : 'WE 已启动，请再点一次'), error: false })
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) set({ busy: false, note: String(e.message || e), error: true })
    } finally { if (pending.current === controller) pending.current = null }
  }
  return h('article', { className: 'bga-card bga-we-card' + (props.selected ? ' on' : '') },
    h('button', { type: 'button', className: 'bga-we-pick', 'aria-pressed': props.selected, 'aria-label': '应用背景：' + entry.title, title: entry.title, onClick: function () { props.onSelect(entry) } },
      entry.previewRel ? h('img', { className: 'bga-thumb', style: { height: '86px' }, alt: '', loading: 'lazy', decoding: 'async', src: weMediaUrl(entry, entry.previewRel), onError: function (e) { e.target.style.visibility = 'hidden' } }) : h('div', { className: 'bga-emptymini' }, '无封面'),
      h('span', { className: 'bga-we-card-title' }, entry.title),
      h('span', { className: 'bga-we-card-meta' }, label[0], ' · ', entry.source === 'local' ? '本地项目' : '订阅', props.selected ? ' · 使用中' : '')),
    h('div', { className: 'bga-we-card-actions' },
      ['scene', 'video', 'web'].includes(entry.type) ? h('button', { type: 'button', className: 'bga-btn', disabled: state.busy, onClick: open }, state.busy ? '打开中…' : '在 WE 打开') : null,
      weParseSchemeColor(entry.schemeColor) ? h('button', { type: 'button', className: 'bga-btn', title: '保存为手动配色，清除背景后仍保留', onClick: function () { weApplySchemeColor(weParseSchemeColor(entry.schemeColor)) } }, '采用壁纸配色') : null),
    state.note ? h('p', { className: 'bga-note', role: state.error ? 'alert' : 'status' }, state.note) : null)
}

function WePlaybackControls(props) {
  if (props.entry.type !== 'scene' || STORE.state.weMode === 'still') return null
  return h('div', { className: 'bga-we-controls' },
    h('div', { className: 'bga-row' }, h('strong', null, '播放质量'),
      h('select', { className: 'bga-btn', 'aria-label': '实时播放质量', value: STORE.state.weQuality || 'balanced', onChange: function (e) { props.onQuality(e.target.value) } },
        Object.keys(WE_QUALITY).map(function (key) { var quality = WE_QUALITY[key]; return h('option', { key: key, value: key }, quality.name + ' · ' + quality.fps + ' 帧目标') })),
      h(WeLiveStatus, { id: props.entry.id })),
    h('p', { className: 'bga-note' }, '目标帧率不等于实际帧率；复杂壁纸可关闭部分自定义动效。'),
    h(WeProperties, { key: props.entry.id, id: props.entry.id }))
}

function WeSection() {
  var stPair = React.useState({ loading: true, entries: [], weFound: false, bridge: null, error: '' })
  var st = stPair[0], setState = stPair[1], active = React.useRef(false)
  // （原来这里有个 requests ref 自己管 AbortController，已交给 WeSource —— 请求簿记不再有两套）
  var selPair = React.useState(STORE.state.weId || null), selId = selPair[0], setSelId = selPair[1]
  var searchPair = React.useState(''), query = searchPair[0], setQuery = searchPair[1]
  var typePair = React.useState('all'), type = typePair[0], setType = typePair[1]
  function patch(values) { if (active.current) setState(function (previous) { return Object.assign({}, previous, values) }) }
  // Independent status/library requests cannot overwrite each other or a newer refresh.
  // 取数走 WeSource（见上方注释）：这里只管"拿到结果后怎么进 state"，不管怎么发请求。
  async function load(kind, force) {
    if (kind === 'library') patch({ loading: true, error: '' })
    // caller='section'：与启动恢复（'restore'）隔离，互不取消。见 WeSource 顶部注释。
    var result = kind === 'library'
      ? await WeSource.library(force, null, 'section')
      : await WeSource.status(force, null, 'section')
    if (result.aborted) return
    if (kind === 'library') {
      patch(result.ok
        ? { loading: false, entries: result.entries, weFound: result.weFound, error: '' }
        : { loading: false, error: '扫描失败：' + result.error })
    } else {
      patch({ bridge: result.ok ? result.bridge : { running: null } })
    }
  }
  function refresh(force) { load('status', force); load('library', force) }
  React.useEffect(function () {
    active.current = true; refresh(false)
    var update = function () { patch({}); setSelId(STORE.state.weId || null) }
    WE_WATCHERS.push(update)
    return function () {
      active.current = false
      // 组件卸载只取消**本组件**的请求（'section'），不要顺手取消启动恢复那条
      WeSource.abortAll('section')
      var i = WE_WATCHERS.indexOf(update); if (i >= 0) WE_WATCHERS.splice(i, 1)
    }
  }, [])
  function applyEntry(entry) {
    STORE.set({ weId: entry.id }); setSelId(entry.id); weShow(entry)
  }
  function clearWe() { STORE.set({ weId: null }); setSelId(null); weDispose() }
  var selected = st.entries.find(function (entry) { return entry.id === selId })
  function setMode(mode) {
    if (mode === STORE.state.weMode) return
    STORE.set({ weMode: mode }); if (selected) weShow(selected); patch({})
  }
  function setQuality(value) {
    if (!WE_QUALITY[value] || value === STORE.state.weQuality) return
    STORE.set({ weQuality: value }); if (selected) weShow(selected); patch({})
  }
  var visible = weFilterLibrary(st.entries, query, type)
  return Section('Wallpaper Engine 库', '读取本机订阅与本地项目。实时场景由 WE 渲染，保留鼠标视差。',
    h('div', { className: 'bga-row' },
      h('span', { className: 'bga-note', role: 'status' }, st.loading ? '正在扫描 WE 库…' : st.weFound ? '本地库共 ' + st.entries.length + ' 张' : '未找到 Wallpaper Engine'),
      h('span', { className: 'bga-chip', style: { background: st.bridge && st.bridge.running === true ? '#166534' : '#374151' } }, st.bridge == null ? 'WE 状态检测中' : st.bridge.running === true ? 'WE 已运行' : st.bridge.running === false ? 'WE 未运行' : 'WE 进程状态未知'),
      h('button', { type: 'button', className: 'bga-btn', disabled: st.loading, onClick: function () { refresh(true) } }, '刷新')),
    st.error ? h('p', { className: 'bga-note', role: 'alert' }, st.error) : null,
    selId ? h('div', { className: 'bga-we-current' },
      h('strong', null, '当前背景：' + (selected ? selected.title : '已保存的壁纸')),
      h('div', { className: 'bga-row' },
        selected && selected.type === 'scene' ? h('button', { type: 'button', className: 'bga-btn', 'aria-pressed': STORE.state.weMode !== 'still', onClick: function () { setMode('live') } }, '实时动效') : null,
        selected && selected.type === 'scene' ? h('button', { type: 'button', className: 'bga-btn', 'aria-pressed': STORE.state.weMode === 'still', onClick: function () { setMode('still') } }, '静态近似') : null,
        selected && selected.type === 'scene' && STORE.state.weMode !== 'still' ? h('button', { type: 'button', className: 'bga-btn', onClick: function () { weShow(selected) } }, '重新连接') : null,
        h('button', { type: 'button', className: 'bga-btn', onClick: clearWe }, '清除 WE 背景')),
      selected && selected.type === 'scene' ? h('p', { className: 'bga-note', role: 'status' }, STORE.state.weMode === 'still' ? '当前使用静态近似图' : WE_NOTICES.get(selId) || '正在连接实时背景…') : null) : null,
    st.entries.length ? h('div', { className: 'bga-we-toolbar' },
      h('input', { type: 'search', value: query, placeholder: '搜索名称、标签或编号', 'aria-label': '搜索壁纸', onChange: function (e) { setQuery(e.target.value) } }),
      h('select', { value: type, 'aria-label': '壁纸类型', onChange: function (e) { setType(e.target.value) } },
        h('option', { value: 'all' }, '全部类型'), ['scene', 'video', 'web'].map(function (key) { return h('option', { key: key, value: key }, WE_TYPE_LABEL[key][0]) })),
      h('span', { className: 'bga-note', role: 'status' }, visible.length + ' / ' + st.entries.length),
      query || type !== 'all' ? h('button', { type: 'button', className: 'bga-btn', onClick: function () { setQuery(''); setType('all') } }, '清空筛选') : null) : null,
    visible.length ? h('div', { className: 'bga-grid bga-we-library' }, visible.map(function (entry) { return h(WeLibraryCard, { key: entry.id, entry: entry, selected: entry.id === selId, onSelect: applyEntry }) })) :
      !st.loading ? h('p', { className: 'bga-note bga-we-empty' }, st.entries.length ? '没有匹配的壁纸，试试其他名称或类型。' : '暂无壁纸。添加 WE 订阅或本地项目后点击刷新。') : null,
    selected ? h(WePlaybackControls, { entry: selected, onQuality: setQuality }) : null)
}


// -------------------------------------------------------------------- 入口 --

var inject = ['slots', 'theme']

function apply(ctx) {
    var theme = ctx.get('theme')
    var slots = ctx.get('slots')

    // 静态样式表可重建（disposeStatic / rebuildStatic / syncCanvasWidth 都在**模块作用域**，
    // 因为模块级的 DockFx 也要调 syncCanvasWidth —— 见那边的注释）。
    ctx.effect(function () {
      rebuildStatic()
      return function () { if (disposeStatic) { disposeStatic(); disposeStatic = null } }
    }, 'bga-static')

    // 窗口尺寸变化时重新量画布（200ms 去抖；syncCanvasWidth 自己带 24px 闸门）
    ctx.effect(function () {
      if (typeof window === 'undefined' || !window.addEventListener) return
      var onResize = function () {
        if (canvasTimer) clearTimeout(canvasTimer)
        canvasTimer = setTimeout(function () { canvasTimer = 0; syncCanvasWidth() }, 200)
      }
      window.addEventListener('resize', onResize)
      syncCanvasWidth()
      return function () {
        window.removeEventListener('resize', onResize)
        if (canvasTimer) { clearTimeout(canvasTimer); canvasTimer = 0 }
      }
    }, 'bga-canvas-width')

    // 保留样式节点，且底图与主题样式分开更新。纯换图无需撤销/重发整套主题 token。
    var dynEl = null, bgEl = null, dynamicInputs = ''
    function updateStyle(el, css, attr) {
      if (!el) {
        el = document.createElement('style')
        el.setAttribute(attr, '1')
        document.head.appendChild(el)
      }
      if (el.textContent !== css) el.textContent = css
      return el
    }
    function rebuildBackground(force) {
      // 恢复窗口时重建底图节点，让 Chromium 重新提交可能已回收的合成层。
      if (force && bgEl) { if(bgEl.parentNode)bgEl.parentNode.removeChild(bgEl); bgEl = null }
      bgEl = updateStyle(bgEl, backgroundCss(STORE.state, renderedBgUrl(), renderedBgFrame()), 'data-bg-atelier-background')
    }
    function rebuildStyle() {
      var s=STORE.state,inputs=JSON.stringify([!!s.wallpaper,s.accent,s.deep,s.veil,s.glass,s.cardA,s.cardBlur,s.cardShadow,s.effect,s.styles])
      if(!dynEl||inputs!==dynamicInputs){dynamicInputs=inputs;dynEl = updateStyle(dynEl, dynamicCss(s, true), 'data-bg-atelier-dynamic')}
      rebuildBackground()
      rebuildBubbleStyle()
      rebuildSettingsSurface()
    }
    // 设置面板的"可读底座" (v1.16.1): 表面越透明, 设置页越难读 —— 本机 surface=0 时
    // 设置面板整个透出底图。这里只给设置面板自己垫一层近乎不透明的面色, 不动整屏。
    // 实测本机设置面板是 `[role="dialog"].wCInkW_panel`（自己透明），真正的底色画在它的
    // `::before` 上（`background:var(--dsw-specific-menu)`）⇒ 两条都要写。
    // v1.16.2: 颜色**算成字面量**再写进规则, 不走 theme token —— 走 token 会给
    // overrideTokens 塞自定义名字, 而当前宿主的实现会把整层 override 判废, 结果底图直接不显示。
    var settingsEl = null, settingsInputs = ''
    function settingsSurfaceCss(s) {
      if (!s || !s.wallpaper) return ''
      var solid = settingsSolidColor(s)
      return '[role="dialog"]>[class*="settings" i],[role="dialog"][class*="panel"]{background-color:' + solid + '!important}\n' +
        '[role="dialog"]>[class*="settings" i]::before,[role="dialog"][class*="panel"]::before{background:' + solid + '!important}\n' +
        '.bga-studio,.bga-page{background:transparent}\n'
    }
    function rebuildSettingsSurface() {
      var s = STORE.state
      var inputs = JSON.stringify([!!s.wallpaper, s.accent, s.deep, s.styles])
      if (inputs === settingsInputs) return
      settingsInputs = inputs
      settingsEl = updateStyle(settingsEl, settingsSurfaceCss(s), 'data-bg-atelier-settings')
    }
    // 消息气泡的淡阴影单独一张样式表: 它管的是会话区 DOM, 跟底图/卡面那张表的生效条件不同。
    // 只在"有底图 + 强度 > 0"时下发 (没底图时气泡本来就有宿主自己的样式, 不该多一层阴影)。
    var bubbleEl = null, bubbleInputs = ''
    function rebuildBubbleStyle() {
      var s = STORE.state, st = s.styles || {}
      var inputs = JSON.stringify([!!s.wallpaper, s.accent, s.deep, st.bubble])
      if (inputs === bubbleInputs) return
      bubbleInputs = inputs
      bubbleEl = updateStyle(bubbleEl, bubbleCss(s), 'data-bg-atelier-bubbles')
    }
    ctx.effect(function () {
      shownUrl = bgUrlOnScreen(STORE.state)
      shownFrame = framingForUrl(STORE.state,shownUrl)
      paintBackground = rebuildBackground
      rebuildStyle()
      return function () {
        paintBackground = null
        shownUrl = null
        shownFrame = null
        lastManualFadeAt=null;selectionFade=null
        decodedWallpaper=null
        fadeStop()
        if (dynEl && dynEl.parentNode) dynEl.parentNode.removeChild(dynEl)
        if (bgEl && bgEl.parentNode) bgEl.parentNode.removeChild(bgEl)
        if (bubbleEl && bubbleEl.parentNode) bubbleEl.parentNode.removeChild(bubbleEl)
        if (settingsEl && settingsEl.parentNode) settingsEl.parentNode.removeChild(settingsEl)
        bubbleInputs = ''
        settingsInputs = ''
        dynEl = bgEl = bubbleEl = settingsEl = null
      }
    }, 'bga-dynamic')

    var disposeTokens = null
    var tokenSignature = ''
    var tokenInputs = ''
    function rebuildTokens() {
      if (theme === undefined) return
      var s=STORE.state,hasBackground=hasAnyBackground(s),inputs=JSON.stringify([hasBackground,s.accent,s.deep,s.styles])
      if(inputs===tokenInputs)return
      tokenInputs=inputs
      // 没有底图时也要下发: WE 动效层同样需要外框半透明才看得见 (见 WE_LAYER 注释)
      var tokens = hasBackground ? buildTokens(s) : {}
      var signature = JSON.stringify(tokens)
      if (signature === tokenSignature) return
      tokenSignature = signature
      if (disposeTokens) { disposeTokens(); disposeTokens = null }
      disposeTokens = theme.overrideTokens('bg-atelier-plus', tokens)
    }
    ctx.effect(function () {
      rebuildTokens()
      return function () { if (disposeTokens) disposeTokens() }
    }, 'bga-tokens')

    ctx.effect(function () {
      var ref = { url: bgUrlOnScreen(STORE.state), state: STORE.state }
      var off = STORE.subscribe(function () {
        if(ref.state===STORE.state)return // 保存状态/列表通知不重新计算背景与主题
        ref.state=STORE.state
        var url = bgUrlOnScreen(STORE.state)
        if (url !== ref.url || (STORE.state.fadeOn === false && fadeEl)) {
          switchFade(ref.url, url)
          ref.url = url
        }
        rebuildStyle(); rebuildTokens(); armAuto()
        pumpWallpaperRequest()
      })
      return function () {
        off(); fadeStop(); cancelWallpaperRequest()
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = 0 }
        autoSig = ''
      }
    }, 'bga-watch')

    ctx.effect(watchWallpaperVisibility, 'bga-visibility')

    // WE 动效层的出现/消失要重建动态样式与 token (为什么: 见 WE_LAYER 上方的注释)
    ctx.effect(function () {
      var previousActive = weActive()
      var fn = function () {
        var active = weActive()
        if (active === previousActive) return
        previousActive = active
        fadeStop()
        lastManualFadeAt=null;selectionFade=null
        shownUrl = bgUrlOnScreen(STORE.state)
        shownFrame = framingForUrl(STORE.state,shownUrl)
        rebuildStyle(); rebuildTokens()
      }
      WE_WATCHERS.push(fn)
      return function () { var i = WE_WATCHERS.indexOf(fn); if (i >= 0) WE_WATCHERS.splice(i, 1) }
    }, 'bga-we-watch')

    // 特效画布的密度 + 卡面矩形: 挂载时先量一次, 之后窗口尺寸/侧栏折叠/卡面长高都重量。
    // 同时盯卡面与画布自身 —— 本机实测两者尺寸不总是一起动（侧栏折叠只动容器）,
    // 而且宿主重挂 composer 时卡面节点会换人: 每回调一次就把"当前卡面"重新认一遍。
    ctx.effect(function () {
      syncCanvasWidth()
      var onResize = function () { scheduleCanvasSync(300) }
      window.addEventListener('resize', onResize)
      var observed = []
      var ro = null
      var observe = function () {
        if (!ro) return
        var card = document.querySelector('[data-composer-card]')
        if (observed.indexOf(card) >= 0) return
        observed.forEach(function (n) { ro.unobserve(n) })
        observed = [card, document.querySelector('[class*="composerSeat"]')].filter(Boolean)
        observed.forEach(function (n) { ro.observe(n) })
      }
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(function () { observe(); scheduleCanvasSync(0) })
        observe()
      }
      return function () {
        window.removeEventListener('resize', onResize)
        if (ro) { ro.disconnect(); ro = null }
        observed = []
        if (canvasTimer) { clearTimeout(canvasTimer); canvasTimer = 0 }
      }
    }, 'bga-canvas-geometry')

    if (slots !== undefined) {
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'bga', order: 60, label: '底图工坊' },
          function () { return h(SettingsPage) })
      })
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          { name: 'conversation.composer.dock', id: 'bga-flies', order: -10 },
          function () { return h(DockFx) })
      })
      slots.inject('sidebar.footer.action', function () {
        return slots.register(
          { name: 'sidebar.footer.action', id: 'bga-orb', order: 0, label: '底图工坊 · 换下一张底图' },
          function () { return h(Orb) })
      })
      // WE 动效层不需要 slot: 它没有 UI, 直接 append 到 <html> (见上面 WE_LAYER 注释)。
    }

    // 动效层的生命周期 = 插件生命周期。挂 ctx.effect 而不是 slot 空组件: 组件卸载必跑 cleanup,
    // 那样"离开会话页"这类正常装卸就会顺手把底图拆掉, 层的存活不该由页面装卸决定。
    ctx.effect(function () { return function () { weDispose() } }, 'bga-we-layer')

    console.log('[dsh-bg-atelier-plus] client up')

    // 恢复上次应用过的 WE 动效底图: 必须等 weId 从 settings.json 拉回来, 所以接在 load 后面。
    // armAuto 也在这里补一次: subscribe 里那次跑在"设置还没拉回来"的默认值上(autoOn 默认关)。
    STORE.load().then(function () { weRestore(); armAuto() })
  }

  exports.apply = apply
  exports.inject = inject
  // 测试缝（与 dsh-cache-control 同套路）：tools/ 下的离线脚本用它驱动
  // "数量随画布宽度"、"卡面阴影独立开关"与 DockFx 真渲染。
  exports.internals = {
    STORE: STORE,
    SettingsPage: SettingsPage, PlaylistDialog: PlaylistDialog,
    normalizePlaylists: normalizePlaylists, uniqueImageIds: uniqueImageIds, normalizeSource: normalizeSource,
    createPlaylist: createPlaylist, renamePlaylist: renamePlaylist, removePlaylist: removePlaylist,
    changeMembership: changeMembership, removeFromPlaylist: removeFromPlaylist, toggleFavorite: toggleFavorite,
    sourceItems: sourceItems, setPlaybackSource: setPlaybackSource, cycleWallpaper: cycleWallpaper,

    reorderPlaylist: reorderPlaylist, setPlaybackMode: setPlaybackMode, previousWallpaper: previousWallpaper, canPreviousWallpaper: canPreviousWallpaper,
    framingOf: framingOf, normalizeImageFraming: normalizeImageFraming, setImageFraming: setImageFraming, resetImageFraming: resetImageFraming,
    weShow: weShow, weDispose: weDispose, weStartNative: weStartNative, weApplySchemeColor: weApplySchemeColor, WeSection: WeSection, WeProperties: WeProperties, weFilterLibrary: weFilterLibrary, weMediaUrl: weMediaUrl,
    staticCss: staticCss,
    dynamicCss: function () { return dynamicCss(STORE.state) },
    bgLayerCss: bgLayerCss,
    fadeRun: fadeRun, fadeStop: fadeStop, fadeVisible: fadeVisible, bgUrlOnScreen: bgUrlOnScreen,
    fadeDurMs: fadeDurMs, fadeWaitMs: fadeWaitMs, switchFade: switchFade,
    adaptiveFadeMs: adaptiveFadeMs, manualFadeTiming: manualFadeTiming,
    fadeMotionStatus: function(){return fadeMotion?{duration:fadeMotion.duration,started:fadeMotion.started}:null},
    renderedBgUrl: renderedBgUrl,
    backgroundCss: function () { return backgroundCss(STORE.state, renderedBgUrl(), renderedBgFrame()) },
    setWallpaper: setWallpaper,
    wallpaperRequestPending: function(){return !!(decodeJob||queuedSwap)},
    autoDelayMs: autoDelayMs, armAuto: armAuto, autoTick: autoTick,
    AUTO_STOPS: AUTO_STOPS, nearestStop: nearestStop, Slider: Slider,
    autoPending: function () { return autoTimer !== 0 },
    DockFx: DockFx,
    tagPill: tagPill, tagPills: tagPills, tagPool: tagPool,
    canvasScale: canvasScale,
    canvasWidth: function () { return CANVAS_W },
    setCanvasWidth: function (w) { CANVAS_W = Math.max(120, Math.round(Number(w) || 985)); regenerateParticles() },
    counts: function () {
      return { fly: countFor('fly'), star: countFor('star'), bub: countFor('bub'), petal: countFor('petal'), rain: countFor('rain') }
    },
    density: function () { return DENSITY },
    // v1.16.0 官方版分支的三处适配也留测试缝 (tools/ 与 _tests 都靠它跑离线断言):
    bubbleCss: function () { return bubbleCss(STORE.state) },
    themeSurface: function () { return { alpha: themeSurfaceAlpha(STORE.state), tone: themeSurfaceTone(STORE.state.styles) } },
    previewUrlOf: previewUrlOf, largeUrlOf: largeUrlOf,
    previewUpgradeDim: function () { return PREVIEW_UPGRADE_DIM },
    largeDecodedCount: function () { return decodedLarges.length },
    forgetLarges: forgetLarges,
    settingsSolid: function () { return settingsSolidColor(STORE.state) },
    // buildTokens 的原始输出（键名白名单断言用）：给 overrideTokens 塞未注册的 token 名
    // 会让宿主把整层 override 判废 ⇒ 底图被不透明外壳盖住，这条缝专门用来拦那种改动。
    tokenKeys: function () { return Object.keys(buildTokens(STORE.state)) },
  }

  // 只读观测点（给实机脚本用，例如 tools/visual-baseline.mjs 验证"设置已还原到内存"）。
  //
  // 为什么需要它：host 侧的 settings.json 与**客户端内存里的 STORE.state 是两份**。
  // 脚本改了磁盘、但客户端内存可能仍是旧值；而客户端在任何变更时会把**内存**整份写回，
  // 于是"磁盘看起来还原了"会在下一次写回时被打回。实测踩到：oracle 跑完后
  // autoOn=False（我写进磁盘的 true 被内存里的 false 覆盖）。
  // 只凭磁盘检查无法发现这件事 ⇒ 必须能看到内存值。
  //
  // 只暴露**读取**（不能改、也不含内部引用）：返回一个快照 + 定时器是否在跑。
  // 与 exports.internals 是同一套路（本插件已有的测试缝），但那条缝只在模块层面，
  // 实机脚本拿不到，所以这里额外挂一个 window 上的只读窄接口。
  try {
    if (typeof window !== 'undefined' && window) {
      window.__bgaStateProbe = function () {
        var s = STORE.state || {}
        return {
          autoOn: s.autoOn === true,
          autoMin: s.autoMin,
          autoPending: autoTimer !== 0,     // 轮播定时器此刻是否在跑（内存状态的直接证据）
          wallpaper: s.wallpaper ? { file: s.wallpaper.file, cat: s.wallpaper.cat } : null,
          weId: s.weId == null ? null : String(s.weId),
          fieldCount: Object.keys(s).length,
        }
      }
    }
  } catch (e) { /* 观测点失败不影响插件本身 */ }
  return module.exports
  }
})











