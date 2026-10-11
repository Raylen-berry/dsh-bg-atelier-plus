// tools/probe-fx-mount.mjs —— 动效层**挂载条件**探针（只读，不改任何东西）
//
// 为什么需要：状态 `02-fx-nodes` 的注释声称覆盖 `bga-dockfx` / `bga-ptl`，但实测探针只有
// `bga-orb` / `bga-orb-core` —— 动效层根本没挂载。要把它做成"真覆盖"，先得**知道它凭什么挂载**。
// 这个脚本用 CDP 在现场逐个试探条件，把结果打出来（不猜）。
//
// 用法（由 iso-instance run --extra-script 调用；也可手跑，需 VB_CDP_PORT / VB_GUI_HOST）：
//   node tools/probe-fx-mount.mjs
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

const snapshot = () => ev(`(()=>{
  const cls=[...document.querySelectorAll('[class*="bga"]')].map(e=>String(e.className).split(/\\s+/).filter(c=>c.startsWith('bga')).join('.'));
  const st=window.__bgaStateProbe?window.__bgaStateProbe():null;
  return JSON.stringify({
    nodes:cls,
    effect: st?st.effect:null,
    hasWallpaper: !!(st&&st.wallpaper),
    dockfx: !!document.querySelector('.bga-dockfx'),
    dockfxBox: (()=>{const d=document.querySelector('.bga-dockfx'); if(!d) return null; const r=d.getBoundingClientRect(); return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})(),
    composer: !!document.querySelector('[data-composer-card],textarea,form textarea'),
    treeItems: document.querySelectorAll('[role="treeitem"]').length,
    heroText: (document.body.innerText||'').slice(0,60).replace(/\\n/g,' ')
  })})()`)

console.log('=== 动效层挂载条件探针 ===')
console.log('  ① 初始: ' + await snapshot())

// 逐个试"怎么才能进到有 composer dock 槽的会话视图"——把每条的结果都打出来，不猜。
const attempts = [
  ['快捷键 Ctrl+Alt+N', `(()=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,altKey:true,bubbles:true}));return 'dispatched'})()`],
  ['点树项 #1', `(()=>{const t=document.querySelectorAll('[role="treeitem"]');if(!t[0])return 'no-treeitem';t[0].click();return 'clicked:'+String(t[0].textContent||'').trim().slice(0,20)})()`],
  ['点树项 #2', `(()=>{const t=document.querySelectorAll('[role="treeitem"]');if(!t[1])return 'no-treeitem';t[1].click();return 'clicked:'+String(t[1].textContent||'').trim().slice(0,20)})()`],
  ['模糊找「新会话」并点其可点祖先', `(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&String(e.textContent||'').trim().startsWith('新会话'));
    if(!el)return 'not-found';const c=el.closest('button,[role="button"],[role="treeitem"],a,li,div[tabindex]')||el;c.click();return 'clicked-tag:'+c.tagName})()`],
  ['点中央 hero 输入区（新会话入口）', `(()=>{const t=document.querySelector('textarea');if(!t)return 'no-textarea';t.focus();t.click();return 'focused-textarea'})()`],
]
for (const [label, expr] of attempts) {
  const r = await ev(expr)
  await sleep(3500)
  const s = JSON.parse(await snapshot())
  console.log('  ② ' + label + ' → ' + r)
  console.log('     dockfx=' + s.dockfx + ' nodes=[' + s.nodes.join(',') + '] treeItems=' + s.treeItems + ' hero="' + String(s.heroText).slice(0, 40) + '"')
  if (s.dockfx) { console.log('     ★★ 动效层已挂载！dockfxBox=' + JSON.stringify(s.dockfxBox)); break }
}
console.log('  ③ 当前设置: ' + await ev(`(async()=>{const r=await fetch('/bga/settings.json',{cache:'no-store'});const j=await r.json();return JSON.stringify({effect:j.effect,autoOn:j.autoOn,wallpaper:j.wallpaper&&j.wallpaper.file})})()`))
console.log('  ④ 页面里所有含 bga 的类名（去重）: ' + await ev(`[...new Set([...document.querySelectorAll('[class*="bga"]')].flatMap(e=>String(e.className).split(/\\s+/).filter(c=>c.startsWith('bga'))))].join(', ')`))
console.log('  ⑤ .bga-dockfx 的 CSS 规则存在: ' + await ev(`(()=>{for(const ss of document.styleSheets){try{for(const r of ss.cssRules){if(String(r.cssText||'').includes('.bga-dockfx')) return 'yes'}}catch(e){}}return 'no'})()`))
console.log('  ⑥ 页面里可点的顶层入口（前 12 个文本）: ' + await ev(`[...document.querySelectorAll('button,[role="button"],[role="treeitem"],a')].slice(0,12).map(e=>(e.tagName+':'+String(e.textContent||'').trim().slice(0,14))).join(' | ')`))

