'use strict';
const assert=require('assert/strict');const {apply,budget}=require('./ledger');const {buildPositionPlan}=require('../engine/positionSizingEngine');
const now=new Date('2026-10-14T05:00:00Z');
// Control-page limits as passed in production; the original ceilings keep the historical assertions comparable.
const L={capital:10000,dailyLoss:1000,perTradeRisk:1000};let s={trades:[],confirmedDay:null,lockedDays:[],operations:[]};
assert.equal(budget(s,now,L).confirmed,false);
s=apply(s,'confirm',{requestId:'confirm_0000000001',reconciled:true},now,L);assert.equal(budget(s,now,L).confirmed,true);
const open={requestId:'trade_000000000001',contract:'NIFTY 19 OCT 22500 CE',strategy:'LONG_CALL',quantity:65,entry:100,stop:90,estimatedCosts:100};
s=apply(s,'open',open,now,L);assert.equal(budget(s,now,L).availableRisk,250);assert.equal(budget(s,now,L).availableCapital,3400);
assert.equal(apply(s,'open',open,now,L).trades.length,1);
assert.throws(()=>apply(s,'open',{...open,requestId:'trade_000000000002',entry:null},now,L));
s=apply(s,'close',{requestId:'close_000000000001',tradeId:open.requestId,exit:92,charges:80},now,L);assert.equal(budget(s,now,L).netRealizedPnl,-600);assert.equal(budget(s,now,L).availableRisk,400);
assert.throws(()=>apply(s,'close',{requestId:'close_000000000002',tradeId:open.requestId,exit:100,charges:0},now,L));
s=apply(s,'open',{...open,requestId:'trade_000000000002'},now,L);
s=apply(s,'close',{requestId:'close_000000000003',tradeId:'trade_000000000002',exit:90,charges:0},now,L);assert.equal(budget(s,now,L).locked,true);
s=apply(s,'open',{...open,requestId:'trade_000000000003'},now,L);
s=apply(s,'close',{requestId:'close_000000000004',tradeId:'trade_000000000003',exit:150,charges:0},now,L);assert.equal(budget(s,now,L).locked,true); // gains cannot unlock a breached daily limit
assert.equal(budget(s,new Date('2026-10-15T03:44:00Z'),L).locked,true);
assert.equal(budget(s,new Date('2026-10-15T03:45:00Z'),L).locked,false);assert.equal(budget(s,new Date('2026-10-15T03:45:00Z'),L).confirmed,false);
const fresh={confirmed:true,availableRisk:1000,availableCapital:10000,checkedAt:new Date().toISOString()};
const args={strategy:'LONG_CALL',tradeLegs:{lotSize:65,buyLeg:{ask:100}},risk:{status:'READY',entryPremium:100,stop:{value:90}},marketPhase:'OPEN',budget:fresh};
assert.equal(buildPositionPlan(args).recommendedLots,1);
assert.equal(buildPositionPlan({...args,budget:{...fresh,availableRisk:700}}).status,'BLOCKED');
assert.equal(buildPositionPlan({...args,budget:{...fresh,availableCapital:6000}}).status,'BLOCKED');
assert.equal(buildPositionPlan({...args,budget:{...fresh,confirmed:false}}).status,'BLOCKED');
assert.equal(buildPositionPlan({...args,budget:{...fresh,checkedAt:'2020-01-01'}}).status,'BLOCKED');
assert.equal(buildPositionPlan({...args,strategy:'BULL_PUT_SPREAD'}).status,'BLOCKED');
const carried={trades:[{closedAt:'2026-10-13T08:00:00Z',netPnl:-500}],confirmedDay:null,lockedDays:[],operations:[]};
assert.equal(budget(carried,now,L).availableCapital,9500);
assert.equal(budget(carried,now,L).availableRisk,1000);
assert.equal(buildPositionPlan({...args,tradeLegs:{lotSize:65,buyLeg:{ask:110}}}).status,'BLOCKED');
// --- control-page limits drive the budget: no hard-coded ceiling, and no limits means no sizing ---
{
  const mine={capital:10000,dailyLoss:600,perTradeRisk:450};
  let m={trades:[],confirmedDay:null,lockedDays:[],operations:[]};
  m=apply(m,'confirm',{requestId:'confirm_0000000009',reconciled:true},now,mine);
  const b=budget(m,now,mine);
  assert.equal(b.availableRisk,450,'per-trade risk from the control page');
  assert.equal(b.dailyLossLimit,600);assert.equal(b.perTradeLimit,450);assert.equal(b.limitsSource,'CONTROL_PAGE');
  m=apply(m,'open',{...open,requestId:'trade_000000000009',entry:100,stop:96,estimatedCosts:40},now,mine);
  m=apply(m,'close',{requestId:'close_000000000009',tradeId:'trade_000000000009',exit:96,charges:40},now,mine);
  assert.equal(budget(m,now,mine).availableRisk,300,'600 daily loss minus 300 lost, below the 450 per-trade cap');
  m=apply(m,'open',{...open,requestId:'trade_000000000010',entry:100,stop:96,estimatedCosts:40},now,mine);
  m=apply(m,'close',{requestId:'close_000000000010',tradeId:'trade_000000000010',exit:96,charges:40},now,mine);
  assert.equal(budget(m,now,mine).locked,true,'600 lost reaches the 600 daily loss: locked');
  assert.ok(m.lockedDays.length===1,'the lock is persisted with control-page limits');
  // above the old ₹1,000 ceiling is honoured too (validation of the values themselves is the control page's job)
  assert.equal(budget({trades:[],confirmedDay:null,lockedDays:[],operations:[]},now,{capital:20000,dailyLoss:3000,perTradeRisk:1500}).availableRisk,1500);
  for(const bad of [undefined,null,{},{capital:10000,dailyLoss:600},{capital:10000,dailyLoss:400,perTradeRisk:450},{capital:-1,dailyLoss:600,perTradeRisk:450}]){
    const x=budget(m,now,bad);
    assert.equal(x.error,'LIMITS_UNAVAILABLE',JSON.stringify(bad));assert.equal(x.availableRisk,0);assert.equal(x.availableCapital,0);
    assert.equal(buildPositionPlan({...args,budget:{...x,confirmed:true,checkedAt:new Date().toISOString()}}).reason,'Risk limits from the control page are unavailable.');
  }
  // sizing uses the ledger's figure directly: ₹1,400 available now fits a lot the old ₹1,000 cap refused
  const wide={...args,risk:{...args.risk,stop:{value:80}}}; // 20 pts * 65 + 100 = 1,400 per lot
  assert.equal(buildPositionPlan({...wide,budget:{...fresh,availableRisk:1400}}).recommendedLots,1);
  assert.equal(buildPositionPlan({...wide,budget:{...fresh,availableRisk:450}}).status,'BLOCKED');
}
console.log('Ledger risk: charges, reservations, idempotency, loss latch, session rollover and capital gates PASS');
