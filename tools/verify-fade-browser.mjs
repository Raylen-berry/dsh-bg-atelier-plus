// Real Chromium integration check. Run with BGA_PLAYWRIGHT pointing at a Playwright
// module and BGA_BROWSER at a Chromium executable when they aren't installed locally.
// Uses an isolated test page; never connects to DSH or writes the user's settings.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.BGA_PLAYWRIGHT ? pathToFileURL(process.env.BGA_PLAYWRIGHT).href : 'playwright')
const client = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true, ...(process.env.BGA_BROWSER ? { executablePath: process.env.BGA_BROWSER } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://bga.test/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/slow.svg') await new Promise(resolve=>setTimeout(resolve,2000))
    if (url.pathname.endsWith('.svg')) return route.fulfill({contentType:'image/svg+xml', body:`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960"><rect width="100%" height="100%" fill="${({'/a.svg':'#ff0000','/b.svg':'#00ff00','/c.svg':'#0000ff','/d.svg':'#ffffff'})[url.pathname] || '#000000'}"/></svg>`})
    if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body></body></html>'})
    return route.fulfill({contentType:'application/json',body:'{}'})
  })
  await page.goto('http://bga.test/')
  await page.evaluate(() => {
    window.__ModuleLoader__ = {load(m) { window.bgaModule = m }}
    window.fixtureReact = {createElement(){},memo:f=>f}
  })
  await page.addScriptTag({content:client})
  await page.evaluate(() => {
    window.bga = bgaModule.factory(() => fixtureReact)
    window.api = bga.internals
    Object.assign(api.STORE.state,{wallpaper:{url:'/a.svg'},fadeMs:600,fadeDelayMs:0,autoOn:false,veil:0})
    window.cleanups=[]; window.tokenWrites=0
    bga.apply({get:k=>k==='theme'?{overrideTokens(){tokenWrites++;return ()=>{}}}:undefined,
      effect(fn){const off=fn();if(off)cleanups.push(off)}})
    window.select = name => api.STORE.set({wallpaper:{url:'/'+name+'.svg'}})
    window.samples=[]; window.sampling=true
    const rgb={a:[1,0,0],b:[0,1,0],c:[0,0,1],d:[1,1,1]}
    const name=css=>(css.match(/\/([abcd])\.svg/)||[])[1]
    function record() {
      const front=getComputedStyle(document.body,'::after'), back=getComputedStyle(document.body,'::before')
      const a=front.content==='none'?0:Number(front.opacity), f=name(front.backgroundImage), b=name(back.backgroundImage)
      if(b) samples.push({t:performance.now(),a,f,b,rgb:rgb[b].map((v,i)=>v*(1-a)+(rgb[f]?.[i]||0)*a)})
      if(sampling) requestAnimationFrame(record)
    }
    requestAnimationFrame(record)
  })
  await page.waitForTimeout(80)
  const nodes = await page.evaluateHandle(() => [document.querySelector('[data-bg-atelier-background]'),document.querySelector('[data-bg-atelier-dynamic]')])
  await page.evaluate(() => select('b'))
  await page.waitForTimeout(180)
  await page.evaluate(() => { for(let i=0;i<40;i++) select(i%2?'d':'c') })
  assert.equal(await page.evaluate(() => api.renderedBgUrl()), '/b.svg', 'visible lower image must not change mid-fade')
  await page.waitForTimeout(1450)
  const report = await page.evaluate(original => {
    sampling=false
    let maxStep=0, jump=null
    for(let i=1;i<samples.length;i++) {
      const step=Math.max(...samples[i].rgb.map((v,c)=>Math.abs(v-samples[i-1].rgb[c])))
      if(step>maxStep) { maxStep=step;jump=[samples[i-1],samples[i]] }
    }
    return {frames:samples.length,maxStep,url:api.renderedBgUrl(),fades:document.querySelectorAll('[data-bg-atelier-fade]').length,
      sameNodes:original[0]===document.querySelector('[data-bg-atelier-background]')&&original[1]===document.querySelector('[data-bg-atelier-dynamic]'),tokenWrites,
      actualBack:getComputedStyle(document.body,'::before').backgroundImage,jump}
  },nodes)
  assert.equal(report.url,'/d.svg')
  assert.equal(report.fades,0)
  assert.equal(report.sameNodes,true)
  assert.equal(report.tokenWrites,1,'wallpaper-only changes must not recreate theme overrides')
  assert.ok(report.frames>30)
  assert.ok(report.maxStep<0.15,`visible blend jumped ${JSON.stringify(report)}`)
  assert.ok(report.actualBack.includes('/d.svg'))
  console.log('PASS real computed CSS / 40 rapid changes / persistent styles / theme tokens',JSON.stringify(report))

  // Block the main thread before the initial frame: the fade must still get its full duration.
  await page.evaluate(() => { select('a'); const t=performance.now();while(performance.now()-t<750){} })
  await page.waitForTimeout(140)
  const delayed = await page.evaluate(() => Number(getComputedStyle(document.body,'::after').opacity))
  assert.ok(delayed>0.05&&delayed<1,'delayed start should still be fading, not already removed')
  await page.waitForTimeout(800)
  assert.equal(await page.locator('[data-bg-atelier-fade]').count(),0)
  console.log('PASS 750 ms blocked main thread: fade starts afterwards',delayed)

  // Each layer keeps its own crop, including while newer selections are queued.
  await page.evaluate(()=>{
    api.STORE.set({fadeOn:false,imageFraming:{'/a.svg':{zoom:1.8,focus:'0% 0%'},'/b.svg':{zoom:1.2,focus:'100% 50%'},'/c.svg':{zoom:1.5,focus:'50% 100%'}}})
    select('a');api.STORE.set({fadeOn:true});select('b')
  })
  const geometry=()=>page.evaluate(()=>['::before','::after'].map(p=>{const s=getComputedStyle(document.body,p);return {image:s.backgroundImage,scale:Number((s.transform.match(/matrix\(([^,]+)/)||[])[1]),position:s.backgroundPosition}}))
  await page.waitForTimeout(100)
  let layers=await geometry()
  assert.equal(layers[0].scale,1.2);assert.equal(layers[1].scale,1.8)
  assert.ok(layers[0].position.includes('100% 50%'));assert.ok(layers[1].position.includes('0% 0%'))
  await page.evaluate(()=>{select('c');api.setImageFraming({zoom:2,focus:'100% 100%'});api.setPlaybackMode('ordered')})
  layers=await geometry()
  assert.equal(layers[0].scale,1.2,'queued image edits cannot change the fading-in lower layer')
  assert.equal(layers[1].scale,1.8,'old image retains its framing')
  await page.waitForFunction(()=>api.renderedBgUrl()==='/c.svg')
  layers=await geometry()
  assert.equal(layers[0].scale,2);assert.equal(layers[1].scale,1.2)
  assert.ok(layers[0].position.includes('100% 100%'))
  await page.waitForFunction(()=>!document.querySelector('[data-bg-atelier-fade]'))
  assert.equal((await geometry())[0].scale,2)
  console.log('PASS independent geometry for both fade layers / queued framing edits / final crop')

  await page.evaluate(() => { select('b'); select('c'); api.STORE.set({fadeOn:false}) })
  assert.equal(await page.locator('[data-bg-atelier-fade]').count(),0)
  assert.equal(await page.evaluate(() => api.renderedBgUrl()),'/c.svg')
  await page.evaluate(() => { api.STORE.set({fadeOn:true}); select('d'); api.STORE.set({wallpaper:null}) })
  assert.equal(await page.locator('[data-bg-atelier-fade]').count(),0)
  assert.equal(await page.evaluate(() => getComputedStyle(document.body,'::before').content),'none')
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.evaluate(() => { select('a'); select('b') })
  assert.equal(await page.locator('[data-bg-atelier-fade]').count(),0)
  // Real image loading beyond the old 1.5 s fallback must not expose an empty lower layer.
  await page.evaluate(() => api.setWallpaper({id:'slow',url:'/slow.svg'}))
  await page.waitForTimeout(1650)
  assert.equal(await page.evaluate(() => api.renderedBgUrl()),'/b.svg')
  await page.waitForFunction(() => api.renderedBgUrl()==='/slow.svg')
  await page.evaluate(() => {
    api.setWallpaper({id:'c',url:'/c.svg'})
    api.STORE.set({wallpaper:null})
  })
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => api.renderedBgUrl()),'')
  console.log('PASS slow image waits beyond 1.5 s; clearing cancels pending decode')

  await page.emulateMedia({reducedMotion:'no-preference'})
  await page.evaluate(async()=>{
    api.STORE.list=['a','b','c','d'].map(id=>({id,base:id,url:'/'+id+'.svg'}))
    await Promise.all(api.STORE.list.map(it=>{const img=new Image();img.src=it.url;return img.decode()}))
    api.STORE.set({fadeOn:false,wallpaper:{id:'a',name:'a',url:'/a.svg'},imageFraming:{},fadeMs:2800,fadeDelayMs:0})
    api.setPlaybackSource('all');api.setPlaybackMode('ordered');api.STORE.set({fadeOn:true})
    const button=document.createElement('button');button.id='manual-next';button.textContent='换一张';button.onclick=api.cycleWallpaper;document.body.append(button)
    window.clickMeasured=()=>{
      const before=Number(getComputedStyle(document.body,'::after').opacity)
      document.getElementById('manual-next').click()
      return {before,after:Number(getComputedStyle(document.body,'::after').opacity),motion:api.fadeMotionStatus()}
    }
    window.tempoSamples=[];window.tempoSampling=true
    const rgb={a:[1,0,0],b:[0,1,0],c:[0,0,1],d:[1,1,1]},name=css=>(css.match(/\/([abcd])\.svg/)||[])[1]
    function sample(){
      const front=getComputedStyle(document.body,'::after'),back=getComputedStyle(document.body,'::before')
      const a=front.content==='none'?0:Number(front.opacity),f=name(front.backgroundImage),b=name(back.backgroundImage)
      if(b)tempoSamples.push({t:performance.now(),a,f,b,rgb:rgb[b].map((v,i)=>v*(1-a)+(rgb[f]?.[i]||0)*a)})
      if(tempoSampling)requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.fadeMotionStatus()?.started)
  assert.equal(await page.evaluate(()=>api.fadeMotionStatus().duration),2800)
  const tempoLayer=await page.evaluateHandle(()=>document.querySelector('[data-bg-atelier-fade]'))
  await page.waitForTimeout(860)
  const medium=await page.evaluate(()=>clickMeasured())
  assert.equal(medium.motion.duration,1000)
  assert.ok(Math.abs(medium.before-medium.after)<0.005,'speed change must not jump opacity')
  assert.equal(await page.evaluate(el=>el===document.querySelector('[data-bg-atelier-fade]'),tempoLayer),true,'accelerate original transition without replacing the layer')
  await page.waitForTimeout(460)
  const fast=await page.evaluate(()=>clickMeasured())
  assert.equal(fast.motion.duration,500)
  assert.ok(Math.abs(fast.before-fast.after)<0.005)
  await page.waitForTimeout(150)
  const fastest=await page.evaluate(()=>clickMeasured())
  assert.equal(fastest.motion.duration,300)
  assert.ok(Math.abs(fastest.before-fastest.after)<0.005)
  await page.waitForFunction(()=>!api.wallpaperRequestPending()&&api.renderedBgUrl()===api.STORE.state.wallpaper.url&&!document.querySelector('[data-bg-atelier-fade]'),null,{timeout:1400})
  assert.equal(await page.evaluate(()=>api.STORE.state.wallpaper.id),'a','each next input advances the ordered selection')
  const tempoReport=await page.evaluate(()=>{
    tempoSampling=false
    let maxStep=0
    for(let i=1;i<tempoSamples.length;i++)maxStep=Math.max(maxStep,...tempoSamples[i].rgb.map((v,c)=>Math.abs(v-tempoSamples[i-1].rgb[c])))
    return {frames:tempoSamples.length,maxStep,final:api.renderedBgUrl(),setting:api.STORE.state.fadeMs}
  })
  assert.equal(tempoReport.setting,2800)
  assert.ok(tempoReport.maxStep<0.2,JSON.stringify(tempoReport))
  console.log('PASS real manual cadence 2800 → 1000 → 500 → 300 ms / original animation retained / no opacity reset',JSON.stringify(tempoReport))

  // Keep clicking longer than one fast fade; same-tier input must never extend it indefinitely.
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.fadeMotionStatus()?.started)
  const burstLayer=await page.evaluateHandle(()=>document.querySelector('[data-bg-atelier-fade]'))
  for(let i=0;i<45;i++){await page.evaluate(()=>document.getElementById('manual-next').click());await page.waitForTimeout(14)}
  assert.equal(await page.evaluate(el=>el.isConnected,burstLayer),false,'continuous clicks must allow the current transition to finish')
  await page.waitForFunction(()=>!api.wallpaperRequestPending()&&api.renderedBgUrl()===api.STORE.state.wallpaper.url&&!document.querySelector('[data-bg-atelier-fade]'),null,{timeout:1400})
  await page.evaluate(()=>{api.STORE.set({autoOn:true});api.autoTick()})
  await page.waitForFunction(()=>api.fadeMotionStatus()?.started)
  assert.equal(await page.evaluate(()=>api.fadeMotionStatus().duration),2800,'automatic transition cannot inherit manual fast mode')
  await page.evaluate(()=>api.STORE.set({fadeOn:false,autoOn:false}))
  await page.waitForTimeout(1600)
  await page.evaluate(()=>api.STORE.set({fadeOn:true,fadeDelayMs:800}))
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.fadeMotionStatus()!==null)
  assert.deepEqual(await page.evaluate(()=>api.fadeMotionStatus()),{duration:2800,started:false},'pause restores normal duration and delay')
  await page.waitForTimeout(100)
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.fadeMotionStatus()?.started,null,{timeout:500})
  assert.equal(await page.evaluate(()=>api.fadeMotionStatus().duration),300,'rapid second click skips waiting and accelerates')
  await page.waitForFunction(()=>!api.wallpaperRequestPending()&&!document.querySelector('[data-bg-atelier-fade]'),null,{timeout:1400})
  console.log('PASS sustained clicking still finishes / auto uses normal duration / pause restores duration & delay / rapid click bypasses wait')

  await page.evaluate(()=>{
    api.STORE.set({fadeOn:false,wallpaper:{id:'a',url:'/a.svg'},fadeDelayMs:0})
    api.setPlaybackSource('all');api.STORE.set({fadeOn:true})
    api.setWallpaper({id:'b',base:'b',url:'/b.svg'})
  })
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='b')
  await page.waitForTimeout(100)
  await page.evaluate(()=>api.setWallpaper({id:'slow',base:'slow',url:'/slow.svg?tempo=1'}))
  await page.waitForTimeout(1600)
  assert.equal(await page.evaluate(()=>api.STORE.state.wallpaper.id),'b','slow image must remain hidden until decoded')
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='slow')
  assert.equal(await page.evaluate(()=>api.fadeMotionStatus()?.duration),300,'decode time cannot change the click-time duration decision')
  await page.waitForFunction(()=>!document.querySelector('[data-bg-atelier-fade]'))
  console.log('PASS cadence is recorded at input, not after slow decode')

  await page.evaluate(()=>{
    Object.defineProperty(document.body,'getAnimations',{configurable:true,value:undefined})
    api.STORE.set({fadeOn:false,wallpaper:{id:'a',name:'a',url:'/a.svg'},fadeMs:1400})
    api.setPlaybackSource('all');api.STORE.set({fadeOn:true})
  })
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.fadeMotionStatus()?.started)
  await page.waitForTimeout(120)
  const fallback=await page.evaluate(()=>clickMeasured())
  assert.equal(fallback.motion.duration,300)
  assert.ok(Math.abs(fallback.before-fallback.after)<0.005,'fallback must preserve current blend on the speed-change frame')
  await page.waitForTimeout(80)
  assert.ok(await page.evaluate(alpha=>Number(getComputedStyle(document.body,'::after').opacity)<alpha,fallback.before),'fallback must continue fading after acceleration')
  await page.waitForFunction(()=>!api.wallpaperRequestPending()&&api.renderedBgUrl()===api.STORE.state.wallpaper.url&&!document.querySelector('[data-bg-atelier-fade]'),null,{timeout:1400})
  await page.evaluate(()=>delete document.body.getAnimations)
  console.log('PASS real CSS fallback preserves alpha and finishes when animation-rate API is unavailable')

  // Clock time advances ten minutes while the document is hidden. Pixel samples
  // come from actual Chromium screenshots, not from computed background URLs.
  async function pixel() {
    const png=await page.screenshot()
    return page.evaluate(async data=>{
      const img=new Image();img.src=data;await img.decode()
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0)
      return Array.from(ctx.getImageData(30,500,1,1).data).slice(0,3)
    },'data:image/png;base64,'+png.toString('base64'))
  }
  await page.clock.install()
  await page.evaluate(()=>{
    window.testHidden=false
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>testHidden})
    window.setHidden=value=>{testHidden=value;document.dispatchEvent(new Event('visibilitychange'))}
    api.STORE.set({fadeOn:false,wallpaper:{id:'a',url:'/a.svg'},autoOn:true,autoMin:1,fadeMs:400,fadeDelayMs:0,veil:0})
    api.setPlaybackSource('all');api.setPlaybackMode('ordered');api.STORE.set({fadeOn:true})
    window.hiddenCommits=0
    let last=api.STORE.state.wallpaper.url
    api.STORE.subscribe(()=>{if(last!==api.STORE.state.wallpaper.url){hiddenCommits++;last=api.STORE.state.wallpaper.url}})
    setHidden(true)
  })
  assert.equal(await page.evaluate(()=>api.autoPending()),false)
  await page.clock.runFor(600000)
  assert.equal(await page.evaluate(()=>hiddenCommits),0)
  await page.evaluate(()=>setHidden(false))
  await page.clock.runFor(59000)
  assert.deepEqual(await pixel(),[255,0,0],'resume must preserve the current picture, not expose black')
  assert.equal(await page.evaluate(()=>hiddenCommits),0,'no catch-up during the fresh interval')
  await page.clock.runFor(1000)
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='b')
  await page.waitForFunction(()=>!document.querySelector('[data-bg-atelier-fade]'))
  assert.deepEqual(await pixel(),[0,255,0])
  assert.equal(await page.evaluate(()=>hiddenCommits),1,'only one automatic change after a full new interval')
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='c'&&!document.querySelector('[data-bg-atelier-fade]'))
  assert.deepEqual(await pixel(),[0,0,255],'manual switch still paints after background recovery')
  console.log('PASS ten-minute hidden interval / zero catch-up / one full interval on return / screenshot pixels after auto and manual changes')

  await page.evaluate(()=>{
    api.STORE.set({autoOn:false,fadeMs:2000})
    api.setWallpaper({id:'slow',url:'/slow.svg?background=1'})
    setHidden(true);setHidden(false)
  })
  await page.waitForTimeout(2200)
  assert.equal(await page.evaluate(()=>api.STORE.state.wallpaper.id),'c','late hidden decode must be ignored')
  assert.deepEqual(await pixel(),[0,0,255])
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.fadeMotionStatus()?.started)
  await page.evaluate(()=>setHidden(true))
  assert.equal(await page.locator('[data-bg-atelier-fade]').count(),0)
  await page.evaluate(()=>setHidden(false))
  await page.waitForTimeout(80)
  assert.deepEqual(await pixel(),[255,255,255],'resume during a fade paints its decoded destination')
  await page.locator('#manual-next').click()
  await page.waitForFunction(()=>api.STORE.state.wallpaper.id==='a'&&!document.querySelector('[data-bg-atelier-fade]'))
  assert.deepEqual(await pixel(),[255,0,0])
  console.log('PASS late slow decode / suspend mid-fade / resumed screenshot / subsequent manual fade')
  await page.evaluate(() => cleanups.reverse().forEach(off=>off()))
  assert.equal(await page.locator('[data-bg-atelier-background],[data-bg-atelier-dynamic],[data-bg-atelier-fade]').count(),0)
  assert.deepEqual(errors,[])
  console.log('PASS disable / clear / reduced motion / unload cleanup / no page errors')
} finally { await browser.close() }
