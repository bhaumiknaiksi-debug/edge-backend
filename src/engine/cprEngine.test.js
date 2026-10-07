'use strict';
const assert=require('assert');
const {cprFromOhlc,buildCprContext}=require('./cprEngine');
const x=cprFromOhlc({high:110,low:90,close:100});
assert.equal(x.pivot,100);assert.equal(x.bc,100);assert.equal(x.tc,100);assert.equal(x.r1,110);assert.equal(x.s1,90);
const rows=[];
for(let i=0;i<35;i++){
  const d=new Date('2026-08-10T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);
  if([0,6].includes(d.getUTCDay()))continue;
  const p=22000+i*10;
  rows.push({timestamp:d.toISOString(),high:p+100+(i%4)*10,low:p-80,close:p+20});
}
const out=buildCprContext({historicalDaily:rows,todayIso:'2026-09-28',spot:22400});
assert.equal(out.version,'CPR_CONTEXT_V1');assert.ok(out.daily);assert.ok(out.weekly);assert.ok(['ADAPTIVE_NARROW','ADAPTIVE_NORMAL','ADAPTIVE_WIDE','UNCLASSIFIED'].includes(out.daily.widthClass));
console.log('cprEngine tests passed');
