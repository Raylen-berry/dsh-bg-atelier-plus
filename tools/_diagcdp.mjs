// 诊断：CDP 为什么超时
const CDP = 'http://127.0.0.1:9799'
const list = await (await fetch(CDP + '/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0
const pend = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p.res(m) }
}
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id
  pend.set(i, { res })
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async (expr, label) => {
  const t0 = Date.now()
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  console.log('  ' + label + ' 耗时 ' + (Date.now() - t0) + 'ms  结果=' + JSON.stringify(r.result || r.error || null).slice(0, 90))
  return r
}
await ev('1+1', '简单算术')
await ev("(async()=>{const r=await fetch('/bga/settings.json',{cache:'no-store'});const t=await r.text();return t.length})()", 'async fetch 设置')
await ev('document.querySelectorAll("[class*=bga]").length', 'DOM 查询')
ws.close()