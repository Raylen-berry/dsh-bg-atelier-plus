import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
const src=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8')
let loaded, seq=0, reads={}, requests=[]
const timers=new Map()
const sandbox={console,window:{__ModuleLoader__:{load(m){loaded=m}}},setTimeout(fn,ms){const id=++seq;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},
  fetch(url,opts){if(opts?.method==='PUT')return new Promise(resolve=>requests.push({body:JSON.parse(opts.body),resolve}));return Promise.resolve({ok:true,json:async()=>reads})}}
vm.runInNewContext(src,sandbox)
const api=loaded.factory(()=>({createElement(){},memo:f=>f})).internals
const S=api.STORE
const items=['a','b','c','d'].map((n,i)=>({id:(i<2?'日间':'夜间')+'\0'+n+'.png',cat:i<2?'日间':'夜间',base:n,file:n+'.png',url:'/bga/wallpapers/'+n+'.png'}))
S.list=items
const plain=v=>JSON.parse(JSON.stringify(v))
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
assert.deepEqual(plain(S.state.playlists),[{id:'favorites',name:'我喜欢',items:[]}])
const first=api.createPlaylist('  夜间工作  ',[items[0].id,items[0].id,items[2].id])
assert.equal(S.state.playlists[1].name,'夜间工作')
assert.equal(S.state.playlists[1].items.length,2)
assert.throws(()=>api.createPlaylist('夜间工作',[]),/同名/)
assert.throws(()=>api.createPlaylist(' ',[]),/名字/)
api.toggleFavorite(items[0].id);api.toggleFavorite(items[1].id);api.toggleFavorite(items[1].id)
const second=api.createPlaylist('角色',[])
api.changeMembership([items[0].id,items[1].id],[second],false)
assert.equal(S.state.playlists.find(p=>p.id===first).items.length,2,'bulk add preserves other lists')
api.changeMembership([items[0].id],[first],true)
assert.equal(S.state.playlists.find(p=>p.id===second).items.includes(items[0].id),false,'single-item editor supports removal')
api.renamePlaylist(second,'午后')
assert.throws(()=>api.renamePlaylist(second,'夜间工作'),/同名/)
assert.equal(S.state.playlists.find(p=>p.id===second).name,'午后')
api.removePlaylist('favorites')
assert.ok(S.state.playlists.find(p=>p.id==='favorites'))
console.log('PASS create / names / duplicate prevention / favorites / multi-list membership / rename')

for(const source of ['list:'+first,'cat:夜间']){
  api.setPlaybackSource(source)
  const allowed=new Set(api.sourceItems(source).map(it=>it.id))
  for(let i=0;i<35;i++){api.cycleWallpaper();assert.ok(allowed.has(S.state.wallpaper.id),'scope leaked to '+S.state.wallpaper.id)}
}
assert.equal(S.state.recent.length,new Set(S.state.recent).size)
assert.equal(S.state.recent[0],S.state.wallpaper.id)
const before=S.state.wallpaper
const empty=api.createPlaylist('空图单',[])
api.setPlaybackSource('list:'+empty);api.cycleWallpaper()
assert.equal(S.state.wallpaper,before,'empty playlists must not fall back to full library')
api.setPlaybackSource('list:missing');api.cycleWallpaper()
assert.equal(S.state.wallpaper,before,'missing playlists must not fall back to full library')
api.setPlaybackSource('list:'+first);S.set({autoOn:true});api.removePlaylist(first)
assert.equal(S.state.autoOn,false,'deleting active source pauses playback')
assert.equal(S.state.playbackSource,'all')
assert.equal(S.list.length,4,'playlist deletion never deletes original images')
console.log('PASS scoped random switching / category scope / recent history / empty & missing lists / deletion pauses')

