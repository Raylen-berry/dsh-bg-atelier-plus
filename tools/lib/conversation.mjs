// tools/lib/conversation.mjs —— 共用的「打开一个真会话」逻辑
//
// 为什么抽出来：**动效层只在有会话时才挂载**（`DockFx` 注册在
// `conversation.composer.dock`，client.js:3133），而"怎么认出一条会话行"这件事
// 在两个工具里各写了一遍，且其中一处只靠**相对时间文案**（"刚刚 / 6分钟 / 12天"）——
// 实测跑几十分钟后文案一变就匹配不到，整轮报"未就绪跳过"。这里统一成一个判据。
//
// 判据（按可靠性排序，任一命中即算会话行）：
//   ① **结构锚**：应用给会话行加了含 `sessionRow` 的类（与哈希前缀无关的那截）；
//   ② 退路：文本以相对时间结尾（`刚刚 / N秒|分钟|小时|天|周|月[前]`）。
// 并排除以「新会话」开头的那条（空会话，停在 hero 页、不挂载动效层）。
//
// ⚠️ 本文件里的表达式会被送进**页面**求值：所以
//   · 不能出现反引号（会把调用方的模板字符串提前闭合，踩过 5 次）；
//   · 不能用 Node 侧变量（页面看不到，踩过：opts is not defined）。

/** 返回"会话行"元素（JS 表达式字符串，求值结果是元素或 null）。 */
export const SESSION_ROW_JS = `(()=>{
  const items=[...document.querySelectorAll('[role="treeitem"]')];
  let cand=items.filter(e=>/sessionRow/.test(String(e.className))||e.querySelector('[class*="sessionRow"]'));
  if(!cand.length) cand=items.filter(e=>/(刚刚|[0-9]+\\s*(秒|分钟|小时|天|周|月)前?)\\s*$/.test(String(e.textContent||'').trim()));
  cand=cand.filter(e=>!String(e.textContent||'').trim().startsWith('新会话'));
  return cand[0]||null})()`

/** 返回"工作区分组行"（找不到会话行时先点它把树展开）。 */
export const WORKSPACE_ROW_JS = `document.querySelectorAll('[role="treeitem"]')[0] || null`

/** 会话已打开的标志：会话气泡数量。 */
export const BUBBLES_JS = `document.querySelectorAll('[class*="_bubble"]').length`

/**
 * 把"取元素"表达式包成"取中心坐标"表达式（真实鼠标点击要用坐标）。
 * 返回 JSON 字符串 `{x,y,t}` 或 null。
 */
export function armExpr(elementJs) {
  return `(()=>{const el=(${elementJs}); if(!el) return null;
    const r=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:String(el.textContent||'').trim().slice(0,26)})})()`
}

/**
 * 打开一个真会话（幂等）。
 *
 * @param {object} io
 * @param {(expr:string)=>Promise<any>} io.ev      页面上求值
 * @param {(x:number,y:number)=>Promise<void>} io.click  发**真实鼠标**事件
 * @param {(ms:number)=>Promise<void>} io.sleep
 * @param {(msg:string)=>void} [io.log]
 * @returns {Promise<{ok:boolean, how:string, bubbles?:number}>}
 */
export async function openConversation({ ev, click, sleep, log = () => {} }) {
  const bubbles0 = await ev(BUBBLES_JS)
  if (typeof bubbles0 === 'number' && bubbles0 > 0) return { ok: true, how: 'already-open', bubbles: bubbles0 }

  const arm = async (expr) => {
    const raw = await ev(armExpr(expr)).catch(() => null)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const row = await arm(SESSION_ROW_JS)
    if (row) {
      await click(row.x, row.y)
      await sleep(4200)
      const now = await ev(BUBBLES_JS)
      if (typeof now === 'number' && now > 0) return { ok: true, how: 'clicked:' + row.t, bubbles: now }
      log('     会话行点了但气泡仍为 0（第 ' + attempt + ' 次）')
    } else {
      log('     没找到会话行（第 ' + attempt + ' 次）')
    }
    // 展开回退：树是收起的（resetToCleanHome 之后常这样）⇒ 先点工作区分组行
    const ws = await arm(WORKSPACE_ROW_JS)
    if (!ws) return { ok: false, how: 'no-treeitem' }
    log('     先展开「' + ws.t + '」再找')
    await click(ws.x, ws.y)
    await sleep(1800)
  }
  return { ok: false, how: 'no-session' }
}
