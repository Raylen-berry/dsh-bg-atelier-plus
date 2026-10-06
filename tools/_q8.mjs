import { readFileSync } from 'node:fs'
import { decodePng, comparePixels } from '../../dsh-browser-live/pixdiff.js'
const d='baselines/before-refactor/'
const a=decodePng(readFileSync(d+'03-settings-studio.png'))
const b=decodePng(readFileSync(d+'03-settings-studio.after.png'))
const keep=Math.floor(a.height*0.80), x0=340, x1=1300
const crop=p=>{const w=x1-x0,o=Buffer.alloc(w*keep*4)
  for(let y=0;y<keep;y++) p.data.copy(o,y*w*4,(y*p.width+x0)*4,(y*p.width+x0)*4+w*4)
  return {width:w,height:keep,channels:4,data:o}}
const r=comparePixels(crop(a),crop(b))
console.log('  裁剪区差异: '+r.diff+'/'+r.total+' ('+(r.ratio*100).toFixed(3)+'%)')
const rows={}
for(let y=0;y<keep;y++)for(let x=0;x<960;x++){const o=(y*960+x)*4
  if(crop(a).data[o]!==crop(b).data[o]) rows[Math.floor(y/40)]=(rows[Math.floor(y/40)]||0)+1}
console.log('  按 y:'); for(const k of Object.keys(rows).sort((p,q)=>p-q)) console.log('    y'+(k*40)+'-'+(k*40+39)+': '+rows[k])
