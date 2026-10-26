'use strict';

const assert=require('node:assert/strict');
const {buildTelegram,telegramConfig}=require('./edgeTelegram');
const {TelegramError}=require('./telegramTransport');
const {fakeTelegramPool,decision,testEnv}=require('./telegramTestHelpers');

function setup({env=testEnv,shared,bootId='boot',failure=null,chatType='private',recipientId=testEnv.EDGE_TELEGRAM_CHAT_ID,initializationGate=null}={}) {
  const {fake,pool}=shared||fakeTelegramPool();
  let time=Date.parse('2026-10-26T05:00:00Z'),current=null,phase='OPEN',sendFailure=failure;
  const calls=[];
  const api=async(method,parameters)=>{
    calls.push({method,parameters});
    if(method==='getChat'){if(initializationGate)await initializationGate;return {id:Number(recipientId),type:chatType};}
    assert(fake.commits>0);
    assert([...fake.outbox.values()].some(item=>item.status==='SENDING'&&fake.events.has(item.id)),
      'a send may only follow committed evidence and an outbox claim');
    if(sendFailure)throw sendFailure;
    return {message_id:calls.length,chat:{type:'private',id:Number(testEnv.EDGE_TELEGRAM_CHAT_ID)}};
  };
  const manager=buildTelegram({pool,env,getMarketPhase:()=>phase,getCurrentResult:()=>current,
    dependencies:{api,now:()=>time,bootId}});
  return {fake,pool,manager,calls,now:()=>time,advance:ms=>{time+=ms;},setPhase:value=>{phase=value;},
    setCurrent:value=>{current=value;},setFailure:value=>{sendFailure=value;},
    poll:async(ready=false,contract)=>{current=decision(time,ready,contract);return manager.onSuccessfulPoll(current);}};
}

