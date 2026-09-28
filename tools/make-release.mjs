#!/usr/bin/env node
// tools/make-release.mjs —— 把清单里的底图发布/补齐到 GitHub Release（tag 见清单 release.tag）
//
// 为什么要有它：底图不进 git（走 Release 资产 + 按需下载），发版就是"清单 ↔ Release"的对账。
// 手工 `gh release upload` 会踩两个坑，这里全部代劳：
//   ① **同名不同内容的资产绝不能覆盖上传** —— gh --clobber 会把 w08 悄悄换成另一张图，
//      所有机器按清单校验时集体 sha256 不符。本脚本对每个 asset 比对磁盘字节数与 Release
//      现值：一致 → 跳过；不一致 → **拒绝并报错**（那是编号漂移，得回头修清单）。
//   ② 大文件（最大 60MB × N）逐个传，中断后要能续 —— 每传完一张立刻 HEAD 回验字节数，
//      下次重跑自动把它归入"已在"，天然断点续传。
//
// 用法（在插件目录）：
//   node tools/make-release.mjs              # 补传差额（只传 Release 上没有的）
//   node tools/make-release.mjs --dry-run    # 只对账、不上传（新机器/CI 上先跑这个）
//   node tools/make-release.mjs --token ***  # 默认读 GH_TOKEN / GITHUB_TOKEN 环境变量
//
// token 权限：contents=write（发布 Release 资产）。没有 token 且未 `gh auth login` 时直接失败退出。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = path.join(ROOT, 'wallpapers.manifest.json')
const WALL = path.join(ROOT, 'wallpapers')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const tokenIdx = argv.indexOf('--token')
const TOKEN = tokenIdx >= 0 ? argv[tokenIdx + 1] : (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '')
if (tokenIdx >= 0 && !TOKEN) { console.error('--token 后面没给值'); process.exit(1) }

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const { repo, tag, base } = manifest.release

// ---- 1) 列出现有 Release 资产（GET 公开接口，无需 token；Release 不存在则视为空） ----
// 注意：release.assets 内嵌列表**封顶 30 条**（本机 tag 实有 39 ⇒ 曾把 w31~w39 误判成"待传"）。
// 必须走 /releases/{id}/assets?per_page=100 分页端点。
async function listAssets() {
  const H = { 'user-agent': 'dsh-bg-atelier-make-release', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) }
  const rel = await fetch('https://api.github.com/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag), { headers: H })
  if (rel.status === 404) return new Map()    // tag 还没建 —— 下面走 create
  if (!rel.ok) throw new Error('查 Release 失败 HTTP ' + rel.status + '：' + (await rel.text()).slice(0, 200))
  const id = (await rel.json()).id
  const out = new Map()
  for (let page = 1; ; page++) {
    const res = await fetch('https://api.github.com/repos/' + repo + '/releases/' + id + '/assets?per_page=100&page=' + page, { headers: H })
    if (!res.ok) throw new Error('列资产失败 HTTP ' + res.status + '：' + (await res.text()).slice(0, 200))
    const arr = await res.json()
    for (const a of arr) out.set(a.name, a.size)
    if (arr.length < 100) break
  }
  return out
}

// ---- 2) 对账：missing（要传）/ ok（跳过）/ mismatch（拒绝）----
const existing = await listAssets()
const missing = [], okList = [], mismatch = [], noFile = []
for (const it of manifest.items) {
  const file = path.join(WALL, it.path)
  if (!fs.existsSync(file)) { noFile.push(it); continue }
  const diskBytes = fs.statSync(file).size
  const relBytes = existing.get(it.asset)
  if (relBytes === undefined) missing.push({ ...it, file, diskBytes })
  else if (relBytes !== diskBytes) mismatch.push({ ...it, relBytes })
  else okList.push(it)
}

console.log('仓库 ' + repo + ' · tag ' + tag)
console.log('清单 ' + manifest.items.length + ' 项：已在 Release 且字节一致 ' + okList.length +
  ' · 待传 ' + missing.length + '（' + (missing.reduce((s, m) => s + m.diskBytes, 0) / 1048576).toFixed(1) + ' MB）' +
  ' · 冲突 ' + mismatch.length + ' · 本机缺文件 ' + noFile.length)
for (const m of mismatch) console.error('  ✗ 同名不同内容：' + m.asset + ' Release=' + m.relBytes + ' 磁盘=' + '（清单 bytes=' + m.bytes + '）—— 这是资产编号漂移，先回头核对 make-manifest-append，不要覆盖！')
for (const n of noFile) console.error('  ✗ 清单指向的文件不在盘上：' + n.path)
if (mismatch.length || noFile.length) process.exit(1)
if (!missing.length) { console.log('✓ Release 已与清单一致，无需上传'); process.exit(0) }
if (DRY) { console.log('（--dry-run）待传清单：\n  ' + missing.map((m) => m.asset + '  ' + m.path).join('\n  ')); process.exit(0) }

