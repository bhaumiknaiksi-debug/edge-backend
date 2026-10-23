'use strict';
const { createHash } = require('node:crypto');
const VERSION='SHADOW_EVENTS_V1';
const FIVE=300000, GAP=90000;
const clone=x=>JSON.parse(JSON.stringify(x));
const valid=n=>typeof n==='number'&&Number.isFinite(n);
const day=t=>new Date(t+19800000).toISOString().slice(0,10);
const iso=t=>new Date(t).toISOString();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const SCHEMA=`CREATE TABLE IF NOT EXISTS edge_shadow_cursor_v1 (
 id text PRIMARY KEY CHECK(id='nifty'), payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS edge_shadow_events_v1 (
 id text PRIMARY KEY, detected_at timestamptz NOT NULL, complete boolean NOT NULL DEFAULT false, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS edge_shadow_events_pending_v1 ON edge_shadow_events_v1(complete,detected_at);`;

function quotesFromChain(chain) {
  const quotes={};
  for(const row of chain||[]) for(const key of ['call_options','put_options']) {
    const leg=row[key], q=leg?.market_data;
    if(leg?.instrument_key && valid(q?.bid_price)&&valid(q?.ask_price)&&q.bid_price>0&&q.ask_price>=q.bid_price)
      quotes[leg.instrument_key]={bid:q.bid_price,ask:q.ask_price};
  }
  return quotes;
}
function legsOf(plan) {
  if(!plan?.available || !['LONG_CALL','LONG_PUT','BULL_CALL_SPREAD','BEAR_PUT_SPREAD'].includes(plan.strategy))return null;
  const legs=[{side:'BUY',...plan.legs?.buyLeg}];
  if(plan.strategy.endsWith('SPREAD'))legs.push({side:'SELL',...plan.legs?.sellLeg});
  if(legs.some(l=>!l.instrumentKey))return null;
  return legs.map(l=>({side:l.side,instrumentKey:l.instrumentKey,contractId:l.contractId||null,strike:l.strike,type:l.type}));
}
function mark(legs,quotes,entry=false) {
  if(!legs?.length||legs.some(l=>!quotes[l.instrumentKey]))return null;
  return Number(legs.reduce((v,l)=>{const q=quotes[l.instrumentKey];return v+(l.side==='BUY'?(entry?q.ask:q.bid):-(entry?q.bid:q.ask));},0).toFixed(4));
}
function contractKey(plan){const legs=legsOf(plan);return legs?hash([plan.strategy,legs.map(l=>[l.side,l.instrumentKey])]):null;}
function freshSource(source,now){return source?.available&&source.session===day(now)&&valid(source.latest?.time)&&
  source.latest.time+FIVE<=now&&now-source.latest.time-FIVE<=FIVE+GAP;}

