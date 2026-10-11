// tools/probe-fx-mount.mjs —— 动效层挂载/几何探针（只读，不改任何东西）
//
// 背景（已查明）：`DockFx` 注册在 **`conversation.composer.dock`**（client.js:3133）——
// **没有会话就不挂载**。隔离实例里必须先打开一个**有消息的会话**，动效画布才会出现。
// 侧栏里当前选中的可能是一个**空的**"新会话"（那时显示的是 hero 页，没有 dock）——
// 所以要显式点那条**带"N分钟/刚刚"**的会话树项（与 tools/verify-switching-behavior.mjs 同一判据）。
//
// 用法：由 `iso-instance run --extra-script tools/probe-fx-mount.mjs` 调用
//   （需要 VB_CDP_PORT / VB_GUI_HOST；VB_VIEWPORT 可选，给了就先钉视口再量）
const PORT = process.env.VB_CDP_PORT
const HOST = process.env.VB_GUI_HOST || ''
if (!PORT) { console.error('✗ 需要 VB_CDP_PORT'); process.exit(2) }

const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.url).includes(HOST.split(':')[0]))
if (!page) { console.error('✗ 找不到页面（VB_GUI_HOST=' + HOST + '）'); process.exit(2) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws 连接失败')) })
let id = 0
const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realClick = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  }
}
const bgaClasses = () => ev(`[...new Set([...document.querySelectorAll('[class*="bga"]')].flatMap(e=>String(e.className).split(/\\s+/).filter(c=>c.startsWith('bga'))))].join(', ')`)
const snapshot = () => ev(`(()=>{const st=window.__bgaStateProbe?window.__bgaStateProbe():null;
  return JSON.stringify({dockfx:!!document.querySelector('.bga-dockfx'), effect:st?st.effect:null,
    treeitems:[...document.querySelectorAll('[role="treeitem"]')].map(e=>String(e.textContent||'').trim().slice(0,30)),
    hero:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,50)})})()`)
const GEOM = `(()=>{
  const rect=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)}};
  const dock=document.querySelector('.bga-dockfx');
  const comp=document.querySelector('[role="textbox"]');
  let card=comp, up=0;
  while(card&&up<8){const r=card.getBoundingClientRect(); if(r.width>400&&r.height>90) break; card=card.parentElement; up++}
  const fx=dock?[...dock.querySelectorAll('*')]:[];
  return JSON.stringify({
    viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},
    dock:rect(dock), composer:rect(comp), composerCard:rect(card),
    fxCounts:fx.reduce((m,e)=>{const c=String(e.className).split(/\\s+/)[0];m[c]=(m[c]||0)+1;return m},{}),
    dockCss:dock?{top:getComputedStyle(dock).top,left:getComputedStyle(dock).left,right:getComputedStyle(dock).right,height:getComputedStyle(dock).height,position:getComputedStyle(dock).position}:null,
    dockVars:dock?{insetL:dock.style.getPropertyValue('--bga-fx-inset-l'),insetR:dock.style.getPropertyValue('--bga-fx-inset-r'),h:dock.style.getPropertyValue('--bga-fx-h'),oy:dock.style.getPropertyValue('--bga-fx-oy')}:null
  })})()`

console.log('=== 动效层挂载/几何探针 ===')
// ① 先钉视口（验收时视口由脚本钉住，量出来的锚点才可比）
const vp = process.env.VB_VIEWPORT
if (vp) {
  const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(vp)
  if (m) {
    await send('Emulation.setDeviceMetricsOverride', { width: +m[1], height: +m[2], deviceScaleFactor: +m[3], mobile: false })
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Page.reload', {})
    await sleep(7000)
    console.log('  视口: ' + vp + ' 实测 ' + await ev(`JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`))
  }
}
console.log('  ① 初始（未交互）: ' + await snapshot())
console.log('     初始 bga 类名: ' + await bgaClasses())

// ② 打开"有消息的会话"：真实鼠标点那条带"刚刚/N分钟/小时"的会话树项
const armed = await ev(`(()=>{const t=[...document.querySelectorAll('[role="treeitem"]')]
    .filter(e=>/刚刚|[0-9]+\\s*(秒|分钟|小时|天|周|月)前?/.test(String(e.textContent||'')));
  if(!t.length) return 'no-recent:'+JSON.stringify([...document.querySelectorAll('[role="treeitem"]')].map(e=>String(e.textContent||'').trim()));
  const b=t[0].getBoundingClientRect(); window.__fxT=[Math.round(b.left+b.width/2),Math.round(b.top+b.height/2)];
  return 'armed:"'+String(t[0].textContent||'').trim().slice(0,30)+'"'})()`)
console.log('  ② 找最近会话树项: ' + armed)
if (String(armed).startsWith('armed')) {
  const [tx, ty] = JSON.parse(await ev(`JSON.stringify(window.__fxT)`))
  await ev(`window.__fxT=null`)
  await realClick(tx, ty)
  await sleep(6000)
  console.log('     点后: ' + await snapshot())
}
console.log('  ③ 挂载后的 bga 类名: ' + await bgaClasses())
console.log('  ④ 几何（CSS px）: ' + await ev(GEOM))
console.log('  ⑤ .bga-dockfx 的 CSS 规则存在: ' + await ev(`(()=>{for(const ss of document.styleSheets){try{for(const r of ss.cssRules){if(String(r.cssText||'').includes('.bga-dockfx'))return 'yes'}}catch(e){}}return 'no'})()`))
ws.close()
