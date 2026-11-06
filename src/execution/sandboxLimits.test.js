'use strict';
// The paper trader's control-page policy is shared with the signal engine's sizing (one set of limits).
const assert=require('node:assert/strict');
const {createSandboxService}=require('./sandboxService');
const {configurePolicy}=require('./sandboxEngine');
const {memoryStore}=require('./sandboxTestHelpers');
const BASE=Date.parse('2026-10-28T10:00:00+05:30');
(async()=>{
  let now=BASE;
  const store=memoryStore();
  const broker={async getOrders(){return [];},async getPositions(){return [];},async placeOrder(){throw Error('no orders');},async cancel(){throw Error('no orders');}};
  const service=createSandboxService({ownerToken:'sandbox-owner-test-token',getContext:()=>({analysis:null}),
    env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'data-token'},dependencies:{store,broker,now:()=>now,bootId:'one',idleTickMs:0}});
  assert.equal(service.limits(),null,'nothing known before the first tick: sizing fails closed');
  await service.tick();
  assert.deepEqual(service.limits(),{capital:10000,dailyLoss:500,perTradeRisk:250,source:'CONTROL_PAGE',observedAt:new Date(BASE).toISOString()});
  // the owner changes the policy on the control page; the next tick carries it to the signal engine
  await store.mutate(s=>configurePolicy(s,{requestId:'policy-change-0000001',dailyGoal:1000,dailyLoss:600,perTradeRisk:450},now));
  now+=2000;await service.tick();
  assert.equal(service.limits().perTradeRisk,450);assert.equal(service.limits().dailyLoss,600);
  // ticks stop (store unreadable, service stopped...): limits expire after 5 minutes instead of being trusted forever
  now+=5*60000;assert.equal(service.limits().perTradeRisk,450,'still fresh at exactly 5 minutes');
  now+=1;assert.equal(service.limits(),null,'stale limits are unavailable');
  // idle ticks (disarmed and flat) only read state; they must refresh the shared limits too
  {
    let t=BASE;const st=memoryStore();
    const idle=createSandboxService({ownerToken:'sandbox-owner-test-token',getContext:()=>({analysis:null}),
      env:{EDGE_SANDBOX_EXECUTION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'data-token'},dependencies:{store:st,broker,now:()=>t,bootId:'one',idleTickMs:60000}});
    await idle.tick();
    await st.mutate(s=>configurePolicy(s,{requestId:'policy-change-0000002',dailyGoal:1000,dailyLoss:800,perTradeRisk:400},t));
    t+=2000;await idle.tick();
    assert.equal(idle.limits().perTradeRisk,400);assert.equal(idle.limits().observedAt,new Date(t).toISOString(),'refreshed by the idle read');
  }
  console.log('Sandbox limits PASS: control-page policy shared after each tick, policy changes carried over, unknown or stale limits unavailable');
})().catch(e=>{console.error(e);process.exit(1);});