// Pure transition for deterministic replay. Existing persisted state is never mutated.
function advance({cursor=null,events=[],source,now,candidates,quotes={},quotesAt=now,marketPhase='OPEN',ruleSpec=null}) {
  const active=clone(events), nextCursor=cursor?clone(cursor):null;
  let next=nextCursor, created=null;
  if(next?.lastPollAt>=now)return {cursor:next,events:active};
  const fresh=freshSource(source,now)&&marketPhase==='OPEN';
  const quoteCoverage=marketPhase==='OPEN'&&valid(quotesAt)&&quotesAt<=now&&now-quotesAt<=GAP;
  const usableQuotes=quoteCoverage?quotes:{};
  if(fresh) {
    const c=source.latest;
    const comparable=next && next.session===source.session && next.high===source.high&&next.low===source.low&&next.completedAt===source.completedAt;
    const consecutive=comparable&&c.time===next.time+FIVE&&source.previous?.time===next.time&&source.previous.close===next.close;
    const observedContinuously=consecutive&&now-next.observedAt<=GAP;
    let direction=null, level=null;
    if(observedContinuously&&next.close<=source.high&&c.close>source.high){direction='BULLISH';level=source.high;}
    if(observedContinuously&&next.close>=source.low&&c.close<source.low){direction='BEARISH';level=source.low;}
    if(direction) {
      const crossedAt=iso(c.time+FIVE);
      const id=hash([VERSION,source.session,source.completedAt,source.high,source.low,direction,crossedAt]);
      if(!active.some(e=>e.id===id)) {
        const end=Math.min(now+30*60000,Date.parse(source.session+'T15:30:00+05:30'));
        created={id,version:VERSION,ruleSpec:ruleSpec?clone(ruleSpec):null,session:source.session,direction,level,anchor:{high:source.high,low:source.low,completedAt:source.completedAt,source:source.source},
          crossedAt,detectedAt:iso(now),expiresAt:iso(end),status:'CONFIRMED',lastCandleTime:c.time,lastCandleClose:c.close,
          lastObservedAt:now,coverageGaps:[],gapCount:0,complete:false,contracts:[]};
        for(const tier of ['A','B','C']) {
          const plan=candidates?.plans?.[tier], legs=legsOf(plan);
          if(!legs || (direction==='BULLISH')!==plan.strategy.includes('CALL'))continue;
          const entry=mark(legs,usableQuotes,true);
          created.contracts.push({tier,strategy:plan.strategy,key:contractKey(plan),legs,
            entryMark:entry!==null&&entry>0?entry:null,entryObservedAt:iso(now),entryQuoteReceivedAt:quoteCoverage?iso(quotesAt):null,entryBasis:'BUY_ASK_MINUS_SELL_BID',
            replacedAt:null,samples:[],missingQuotes:0,horizons:{},sampledMfePoints:null,sampledMaePoints:null});
        }
        active.push(created);
      }
    }
    if(!next || next.session!==source.session || c.time>=next.time) next={session:source.session,high:source.high,low:source.low,completedAt:source.completedAt,
      time:c.time,close:c.close,observedAt:now,lastPollAt:now};
  } else if(next) {next.observedAt=null;next.lastPollAt=now;} // Break observed continuity; do not erase event identities.

  for(const event of active) {
    if(event.complete)continue;
    if(now<=event.lastObservedAt && event!==created)continue;
    const end=Date.parse(event.expiresAt), detected=Date.parse(event.detectedAt);
    const elapsed=now-detected;
    const gap=now-event.lastObservedAt>GAP;
    if(gap){event.gapCount++;if(event.coverageGaps.length<64)event.coverageGaps.push({from:iso(event.lastObservedAt),to:iso(now),reason:'POLL_GAP'});}
    const sameSession=fresh&&event.session===source.session&&source.latest.time+FIVE<=end;
    if(sameSession&&event.status==='CONFIRMED') {
      if(source.high!==event.anchor.high||source.low!==event.anchor.low||source.completedAt!==event.anchor.completedAt) {
        event.status='UNKNOWN';event.statusReason='ANCHOR_REVISED';
      } else if(source.latest.time>event.lastCandleTime) {
        const consecutive=source.latest.time===event.lastCandleTime+FIVE&&source.previous?.time===event.lastCandleTime&&source.previous.close===event.lastCandleClose;
        if(!consecutive||gap){event.status='UNKNOWN';event.statusReason='CANDLE_COVERAGE_GAP';}
        else if((event.direction==='BULLISH'&&source.latest.close<=event.level)||(event.direction==='BEARISH'&&source.latest.close>=event.level)) {
          event.status='INVALIDATED';event.invalidatedAt=iso(source.latest.time+FIVE);event.statusReason='COMPLETED_CLOSE_BACK_THROUGH_LEVEL';
        }
        event.lastCandleTime=source.latest.time;event.lastCandleClose=source.latest.close;
      } else if(source.latest.time===event.lastCandleTime&&source.latest.close!==event.lastCandleClose) {
        event.status='UNKNOWN';event.statusReason='CANDLE_REVISED';
      }
    } else if(!sameSession&&event.status==='CONFIRMED') {event.status='UNKNOWN';event.statusReason='CANDLE_COVERAGE_GAP';}
    for(const observation of event.contracts) {
      if(!observation.replacedAt && contractKey(candidates?.plans?.[observation.tier])!==observation.key)observation.replacedAt=iso(now);
      // Observations after expiry can only fill a due horizon within 90 seconds,
      // never add later-session prices or silently reconstruct a missing entry.
      const inWindow=now<=end+GAP&&day(now)===event.session;
      const exit=inWindow?mark(observation.legs,usableQuotes):null;
      const points=exit!==null&&observation.entryMark!==null?Number((exit-observation.entryMark).toFixed(4)):null;
      if(now<=end) {
        if(exit===null)observation.missingQuotes++;
        if(observation.samples.length<120)observation.samples.push({at:iso(now),quoteReceivedAt:quoteCoverage?iso(quotesAt):null,exitMark:exit,points});
        if(points!==null){observation.sampledMfePoints=Math.max(observation.sampledMfePoints??0,points);observation.sampledMaePoints=Math.min(observation.sampledMaePoints??0,points);}
      }
      for(const minutes of [5,15,30]) {
        if(observation.horizons[minutes])continue;
        const due=detected+minutes*60000;
        if(now<due&&now<end)continue;
        const known=due<=end&&now>=due&&now-due<=GAP&&points!==null;
        observation.horizons[minutes]={status:known?'OBSERVED':'UNKNOWN',dueAt:iso(due),observedAt:known?iso(now):null,
          exitMark:known?exit:null,points:known?points:null,
          reason:known?null:due>end?'SESSION_ENDED':now-due>GAP?'HORIZON_MISSED':'QUOTE_OR_ENTRY_UNAVAILABLE'};
      }
    }
    event.lastObservedAt=now;
    if(now>=end) {event.complete=true;event.statusAtExpiry=event.status;if(event.status==='CONFIRMED')event.status='EXPIRED';}
  }
  return {cursor:next,events:active};
}

