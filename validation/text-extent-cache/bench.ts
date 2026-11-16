import {measureWholeTextCached, invalidateTextExtentCache} from '../../src/worker/modules/gdi32/text-extent-cache';
const texts=Array.from({length:64},(_,i)=>['Settings','日本語 text','Office ffi AV','Load saved progress'][i%4]+' '+i);
const fonts=['14px Arial','16px serif','12px monospace','18px sans-serif'];
const n=100000;
const rows:any[]=[];
function run(cached:boolean,round:number) {
 invalidateTextExtentCache();let measurements=0,checksum=0,consumed=0;
 const contexts=fonts.map(font=>{const c=new OffscreenCanvas(64,64).getContext('2d')!;c.font=font;c.textBaseline='top';return {font,textBaseline:'top',measureText:(s:string)=>{measurements++;return c.measureText(s);}};});
 const expected=texts.map((t,i)=>{const m=contexts[i%4].measureText(t);return Math.round(m.width)+Math.ceil(m.fontBoundingBoxAscent+m.fontBoundingBoxDescent);});
 let oracle=0;for(let i=0;i<n;i++)oracle+=expected[i%64];measurements=0;
 const start=performance.now();
 for(let i=0;i<n;i++) {
  const ctx=contexts[i%4],text=texts[i%64];
  if(cached){const m=measureWholeTextCached(ctx,text)!;checksum+=m.width+m.height;}
  else {const m=ctx.measureText(text);checksum+=Math.round(m.width)+Math.ceil(m.fontBoundingBoxAscent+m.fontBoundingBoxDescent);}
  consumed++;
 }
 const ms=performance.now()-start;
 if(checksum!==oracle||consumed!==n)throw Error('workload or result mismatch');
 rows.push({round,cached,ms,measurements,checksum,consumed,oracle});
}
for(let round=0;round<12;round++){run(round%2===0,round);run(round%2!==0,round);}
const result={userAgent:navigator.userAgent,fonts,texts,n,rows,scope:'Canvas microbenchmark only; no guest/game performance claim'};
document.querySelector('pre')!.textContent=JSON.stringify(result);
