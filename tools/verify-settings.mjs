// 迁移脚本的校验口径：档位吸附 + v1.11.0 两个新字段（响应时间 / 渐变时长）。
// 为什么要有这一条：`tools/settings.mjs` 里那张 14 档表是 client.js `AUTO_STOPS` 的**副本**
// （脚本是给"换机器"用的独立入口，不 import 插件源码），两处各写一遍就有走样的可能；
// 而档位吸附本身是**手改设置文件**这条信任边界上的输入校验，越界/字符串都得有确定结果。
//
// settings.mjs 顶层带 CLI（argv[2] 为空时打用法），所以导入前先把它的输出吞掉。
import assert from 'node:assert/strict'

const quiet = console.log
console.log = () => {}
const { validate } = await import(new URL('./settings.mjs', import.meta.url))
console.log = quiet

// ---- ① 档位吸附：表外的数落回最近一档；正好卡两档中间取小的那档（与 client.js 的 nearestStop 同口径）----
for (const [raw, want] of [[47, 45], [6, 5], [8, 7], [2.5, 2], [13, 15], [89, 90], [121, 120], [999, 120], [0, 1], [-5, 1], [null, 1]]) {
  const { settings, notes } = validate({ autoMin: raw })
  assert.equal(settings.autoMin, want, 'autoMin=' + String(raw) + ' 该吸附到 ' + want)
  // 上表每一行都改了值（吸附或钳制），都该留一条 note —— 不许静默改用户写的数
  assert.ok(notes.length > 0, 'autoMin=' + String(raw) + ' 改了值却没留 note')
}
for (const [raw, want] of [[NaN, 30], ['abc', 30], [undefined, 30]]) {
  const { settings } = validate({ autoMin: raw })
  assert.equal(settings.autoMin, want, 'autoMin=' + String(raw) + ' 坏值该兜 30 分钟（不能兜成 1 分钟：那是每 60 秒换一张图）')
}
// 每一档都能原样过关，不许被吸附到邻档
for (const m of [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120]) {
  const { settings, notes } = validate({ autoMin: m })
  assert.equal(settings.autoMin, m, m + ' 是档位，不该被动')
  assert.ok(!notes.some((n) => n.includes('档位')), m + ' 是档位，不该报吸附：' + JSON.stringify(notes))
}
console.log('PASS ① 间隔档位吸附：表外值吸附、卡中间取小的、坏值兜 30 分钟、14 档原样过关')

// ---- ② 新字段：默认值 / 钳制 / 与插件同范围 ----
assert.equal(validate({}).settings.fadeMs, 900)
assert.equal(validate({}).settings.fadeDelayMs, 0)
for (const [raw, want] of [[1, 100], [99, 100], [300, 300], [2000, 2000], [5000, 5000], [99999, 5000], ['1500', 1500]]) {
  assert.equal(validate({ fadeMs: raw }).settings.fadeMs, want, 'fadeMs=' + String(raw) + ' 该是 ' + want)
}
for (const [raw, want] of [[-5, 0], [200, 200], [1000, 1000], [99999, 1000], ['250', 250]]) {
  assert.equal(validate({ fadeDelayMs: raw }).settings.fadeDelayMs, want, 'fadeDelayMs=' + String(raw) + ' 该是 ' + want)
}
console.log('PASS ② 响应时间 / 渐变时长：默认 0ms / 900ms，越界钳到 0–1000 / 100–5000')

// ---- ③ 老设置文件兼容：v1.10.0 的文件（没有这两个键）不该被判成未知字段 ----
{
  const legacy = validate({   // v1.10.0 那版会写出来的完整字段
    wallpaper: null, effect: 'petal', accent: '#e88ca0', deep: '#241318', veil: 0.3, glass: 0.8,
    cardA: 0, cardBlur: 10, focus: '50% 50%', zoom: 1, preset: 'sakura', cardShadow: true,
    autoOn: true, autoMin: 5, fadeOn: true,
  })
  assert.deepEqual(legacy.notes, [], '完整的 v1.10.0 设置文件该一条 note 都没有：' + JSON.stringify(legacy.notes))
  assert.equal(legacy.settings.fadeMs, 900)
  assert.equal(legacy.settings.fadeDelayMs, 0)
  assert.equal(legacy.settings.autoMin, 5, '5 是档位，原样保留')
  // 但**写了**一个非数字要照旧喊：老文件缺键不报警，写错值必须报
  const bad = validate({ fadeMs: 'abc' })
  assert.equal(bad.settings.fadeMs, 900)
  assert.ok(bad.notes.some((n) => n.includes('fadeMs')), '写错的值得留话：' + JSON.stringify(bad.notes))
  // 未知字段仍然要丢并且留话（原有行为，别被我改坏）
  const junk = validate({ autoMin: 5, 打错了的键: 1 })
  assert.ok(junk.notes.some((n) => n.includes('丢弃未知字段')), '未知字段该被丢掉并记下来')
}
console.log('PASS ③ 老设置文件原样通过（缺新键走默认值），未知字段照旧丢弃并记名')

console.log('\n全部通过：档位吸附（14 档表 / 卡中间取小的 / 坏值兜 30 分钟）+ 新字段钳制 + 老文件兼容')