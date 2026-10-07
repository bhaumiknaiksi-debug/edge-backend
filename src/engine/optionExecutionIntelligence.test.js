'use strict';
const assert=require('assert');
const {analyseCandles,ema,rsi}=require('./optionExecutionIntelligence');
const base=Date.parse('2026-10-07T03:45:00Z'),rows=[];
for(let i=0;i<30;i++){const p=100+i;rows.push([new Date(base+i*300000).toISOString(),p,p+2,p-1,p+1,100+i*4,0]);}
const x=analyseCandles(rows);
assert.equal(x.available,true);assert.equal(x.candleCount,30);assert.ok(x.ema.ema9>x.ema.ema21);assert.ok(x.rsi5>50);assert.equal(x.vwap.state,'ABOVE_VWAP');
assert.ok(ema([1,2,3,4,5,6,7,8,9],9));assert.equal(rsi([1,2,3,4,5,6],5),100);
console.log('optionExecutionIntelligence tests passed');
