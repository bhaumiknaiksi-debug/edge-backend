'use strict';
// Paper broker: EDGE's own order book, filled against REAL live quotes.
// Why: the Upstox sandbox only simulates place/modify/cancel responses. Its orders never fill and never
// appear in an order book or positions, so the sandbox executor could never complete a trade.
// This module exposes the same interface as upstoxSandbox (placeOrder, cancel, getOrders, getPositions)
// and returns rows in the same shape as Upstox's order book, so sandboxEngine reconciles it unchanged.
// It never contacts a broker order endpoint. Only the read-only market quotes source is used.
const {randomUUID}=require('node:crypto');
const SCHEMA=`CREATE TABLE IF NOT EXISTS edge_paper_book_v1 (
 id text PRIMARY KEY CHECK(id='owner'), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
const FILL_MODEL='PAPER_LIVE_QUOTES_V1';
const ID_PREFIX='paper-';
const day=t=>new Date(t+19800000).toISOString().slice(0,10);
const minutes=t=>{const d=new Date(t+19800000);return d.getUTCHours()*60+d.getUTCMinutes();};
const WORKING=['open','trigger pending'];
const isPaperOrderId=id=>typeof id==='string'&&id.startsWith(ID_PREFIX);

function pgBook({pool}){
  let initialized=null;
  async function init(){
    if(!pool)throw Error('PAPER_DATABASE_REQUIRED');
    if(!initialized)initialized=(async()=>{await pool.query(SCHEMA);await pool.query("INSERT INTO edge_paper_book_v1(id,payload) VALUES('owner',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify({orders:[]})]);})().catch(e=>{initialized=null;throw e;});
    await initialized;
  }
  async function read(){await init();const row=await pool.query("SELECT payload FROM edge_paper_book_v1 WHERE id='owner'");return row.rows[0].payload;}
  return {read,async mutate(fn){
    await init();const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const row=await client.query("SELECT payload FROM edge_paper_book_v1 WHERE id='owner' FOR UPDATE");
      const book=JSON.parse(JSON.stringify(row.rows[0].payload));
      const result=fn(book);
      await client.query("UPDATE edge_paper_book_v1 SET payload=$1::jsonb,updated_at=now() WHERE id='owner'",[JSON.stringify(book)]);
      await client.query('COMMIT');return result;
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }};
}
function memoryBook(){
  let book={orders:[]},tail=Promise.resolve();
  return {async read(){await tail;return structuredClone(book);},mutate(fn){const run=tail.then(()=>{const next=structuredClone(book),result=fn(next);book=next;return structuredClone(result);});tail=run.catch(()=>{});return run;},
    peek:()=>structuredClone(book)};
}

// Fill rules (one decision per working order per read, full quantity only):
//  BUY LIMIT  fills when ask <= limit, at the ask.
//  SELL LIMIT fills when bid >= limit, at the bid.
//  SELL SL    triggers when bid <= trigger, then fills like a SELL LIMIT; a gap below its limit leaves it open.
// Only during 09:15-15:30 IST and only on a quote whose EXCHANGE timestamp is at most 10s old at the moment of the
// fill (checked here, not only when fetched), so a stale or missing quote never fills anything.
const inSession=t=>{const m=minutes(t);return m>=555&&m<930;};
function fill(order,quote,now){
  if(!quote||!(quote.bid>0)||!(quote.ask>=quote.bid)||!Number.isFinite(quote.exchangeAt)||quote.exchangeAt>now+1000||now-quote.exchangeAt>10000)return;
  if(order.status==='trigger pending'){if(quote.bid<=order.trigger_price)order.status='open';else return;}
  if(order.status!=='open')return;
  const at=order.transaction_type==='BUY'?(quote.ask<=order.price?quote.ask:null):(quote.bid>=order.price?quote.bid:null);
  if(at===null)return;
  Object.assign(order,{status:'complete',filled_quantity:order.quantity,average_price:at,filled_at:now,fill_bid:quote.bid,fill_ask:quote.ask});
}

function createPaperBroker({pool,quotes,now=Date.now,book}={}){
  if(!quotes||typeof quotes.get!=='function')throw Error('PAPER_QUOTES_REQUIRED');
  const storage=book||pgBook({pool});
  const visible=(o,today)=>o.day===today;
  const row=o=>{const {day:_d,filled_at:_f,fill_bid:_b,fill_ask:_a,...rest}=o;return rest;};
  async function placeOrder({instrumentKey,quantity,price,side,tag,orderType='LIMIT',trigger=0}){
    if(typeof instrumentKey!=='string'||!/^NSE_FO\|[A-Za-z0-9]+$/.test(instrumentKey)||
      !Number.isSafeInteger(quantity)||quantity<=0||quantity>100000||typeof price!=='number'||!Number.isFinite(price)||price<=0||
      !['BUY','SELL'].includes(side)||typeof tag!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(tag)||
      !['LIMIT','SL'].includes(orderType)||(orderType==='SL'&&(side!=='SELL'||!Number.isFinite(trigger)||trigger<=price))||
      (orderType==='LIMIT'&&trigger!==0))throw Error('INVALID_SANDBOX_ORDER');
    if(!inSession(now()))return {state:'REJECTED',reason:'PAPER_MARKET_CLOSED',tag};
    try{
      return await storage.mutate(b=>{
        // Re-checked inside the write: storage can be slow, and the session may have closed meanwhile.
        const time=now();
        if(!inSession(time))return {state:'REJECTED',reason:'PAPER_MARKET_CLOSED',tag};
        // A tag is unique per EDGE order; a retried placement returns the existing order instead of a duplicate.
        const existing=b.orders.find(o=>o.tag===tag&&o.day===day(time));
        if(existing)return {state:'ACKNOWLEDGED',orderId:existing.order_id,tag};
        const id=ID_PREFIX+randomUUID();
        b.orders.push({order_id:id,day:day(time),placed_at:time,tag,instrument_token:instrumentKey,quantity,price,trigger_price:trigger,
          transaction_type:side,product:'I',order_type:orderType,status:orderType==='SL'?'trigger pending':'open',filled_quantity:0,average_price:0});
        // Keep a week of history; older rows are never shown (the book rolls daily like a broker's).
        const cutoff=day(time-7*86400000);b.orders=b.orders.filter(o=>o.day>=cutoff);
        return {state:'ACKNOWLEDGED',orderId:id,tag};
      });
    }catch(_){return {state:'UNCERTAIN',reason:'TRANSPORT_OR_ACK_UNCONFIRMED',tag};}
  }
  async function cancel(orderId){
    if(typeof orderId!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(orderId))throw Error('INVALID_ORDER_ID');
    try{
      return await storage.mutate(b=>{
        const o=b.orders.find(x=>x.order_id===orderId);
        if(!o||!WORKING.includes(o.status))return {state:'REJECTED',reason:'ORDER_NOT_CANCELLABLE'};
        o.status='cancelled';return {state:'ACKNOWLEDGED',orderId};
      });
    }catch(_){return {state:'UNCERTAIN',reason:'TRANSPORT_OR_ACK_UNCONFIRMED'};}
  }
  // Every read first fills whatever today's live quotes allow, then returns today's book.
  // Positions are read after any in-flight book read, so both reflect the same fills (they are fetched in parallel).
  let inflight=Promise.resolve();
  function getOrders(){const run=readBook();inflight=run.catch(()=>{});return run;}
  async function readBook(){
    const time=now(),today=day(time);
    let snapshot;
    try{snapshot=(await storage.read()).orders.filter(o=>visible(o,today)&&WORKING.includes(o.status)).map(o=>o.instrument_token);}
    catch(_){const e=Error('SANDBOX_READ_UNAVAILABLE');e.httpStatus=null;throw e;}
    let live={};
    const keys=[...new Set(snapshot)].slice(0,10);
    if(keys.length&&inSession(time))live=await quotes.get(keys).catch(()=>({}));
    try{
      if(!Object.keys(live).length)return (await storage.read()).orders.filter(o=>visible(o,today)).map(row);
      return await storage.mutate(b=>{
        // Re-checked inside the write: a slow quote read must not fill after the close or on another day.
        const at=now();if(day(at)!==today||!inSession(at))return b.orders.filter(o=>visible(o,today)).map(row);
        for(const o of b.orders)if(visible(o,today)&&WORKING.includes(o.status))fill(o,live[o.instrument_token],at);
        return b.orders.filter(o=>visible(o,today)).map(row);
      });
    }catch(_){const e=Error('SANDBOX_READ_UNAVAILABLE');e.httpStatus=null;throw e;}
  }
  async function getPositions(){
    await inflight;const today=day(now());let rows;
    try{rows=(await storage.read()).orders.filter(o=>visible(o,today)&&o.filled_quantity>0);}
    catch(_){const e=Error('SANDBOX_READ_UNAVAILABLE');e.httpStatus=null;throw e;}
    const net={};
    for(const o of rows)net[o.instrument_token]=(net[o.instrument_token]||0)+(o.transaction_type==='BUY'?o.filled_quantity:-o.filled_quantity);
    return Object.entries(net).map(([instrument_token,quantity])=>({instrument_token,quantity,product:'I'}));
  }
  return {placeOrder,placeLimit:placeOrder,cancel,getOrders,getPositions,fillModel:FILL_MODEL};
}
module.exports={createPaperBroker,memoryBook,isPaperOrderId,FILL_MODEL,SCHEMA};