// ---- 3) 上传（直连 GitHub uploads API，不依赖 gh CLI —— 本机实测没装 gh）----
// upload_url 模板: https://uploads.github.com/repos/<repo>/releases/<id>/assets{?name,label}
// 鉴权 token 优先 GH_TOKEN/GITHUB_TOKEN；都没有时退回 git credential helper 里那份
// （git push 能用的凭据即可发布 Release；只从 stdin 喂给 git，绝不打印）。
function getReleaseId() {
  const H = { 'user-agent': 'dsh-bg-atelier-make-release', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) }
  return fetch('https://api.github.com/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag), { headers: H })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('查 Release HTTP ' + r.status))))
    .then((j) => j.id)
}

async function resolveToken() {
  if (TOKEN) return TOKEN
  try {
    const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true })
    const m = /^password=(.+)$/m.exec(out)
    if (m) return m[1].trim()
  } catch { /* helper 里没有 */ }
  console.error('没有可用凭据：设 GH_TOKEN / GITHUB_TOKEN，或先让 git 能访问 github.com（git credential helper）。')
  process.exit(1)
}

const TOKEN_FINAL = await resolveToken()
let releaseId = null
try {
  releaseId = await getReleaseId()
} catch {
  console.log('Release ' + tag + ' 不存在，创建…')
  const created = await fetch('https://api.github.com/repos/' + repo + '/releases', {
    method: 'POST',
    headers: { 'user-agent': 'dsh-bg-atelier-make-release', authorization: 'Bearer ' + TOKEN_FINAL, 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: '底图工坊原始文件 (' + tag + ')', draft: false, prerelease: false }),
  })
  if (!created.ok) { console.error('创建 Release 失败 HTTP ' + created.status + '：' + (await created.text()).slice(0, 200)); process.exit(1) }
  releaseId = (await created.json()).id
}

let sent = 0
for (const m of missing) {
  const label = '[' + (sent + 1) + '/' + missing.length + '] ' + m.asset + ' ← ' + m.path + ' ' + (m.diskBytes / 1048576).toFixed(1) + 'MB'
  process.stdout.write(label + ' … ')
  try {
    const res = await fetch('https://uploads.github.com/repos/' + repo + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(m.asset), {
      method: 'POST',
      headers: { 'user-agent': 'dsh-bg-atelier-make-release', authorization: 'Bearer ' + TOKEN_FINAL, 'content-type': 'application/octet-stream', 'content-length': String(m.diskBytes) },
      body: fs.createReadStream(m.file),
      duplex: 'half',            // Node fetch: 流式请求体的必需开关
    })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160))
    await res.arrayBuffer().catch(() => {})   // 读完响应体，别把连接吊着
  } catch (e) {
    console.log('失败')
    console.error('  ✗ ' + String(e.message || e))
    console.error('  已传 ' + sent + ' 张可直接重跑续传（每张传完都有回验，成功的不会重传）。')
    process.exit(1)
  }
  // 传完立刻回验字节数 —— 不等全批结束才发现错位。
  // 用 API（带 token）而不是 HEAD 下载链：objects CDN 在本机直连会被 TLS reset /
  // 间歇 ECONNRESET（见 fetch-wallpapers.js 头部注释），HEAD 回验会假报"已传但失败"，
  // 而 release 资产表里的 size 就是 GitHub 收到的字节数，且这条链路实测稳定。
  let verified = false, remoteSize = null
  for (let t = 0; t < 4 && !verified; t++) {
    if (t) await new Promise((r) => setTimeout(r, 1000 * t))
    try {
      // **必须翻页找**：/assets 不给 page 时只回第一页，给 per_page=100 也只是"第一页最多 100 条"。
      // 资产数超过 100 之后，刚传的那张根本不在第一页里 ⇒ size 永远读到 null，
      // 实测 w182.png 就是这么"已传但回验失败"的（不是 GitHub 慢，是没翻页）。
      for (let page = 1; page <= 10; page++) {
        const av = await fetch('https://api.github.com/repos/' + repo + '/releases/' + releaseId + '/assets?per_page=100&page=' + page, { headers: { 'user-agent': 'dsh-bg-atelier-make-release', authorization: 'Bearer ' + TOKEN_FINAL } })
        if (!av.ok) break
        const list = await av.json()
        const hit = list.find((a) => a.name === m.asset)
        if (hit) { remoteSize = hit.size; break }
        if (list.length < 100) break
      }
      verified = remoteSize === m.diskBytes
    } catch { /* 重试 */ }
  }
  if (!verified) { console.log('已传但回验失败'); console.error('  ✗ ' + m.asset + ' 资产表 size=' + remoteSize + ' ≠ 磁盘 ' + m.diskBytes + ' —— 重跑本脚本即可（它会重新对账）'); process.exit(1) }
  console.log('✓ 回验通过')
  sent++
}
console.log('\n完成：本次上传 ' + sent + ' 张 · Release ' + tag + ' 现与清单完全一致。')
console.log('下一步（可选）：把清单提交进 git —— git add wallpapers.manifest.json && git commit')