const ordered=api.createPlaylist('顺序验证',[items[2].id,'暂时缺失',items[0].id,items[1].id,items[3].id])
api.setPlaybackSource('list:'+ordered);api.setPlaybackMode('ordered');api.setWallpaper(items[2])
for(const i of [0,1,3,2]){api.cycleWallpaper();assert.equal(S.state.wallpaper.id,items[i].id,'ordered traversal skips missing files and wraps')}
api.setPlaybackSource('all');api.setPlaybackSource('list:'+ordered)
api.setWallpaper(items[2]);api.cycleWallpaper();api.cycleWallpaper()
api.previousWallpaper();assert.equal(S.state.wallpaper.id,items[0].id)
api.previousWallpaper();assert.equal(S.state.wallpaper.id,items[2].id)
assert.equal(api.canPreviousWallpaper(),false,'history must end without wrapping')
api.cycleWallpaper();assert.equal(S.state.wallpaper.id,items[0].id,'next retraces the forward history')
api.setWallpaper(items[3]);api.previousWallpaper();assert.equal(S.state.wallpaper.id,items[0].id,'direct choices enter history')
api.setPlaybackMode('ordered');api.cycleWallpaper();assert.equal(S.state.wallpaper.id,items[1].id,'changing mode discards forward branch')
api.reorderPlaylist(ordered,items[1].id,items[2].id)
assert.deepEqual(plain(api.sourceItems('list:'+ordered).map(it=>it.id)),[items[1].id,items[2].id,items[0].id,items[3].id])
const orderedIds=plain(S.state.playlists.find(p=>p.id===ordered).items)
api.changeMembership([items[2].id],[ordered],false)
assert.deepEqual(plain(S.state.playlists.find(p=>p.id===ordered).items),orderedIds,'re-adding must preserve manual order')
assert.ok(orderedIds.includes('暂时缺失'),'reorder preserves missing references')
api.setWallpaper(items[1]);api.cycleWallpaper();assert.equal(S.state.wallpaper.id,items[2].id,'next follows rearranged order')
api.removeFromPlaylist(ordered,[items[1].id]);api.previousWallpaper()
assert.notEqual(S.state.wallpaper.id,items[1].id,'previous cannot revive removed membership')
api.setPlaybackSource('cat:日间');assert.equal(api.canPreviousWallpaper(),false,'new scope starts its own history')
api.setWallpaper(items[0]);api.cycleWallpaper();assert.equal(S.state.wallpaper.id,items[1].id,'ordered folders')
S.set({weId:'loading'});api.previousWallpaper();api.cycleWallpaper();assert.equal(S.state.wallpaper.id,items[1].id,'WE loading suspends both controls');S.set({weId:null})
console.log('PASS sequential loop / previous & forward / history boundaries / scope changes / reorder / duplicate membership / missing files / WE loading')

S.set({zoom:1.1,focus:'50% 0%'}) // legacy settings remain the fallback for unedited images
api.setWallpaper(items[0]);api.setImageFraming({zoom:1.8,focus:'100% 50%'})
api.setWallpaper(items[1]);assert.deepEqual(plain(api.framingOf(S.state,S.state.wallpaper)),{zoom:1.1,focus:'50% 0%'})
api.setImageFraming({zoom:1.3,focus:'0% 100%'})
api.setWallpaper(items[0]);assert.deepEqual(plain(api.framingOf(S.state,S.state.wallpaper)),{zoom:1.8,focus:'100% 50%'})
assert.equal(S.state.zoom,1.1,'image edits must not overwrite legacy defaults')
api.setPlaybackSource('all');assert.deepEqual(plain(api.framingOf(S.state,items[0])),{zoom:1.8,focus:'100% 50%'},'same image across playlists')
api.resetImageFraming();assert.deepEqual(plain(api.framingOf(S.state,items[0])),{zoom:1,focus:'50% 50%'})
assert.deepEqual(plain(api.framingOf(S.state,items[1])),{zoom:1.3,focus:'0% 100%'},'reset changes only current image')
const frames=plain(S.state.imageFraming)
S.set({wallpaper:null});api.setImageFraming({zoom:2});assert.deepEqual(plain(S.state.imageFraming),frames)
const hostile={bad:{zoom:Infinity,focus:'50%;color:red'},wide:{zoom:9,focus:'900% 12.5%'},broken:[],nil:null}
assert.deepEqual(plain(api.normalizeImageFraming(hostile)),{bad:{zoom:1,focus:'50% 50%'},wide:{zoom:2.2,focus:'100% 12.5%'}})
console.log('PASS independent framing / legacy defaults / shared across playlists / reset only current / malformed values')

const normalized=api.normalizePlaylists([{id:'favorites',name:'x',items:[items[0].id,items[0].id,9]},null,{id:'bad/id',name:'x'}, {id:'same',name:' 一 ',items:[items[1].id]}, {id:'same',name:'重复',items:[]}])
assert.deepEqual(plain(normalized),[{id:'favorites',name:'我喜欢',items:[items[0].id]},{id:'same',name:'一',items:[items[1].id]}])
const oldLog=console.log;console.log=()=>{}
const {validate}=await import('./settings.mjs');console.log=oldLog
const payload={...plain(S.state),playlists:plain(normalized),weQuality:'saver'}
assert.deepEqual(validate(payload).settings.playlists,payload.playlists)
assert.deepEqual(validate(payload).settings.recent,payload.recent)
assert.equal(validate(payload).settings.playbackSource,payload.playbackSource)
assert.equal(validate(payload).settings.weQuality,'saver')
assert.equal(validate(payload).settings.playbackMode,'ordered')
assert.deepEqual(plain(validate(payload).settings.imageFraming),frames)
assert.deepEqual(plain(validate({imageFraming:hostile}).settings.imageFraming),plain(api.normalizeImageFraming(hostile)))
assert.ok(!validate(payload).notes.some(n=>n.includes('未知字段')))
console.log('PASS invalid data normalization / portable settings retain playlists, scope, history and WE preferences')

