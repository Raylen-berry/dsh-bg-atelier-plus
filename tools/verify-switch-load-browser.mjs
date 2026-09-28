// Isolated load-pressure regression. Image decoding is deliberately delayed to
// expose queued work; this is a controlled stress test, not a hardware FPS claim.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
const {chromium}=await import(process.env.BGA_PLAYWRIGHT?pathToFileURL(process.env.BGA_PLAYWRIGHT).href:'playwright')
const client=await fs.readFile(process.env.BGA_TEST_CLIENT||new URL('../client.js',import.meta.url),'utf8')
const browser=await chromium.launch({headless:true,...(process.env.BGA_BROWSER?{executablePath:process.env.BGA_BROWSER}:{})})
try{
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('http://bga-load.test/**',route=>{
    const url=new URL(route.request().url())
    if(url.pathname.endsWith('.svg'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="3840" height="2160"><rect width="100%" height="100%" fill="#4682b4"/></svg>'})
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body></body></html>'})
    return route.fulfill({contentType:'application/json',body:'{}'})
  })
  await page.goto('http://bga-load.test/')
  await page.evaluate(()=>{window.__ModuleLoader__={load(m){window.mod=m}};window.fakeReact={createElement(){},memo:f=>f}})
  await page.addScriptTag({content:client})
  await page.evaluate(()=>{
    window.bga=mod.factory(()=>fakeReact);window.api=bga.internals
    window.cleanup=[];bga.apply({get(){},effect(fn){const off=fn();if(off)cleanup.push(off)}})
    api.STORE.list=Array.from({length:101},(_,i)=>({id:String(i),base:String(i),url:'/'+i+'.svg'}))
    api.STORE.set({fadeOn:false,wallpaper:{id:'0',url:'/0.svg'},autoOn:false,fadeMs:2800})
    api.setPlaybackSource('all');api.setPlaybackMode('ordered');api.STORE.set({fadeOn:true})
    window.stats={started:0,active:0,peak:0,commits:0,events:0}
    window.decodeDelay=180
    const nativeDecode=Image.prototype.decode
    Image.prototype.decode=function(){
      stats.started++;stats.active++;stats.peak=Math.max(stats.peak,stats.active)
      return Promise.all([nativeDecode.call(this),new Promise(r=>setTimeout(r,decodeDelay))]).then(()=>{},()=>{}).finally(()=>stats.active--)
    }
    let last=api.STORE.state.wallpaper
    api.STORE.subscribe(()=>{if(last!==api.STORE.state.wallpaper){stats.commits++;last=api.STORE.state.wallpaper}})
    const btn=document.createElement('button');btn.id='next';btn.textContent='换一张';btn.onclick=()=>{stats.events++;api.cycleWallpaper()};document.body.append(btn)
  })
  // 60 accepted inputs, not 60 image jobs. Counters keep moving while the slot is busy.
  await page.evaluate(async()=>{for(let i=0;i<60;i++){document.getElementById('next').click();await new Promise(r=>setTimeout(r,8))}})
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='60'&&!document.querySelector('[data-bg-atelier-fade]'),null,{timeout:6000})
  const slow=await page.evaluate(()=>({...stats,id:api.STORE.state.wallpaper.id,shown:api.renderedBgUrl()}))
  console.log('DECODE_PRESSURE',JSON.stringify(slow))
  if(!process.env.BGA_BENCH_ONLY){
    assert.equal(slow.events,60);assert.equal(slow.id,'60');assert.equal(slow.shown,'/60.svg')
    assert.equal(slow.peak,1,'never overlap application-owned original image decoding')
    assert.ok(slow.started<=6,'coalesce expensive image work without losing click positions')
  }
  await page.evaluate(()=>{decodeDelay=0;stats.started=stats.active=stats.peak=stats.commits=stats.events=0;api.setPlaybackSource('all')})
  await page.evaluate(async()=>{for(let i=0;i<30;i++){document.getElementById('next').click();await new Promise(r=>setTimeout(r,15))}})
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='90'&&!document.querySelector('[data-bg-atelier-fade]'),null,{timeout:6000})
  const warm=await page.evaluate(()=>({...stats,id:api.STORE.state.wallpaper.id,shown:api.renderedBgUrl()}))
  console.log('WARM_PRESSURE',JSON.stringify(warm))
  if(!process.env.BGA_BENCH_ONLY){assert.equal(warm.peak,1);assert.ok(warm.commits<=5,'queued images cannot refresh the UI on every click')}
  await page.evaluate(()=>cleanup.reverse().forEach(fn=>fn()))
  assert.deepEqual(errors,[])
  console.log(process.env.BGA_BENCH_ONLY?'BENCH complete (baseline counts only)':'PASS load-pressure workflow / exact click positions / bounded decoder / no UI update flood / cleanup')
}finally{await browser.close()}