(async()=>{
  assert.equal(telegramConfig({},true).reason,'DISABLED');
  assert.equal(telegramConfig(testEnv,false).reason,'DURABLE_STORAGE_REQUIRED');
  for(const id of ['-100123456','@public_channel','0','123456789999999999999'])assert.equal(telegramConfig({...testEnv,EDGE_TELEGRAM_CHAT_ID:id},true).reason,'CONFIGURATION_REQUIRED');
  const disabled=setup({env:{}});
  disabled.manager.start();
  await disabled.poll(true);await disabled.manager.tick();
  assert.equal(disabled.calls.length,0);assert.equal(disabled.fake.queries.length,0);
  assert.equal(disabled.manager.status().sendOnly,true);
  disabled.manager.stop();
  for(const options of [{chatType:'group'},{recipientId:'987654321'}]) {
    const wrong=setup(options);
    assert.equal(await wrong.manager.initialize(),false);
    assert.equal(wrong.fake.queries.length,0,'no database setup or sends for an unconfirmed private target');
    assert.equal(wrong.manager.status().reason,'PRIVATE_RECIPIENT_NOT_CONFIRMED');
  }

  const h=setup();
  const source=decision(h.now(),false),original=JSON.stringify(source);
  h.setCurrent(source);await h.manager.onSuccessfulPoll(source);
  assert.equal(JSON.stringify(source),original);
  h.advance(10000);await h.poll(true);
  assert.equal(h.fake.events.size,1);
  assert.equal(h.calls.filter(call=>call.method==='sendMessage').length,0,'recording does not send or block on delivery');
  await h.manager.tick();
  assert.equal(h.calls.filter(call=>call.method==='sendMessage').length,1);
  assert.equal([...h.fake.outbox.values()][0].status,'SENT');
  const sent=h.calls.find(call=>call.method==='sendMessage').parameters;
  assert.equal(sent.chat_id,testEnv.EDGE_TELEGRAM_CHAT_ID);
  assert.equal(sent.protect_content,true);assert.equal(sent.parse_mode,undefined);assert.equal(sent.reply_markup,undefined);
  assert(!JSON.stringify(h.manager.status()).includes(testEnv.EDGE_TELEGRAM_BOT_TOKEN));
  assert(!JSON.stringify(h.manager.status()).includes(testEnv.EDGE_TELEGRAM_CHAT_ID));
  h.advance(10000);await h.poll(true);await h.manager.tick();
  assert.equal(h.calls.filter(call=>call.method==='sendMessage').length,1,'same READY episode cannot repeat');
  h.advance(10000);await h.poll(false);await h.manager.tick();
  assert.equal(h.calls.filter(call=>call.method==='sendMessage').length,2);
  assert(h.calls.at(-1).parameters.text.includes('Previous ready state ended'));

  // Ledger changes and failed market polls can clear current analysis immediately.
  const veto=setup();await veto.poll();veto.advance(10000);await veto.poll(true);veto.setCurrent(null);
  await veto.manager.tick();
  assert.equal(veto.calls.filter(call=>call.method==='sendMessage').length,0);
  assert.equal([...veto.fake.outbox.values()][0].status,'EXPIRED');
  const closed=setup();await closed.poll();closed.advance(10000);await closed.poll(true);closed.setPhase('CLOSED');
  await closed.manager.tick();
  assert(!closed.calls.some(call=>call.method==='sendMessage'&&call.parameters.text.includes('Backend-confirmed readiness')),
    'market close may notify invalidation but must never deliver a queued READY');
  const expired=setup();await expired.poll();expired.advance(10000);await expired.poll(true);expired.advance(46000);
  await expired.manager.tick();
  assert.equal([...expired.fake.outbox.values()][0].status,'EXPIRED');

  const rate=setup({failure:new TelegramError('TELEGRAM_RATE_LIMIT',{retryAfterMs:5000})});
  await rate.poll();rate.advance(10000);await rate.poll(true);await rate.manager.tick();
  assert.equal([...rate.fake.outbox.values()][0].status,'PENDING');
  rate.setFailure(null);rate.advance(5000);await rate.manager.tick();
  assert.equal([...rate.fake.outbox.values()][0].status,'SENT');
  assert.equal(rate.manager.status().processCounters.apiAccepted,1);
  for(const exhausted of [false,true]) {
    const flood=setup({failure:new TelegramError('TELEGRAM_RATE_LIMIT',{retryAfterMs:60000})});
    await flood.poll();flood.advance(10000);await flood.poll(true);
    if(exhausted)[...flood.fake.outbox.values()][0].attempts=3;
    await flood.manager.tick();
    assert.equal([...flood.fake.outbox.values()][0].status,exhausted?'FAILED':'PENDING');
    flood.advance(10000);await flood.poll(false);await flood.manager.tick();
    assert.equal(flood.calls.filter(call=>call.method==='sendMessage').length,1,
      'a second queued event must honor recipient cooldown, including exhausted retries');
    flood.setFailure(null);flood.advance(50000);await flood.manager.tick();
    flood.advance(5000);await flood.manager.tick();
    const delivered=flood.calls.filter(call=>call.method==='sendMessage');
    assert.equal(delivered.length,2);
    assert(delivered[1].parameters.text.includes('Previous ready state ended'));
    if(!exhausted)assert.equal([...flood.fake.outbox.values()][0].status,'EXPIRED',
      'cooldown must not bypass the original READY expiry');
  }
  const uncertain=setup({failure:new Error('secret-token-must-not-leak')});
  await uncertain.poll();uncertain.advance(10000);await uncertain.poll(true);await uncertain.manager.tick();
  assert.equal([...uncertain.fake.outbox.values()][0].status,'UNCERTAIN');
  uncertain.advance(10000);await uncertain.manager.tick();
  assert.equal(uncertain.calls.filter(call=>call.method==='sendMessage').length,1,'ambiguous send must not be blindly retried');
  assert(!JSON.stringify(uncertain.manager.status()).includes('secret-token'));

  const storage=setup();await storage.poll();storage.fake.failMatch='INSERT INTO edge_telegram_outbox_v1';
  storage.advance(10000);await storage.poll(true);await storage.manager.tick();
  assert.equal(storage.calls.filter(call=>call.method==='sendMessage').length,0);
  assert.equal(storage.fake.events.size,0);
  storage.fake.failMatch=null;storage.advance(10000);await storage.poll(true);await storage.manager.tick();
  assert.equal(storage.fake.events.size,0,'store recovery is a new baseline, not a retroactive READY');
  storage.advance(10000);await storage.poll(false);storage.advance(10000);await storage.poll(true);await storage.manager.tick();
  assert(storage.calls.some(call=>call.method==='sendMessage'));

  const interrupted=setup();await interrupted.poll();interrupted.advance(10000);await interrupted.poll(true);
  interrupted.fake.failMatch='SET status=$3';await interrupted.manager.tick();
  assert.equal([...interrupted.fake.outbox.values()][0].status,'SENDING');
  interrupted.fake.failMatch=null;interrupted.advance(16000);await interrupted.manager.tick();
  assert.equal([...interrupted.fake.outbox.values()][0].status,'UNCERTAIN');
  assert.equal(interrupted.calls.filter(call=>call.method==='sendMessage').length,1,'lost ACK must not duplicate a send');

  // A new process must not replay a still-fresh READY from an old process's queue.
  const old=setup();await old.poll();old.advance(10000);await old.poll(true);
  const restart=setup({shared:{fake:old.fake,pool:old.pool},bootId:'new-process'});
  restart.advance(20000);await restart.poll(true);await restart.manager.tick();
  assert.equal(restart.calls.filter(call=>call.method==='sendMessage').length,0);
  assert.equal([...restart.fake.outbox.values()][0].status,'EXPIRED');

  let release;
  const initializationGate=new Promise(resolve=>{release=resolve;});
  const bounded=setup({initializationGate});
  const first=bounded.poll(false);
  bounded.advance(1000);const second=bounded.poll(true);
  bounded.advance(1000);const third=bounded.poll(false);
  bounded.advance(1000);const fourth=bounded.poll(true);
  release();await Promise.all([first,second,third,fourth]);
  assert.equal(bounded.manager.status().processCounters.coalesced,2);
  assert.equal(bounded.fake.events.size,0,'a coalesced gap cannot manufacture a READY transition');
  assert.equal(bounded.manager.status().processCounters.observations,2,'pending queue is bounded to the latest observation');

  const endOfDay=setup();await endOfDay.poll(false);
  endOfDay.advance(Date.parse('2026-10-26T10:15:00Z')-endOfDay.now());endOfDay.setPhase('CLOSED');
  await endOfDay.manager.tick();
  assert.equal(endOfDay.calls.filter(call=>call.method==='sendMessage').length,1);
  assert(endOfDay.calls.at(-1).parameters.text.includes('Coverage UNKNOWN'));
  assert(endOfDay.calls.at(-1).parameters.text.includes('2026-10-26'));
  endOfDay.advance(10000);await endOfDay.manager.tick();
  assert.equal(endOfDay.calls.filter(call=>call.method==='sendMessage').length,1,'daily summary is not duplicated');

  const routes=[];h.manager.routes({get:(route,handler)=>routes.push({route,handler})});
  assert.deepEqual(routes.map(item=>item.route),['/api/v1/telegram/status']);
  assert.equal(h.manager.status().liveDecisionImpact,false);
  console.log('Telegram manager PASS: disabled isolation, private recipient, persisted-before-send, gate recheck, TTL, retries, outages, ambiguity and restart safety');
})().catch(error=>{console.error(error);process.exitCode=1;});