function report(event) {
  return {...event,researchOnly:true,executionAllowed:false,liveDecisionImpact:false,
    measurement:'Sampled bid/ask marks, before fees and additional slippage; not fills or continuous MFE/MAE.',
    contracts:event.contracts.map(({samples,...c})=>({...c,sampleCount:samples.length,latestSample:samples.at(-1)||null}))};
}
function createShadowEvents({pool,enabled=false}) {
  let ready=null;
  async function init(){if(!ready)ready=pool.query(SCHEMA).catch(e=>{ready=null;throw e;});await ready;}
  return {
    async observe(input){
      if(!enabled)return {enabled:false};
      if(!pool)return {enabled:true,status:'DATABASE_UNAVAILABLE',executionAllowed:false};
      await init();const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO edge_shadow_cursor_v1(id,payload) VALUES('nifty','null'::jsonb) ON CONFLICT DO NOTHING");
        const row=await client.query("SELECT payload FROM edge_shadow_cursor_v1 WHERE id='nifty' FOR UPDATE");
        const pending=await client.query('SELECT payload FROM edge_shadow_events_v1 WHERE complete=false ORDER BY detected_at LIMIT 200');
        if(pending.rows.length>=200)throw new Error('SHADOW_PENDING_LIMIT');
        const result=advance({...input,cursor:row.rows[0].payload,events:pending.rows.map(r=>r.payload)});
        for(const event of result.events)await client.query('INSERT INTO edge_shadow_events_v1(id,detected_at,complete,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET complete=EXCLUDED.complete,payload=EXCLUDED.payload',[event.id,event.detectedAt,event.complete,JSON.stringify(event)]);
        await client.query("UPDATE edge_shadow_cursor_v1 SET payload=$1::jsonb WHERE id='nifty'",[JSON.stringify(result.cursor)]);
        await client.query('COMMIT');
        return {enabled:true,version:VERSION,status:'RECORDED',events:result.events.map(report),executionAllowed:false};
      } catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    },
    async recent(){
      if(!enabled)return {enabled:false,events:[]};
      if(!pool)throw new Error('SHADOW_DATABASE_UNAVAILABLE');
      await init();const result=await pool.query('SELECT payload FROM edge_shadow_events_v1 ORDER BY detected_at DESC LIMIT 50');
      return {enabled:true,version:VERSION,executionAllowed:false,events:result.rows.map(r=>report(r.payload))};
    }
  };
}
module.exports={advance,quotesFromChain,createShadowEvents,report,SCHEMA};