// ⑦ 为什么进不了会话：URL 有没有变、页面文本里有没有"未配置/需要密钥"之类的提示
console.log('  ⑦ click 新会话后的现场：')
console.log('     URL: ' + await ev(`location.href.replace(/token=.*/, 'token=***')`))
console.log('     页面文本前 240 字: ' + await ev(`String(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,240)`))

// ⑧ 用 **CDP 真实输入事件**（不是 element.click / 合成 KeyboardEvent —— 那些不触发应用的指针/快捷键处理器）
const box = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/新会话/.test(String(x.textContent||'')));
  if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:String(b.textContent||'').trim().slice(0,20)})})()`)
console.log('  ⑧ 真实鼠标点击「新会话」（C' + 'DP Input）: 目标 ' + box)
if (box) {
  const p = JSON.parse(box)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  }
  await sleep(6000)
  console.log('     点后: ' + await snapshot())
  console.log('     URL: ' + await ev(`location.href.replace(/token=.*/, 'token=***')`))
}
// ⑨ 真实快捷键 Ctrl+Alt+N（CDP 键盘事件，modifiers: ctrl=2 alt=1）
if (await ev(`!document.querySelector('.bga-dockfx')`)) {
  console.log('  ⑨ 真实快捷键 Ctrl+Alt+N …')
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 3, key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 3, key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78 })
  await sleep(6000)
  console.log('     ' + await snapshot())
}
console.log('  ⑩ localStorage 里有无会话/当前会话: ' + await ev(`JSON.stringify(Object.keys(localStorage).filter(k=>/sess|conversation/i.test(k)))`))
console.log('  ⑪ 最终 bga 类名: ' + await ev(`[...new Set([...document.querySelectorAll('[class*="bga"]')].flatMap(e=>String(e.className).split(/\\s+/).filter(c=>c.startsWith('bga'))))].join(', ')`))

// ⑫ 会话到底怎么建：往 composer 真输一句话并回车（应用应该是"发消息才建会话"）
if (await ev(`!document.querySelector('.bga-dockfx')`)) {
  const comp = await ev(`(()=>{const c=document.querySelector('[contenteditable="true"],[role="textbox"],textarea');
    if(!c) return null; const r=c.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),tag:c.tagName,role:c.getAttribute('role')||'',ce:c.getAttribute('contenteditable')||''})})()`)
  console.log('  ⑫ composer 元素: ' + comp)
  if (comp) {
    const p = JSON.parse(comp)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
    }
    await sleep(600)
    await send('Input.insertText', { text: '验收：打开会话以挂载动效层' })
    await sleep(800)
    // 逐个试"怎么才会真的发送"：Enter / Ctrl+Enter / 点发送按钮。每条都看 bga 类名有没有变化。
    const keyEnter = (mods) => [
      send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mods, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }),
      send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }),
    ]
    const hasDock = async () => (await ev(`!!document.querySelector('.bga-dockfx')`))
    console.log('     试 Enter …'); await Promise.all(keyEnter(0)); await sleep(5000)
    console.log('       dockfx=' + await hasDock())
    if (!await hasDock()) { console.log('     试 Ctrl+Enter …'); await Promise.all(keyEnter(2)); await sleep(5000); console.log('       dockfx=' + await hasDock()) }
    if (!await hasDock()) {
      const btn = await ev(`(()=>{const c=document.querySelector('[role="textbox"]');if(!c)return null;
        const row=c.closest('div[class]')?.parentElement||document.body;
        const bs=[...row.querySelectorAll('button')].filter(b=>!b.disabled);
        const pick=bs.find(b=>/发送|send/i.test((b.getAttribute('aria-label')||'')+(b.getAttribute('title')||'')))||bs[bs.length-1];
        if(!pick)return null;const r=pick.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:(pick.getAttribute('aria-label')||pick.getAttribute('title')||pick.textContent||'').trim().slice(0,16),n:bs.length})})()`)
      console.log('     找发送按钮: ' + btn)
      if (btn) {
        const q = JSON.parse(btn)
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x: q.x, y: q.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
        }
        await sleep(8000)
        console.log('       点后 dockfx=' + await hasDock())
      }
    }
    console.log('     等 15 秒看是否进入会话 …')
    await sleep(15000)
    console.log('     ' + await snapshot())
    console.log('     bga 类名: ' + await ev(`[...new Set([...document.querySelectorAll('[class*="bga"]')].flatMap(e=>String(e.className).split(/\\s+/).filter(c=>c.startsWith('bga'))))].join(', ')`))
  }
}
ws.close()
