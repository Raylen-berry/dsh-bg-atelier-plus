// Frozen frames and late callbacks are deliberate: background time must not be replayed.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const source=fs.readFileSync(process.env.BGA_TEST_CLIENT || new URL('../client.js',import.meta.url),'utf8')
const timers=new Map(),frames=[],decodes=[],cleanups=[]
let seq=0,loaded,focused=true,opacity=1,listResolve
const events=()=>({listeners:new Map(),addEventListener(n,fn){if(!this.listeners.has(n))this.listeners.set(n,new Set());this.listeners.get(n).add(fn)},removeEventListener(n,fn){this.listeners.get(n)?.delete(fn)},emit(n){for(const fn of this.listeners.get(n)||[])fn()}})
const head={children:[],appendChild(el){el.parentNode=this;this.children.push(el)},removeChild(el){this.children=this.children.filter(x=>x!==el);el.parentNode=null}}
const document={...events(),head,body:{},hidden:false,hasFocus:()=>focused,createElement:()=>({attributes:{},textContent:'',setAttribute(k,v){this.attributes[k]=v}})}
const window={...events(),__ModuleLoader__:{load(m){loaded=m}}}
const sandbox={window,document,console,setTimeout(fn,ms){const id=++seq;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},requestAnimationFrame(fn){frames.push(fn)},getComputedStyle(){return{content:'""',opacity:String(opacity)}},
  Image:class{decode(){return new Promise((resolve,reject)=>decodes.push({img:this,resolve,reject}))}},
  fetch(url){if(url==='/bga/wallpapers.json')return new Promise(resolve=>{listResolve=resolve});return Promise.resolve({ok:false})}}
vm.runInNewContext(source,sandbox)
const mod=loaded.factory(()=>({createElement(){},memo:f=>f})),api=mod.internals,S=api.STORE
const items=['a','b','c','d'].map(id=>({id,base:id,url:'/'+id+'.png'}))
Object.assign(S.state,{wallpaper:{...items[0]},autoOn:true,autoMin:3,playbackMode:'ordered'})
S.list=items
mod.apply({get(){},effect(fn,label){if(['bga-dynamic','bga-watch','bga-visibility'].includes(label)){const off=fn();if(off)cleanups.push(off)}}})
api.armAuto(true)
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
const fades=()=>head.children.filter(x=>x.attributes['data-bg-atelier-fade'])
const auto=()=>[...timers.values()].filter(t=>t.ms===180000)
const hidden=()=>{document.hidden=true;document.emit('visibilitychange')}
const visible=()=>{document.hidden=false;document.emit('visibilitychange')}
const frame=()=>frames.splice(0).forEach(fn=>fn())

const expired=auto()[0].fn
hidden()
assert.equal(api.autoPending(),false,'background must stop the automatic countdown')
for(let i=0;i<10;i++){expired();api.autoTick()}
assert.equal(decodes.length,0,'ten elapsed background intervals cannot start decoding')
visible()
assert.equal(auto().length,1)
assert.equal(auto()[0].ms,180000,'resume starts one complete interval')
expired()
assert.equal(decodes.length,0,'an already queued callback remains stale after resume')
console.log('PASS background countdown paused / ten elapsed intervals discarded / stale callbacks invalidated')

api.cycleWallpaper()
const late=decodes.at(-1)
hidden()
assert.equal(late.img.src,'','background cancels an in-flight original image')
visible();late.resolve();await settle()
assert.equal(S.state.wallpaper.id,'a')
assert.equal(api.wallpaperRequestPending(),false)
api.cycleWallpaper();decodes.at(-1).resolve();await settle()
assert.equal(S.state.wallpaper.id,'b')
assert.equal(fades().length,1)
api.cycleWallpaper()
assert.equal(api.wallpaperRequestPending(),true)
hidden()
assert.equal(fades().length,0,'background removes a transition waiting for its first frame')
assert.equal(api.wallpaperRequestPending(),false,'discard the unpainted next selection')
assert.equal(api.renderedBgUrl(),'/b.png')
visible();frame();frame()
assert.equal(fades().length,0,'late animation frames cannot resurrect the old transition')
api.cycleWallpaper();decodes.at(-1).resolve();await settle()
assert.equal(S.state.wallpaper.id,'c','manual navigation works after resume')
frame();frame();opacity=0
const sweep=[...timers.values()].find(t=>t.ms===950 || t.ms===350)
assert(sweep);sweep.fn()
assert.equal(fades().length,0)
console.log('PASS suspend during decode / before first fade frame / queued manual input / manual recovery')

S.list=[];api.cycleWallpaper()
hidden();visible()
const count=decodes.length
listResolve({ok:true,json:async()=>({categories:[{name:'test',items:items.map(it=>({...it,file:it.id+'.png'}))}]})})
await settle()
assert.equal(decodes.length,count,'late library response cannot resume an obsolete cycle')
S.list=items
focused=false;window.emit('blur')
assert.equal(api.autoPending(),false,'an unfocused but visible desktop window also pauses')
focused=true;window.emit('focus')
assert.equal(auto().length,1)
window.emit('pageshow');window.emit('focus')
assert.equal(auto().length,1,'duplicate lifecycle events cannot reset or duplicate timers')
S.set({autoOn:false});hidden();visible()
assert.equal(api.autoPending(),false,'resume respects autoOff')
cleanups.reverse().forEach(fn=>fn())
assert.equal(api.autoPending(),false)
assert.equal([...document.listeners.values(),...window.listeners.values()].reduce((n,s)=>n+s.size,0),0)
console.log('PASS late library result / window blur / repeated lifecycle events / disabled auto / cleanup')