reads={wallpaper:null,playlists:payload.playlists,playbackSource:'list:same',recent:payload.recent,playbackMode:'ordered',imageFraming:frames}
await S.load()
assert.equal(S.state.playbackSource,'list:same')
assert.deepEqual(plain(S.state.playlists),payload.playlists)
assert.deepEqual(plain(S.state.imageFraming),frames)
assert.equal(S.state.playbackMode,'ordered')
S.flushSave();await settle()
assert.equal(requests.length,1)
api.createPlaylist('保存中追加',[]);S.flushSave();await settle()
assert.equal(requests.length,1,'writes must be serialized')
requests[0].resolve({ok:true});await settle()
assert.equal(requests.length,2)
assert.ok(requests[1].body.playlists.some(p=>p.name==='保存中追加'),'second write includes latest state')
requests[1].resolve({ok:false});await settle()
assert.equal(S.saveStatus,'error','failed persistence must be visible')
S.save();S.flushSave();await settle();requests[2].resolve({ok:true});await settle()
assert.equal(S.saveStatus,'saved')
reads={};await S.load()
assert.ok(S.saveStatus!=='load-error','fresh empty settings remain usable')
console.log('PASS restoration / serialized writes / latest data wins / save failure and retry / fresh install')

// Renaming a local image must preserve references in saved collections and framing.
for(const [cat,old,name] of [['高清','贝利尔2','贝丽尔2'],['重返未来1999','以影像之2','以影相之2'],['重返未来1999','维拉','维拉2']]) {
  const oldId=cat+'\0'+old+'.png',id=cat+'\0'+name+'.png'
  const url=n=>'/bga/wallpapers/'+encodeURIComponent(cat)+'/'+encodeURIComponent(n+'.png')
  reads={wallpaper:{id:oldId,cat,file:old+'.png',name:old,url:url(old),hd:cat==='高清'},
    playlists:[{id:'favorites',name:'我喜欢',items:[oldId,id]},{id:'multi',name:'贝利尔与艾吉奥Apple',items:['高清\0艾吉奥Apple.png']}],
    recent:[oldId,id],imageFraming:{[oldId]:{zoom:1.3,focus:'20% 50%'},[id]:{zoom:1.5,focus:'40% 60%'}}}
  await S.load()
  assert.equal(S.state.wallpaper.id,id);assert.equal(S.state.wallpaper.url,url(name));assert.equal(S.state.wallpaper.name,name)
  assert.deepEqual(plain(S.state.playlists[0].items),[id]);assert.deepEqual(plain(S.state.recent),[id])
  assert.equal(S.state.playlists[1].name,'贝利尔与艾吉奥Apple');assert.equal(S.state.playlists[1].items[0],'高清\0艾吉奥Apple.png')
  assert.equal(S.state.imageFraming[id].zoom,1.5);assert.equal(S.state.imageFraming[oldId],undefined)
}
console.log('PASS renamed wallpaper references migrate on load; favorites, recent, framing and multi-character names preserved')

// Exercise the actual host handler with a realistic collection bigger than the old 8 KB cap.
const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'bga-playlist-settings-'))
const previousHome=process.env.DSH_HOME
process.env.DSH_HOME=tempRoot
const originalSetTimeout=globalThis.setTimeout, hostTimers=[]
globalThis.setTimeout=(fn,ms,...args)=>{const timer=originalSetTimeout(fn,ms,...args);hostTimers.push(timer);return timer}
try{
  let route
  const host=await import('../index.js')
  await host.apply({get:n=>n==='webServer'?{register:r=>{route=r;return()=>{}}}:undefined,
    effect(fn,label){if(label==='dsh-bg-atelier: settings route')return fn()}})
  assert.equal(route.path,'/bga/settings.json')
  const large={...payload,playlists:[{id:'favorites',name:'我喜欢',items:Array.from({length:600},(_,i)=>'重返未来1999\0用于验证图单持久化的图片-'+i+'.png')}]}
  const body=JSON.stringify(large)
  assert.ok(Buffer.byteLength(body)>8192)
  async function request(method,body=''){
    const req=Readable.from([Buffer.from(body)]);req.method=method
    return new Promise((resolve,reject)=>{const res={writeHead(status){this.status=status},end(value){resolve({status:this.status,body:JSON.parse(value)})}};route.handler(req,res).catch(reject)})
  }
  assert.equal((await request('PUT',body)).status,200)
  assert.deepEqual((await request('GET')).body,large)
  console.log('PASS actual settings route round-trip: 600 image references, '+Buffer.byteLength(body)+' bytes')
}finally{
  globalThis.setTimeout=originalSetTimeout
  hostTimers.forEach(clearTimeout)
  if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome
  const resolved=path.resolve(tempRoot), parent=path.resolve(os.tmpdir())+path.sep
  if(!resolved.startsWith(parent)||!path.basename(resolved).startsWith('bga-playlist-settings-'))throw Error('Unexpected cleanup target')
  fs.rmSync(resolved,{recursive:true,force:true})
}
