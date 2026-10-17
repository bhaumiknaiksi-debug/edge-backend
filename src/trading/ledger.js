'use strict';
const { istParts } = require('../evidence/evidenceHealth');
const { timingSafeOwnerToken } = require('../notifications/edgeWebPush');
const { importBrokerFills, summarizeBroker } = require('./kiteTradebook');
const CAPITAL = 10000, DAILY = 1000, PER_TRADE = 1000;
const money = n => Math.round(n * 100) / 100;
function number(v, name, min = 0) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > 10000000) throw new Error('INVALID_' + name);
  return money(v);
}
function day(now) { const p=istParts(now); return p.minutes<555 ? istParts(new Date(new Date(now).getTime()-86400000)).date : p.date; }
function budget(state, now = new Date()) {
  const today = day(now), trades = state.trades || [];
  const closed = trades.filter(t => t.closedAt && day(new Date(t.closedAt)) === today).sort((a,b)=>a.closedAt.localeCompare(b.closedAt));
  let net = 0, hit = (state.lockedDays || []).includes(today);
  for (const t of closed) { net = money(net + t.netPnl); if (net <= -DAILY) hit = true; }
  const totalNet = money(trades.filter(t=>t.closedAt).reduce((a,t)=>a+t.netPnl,0));
  const open = trades.filter(t => !t.closedAt);
  const openRisk = money(open.reduce((a,t)=>a+t.reservedRisk,0));
  const openCapital = money(open.reduce((a,t)=>a+t.capitalUsed,0));
  const remaining = hit ? 0 : money(Math.max(0, DAILY - Math.max(0,-net) - openRisk));
  return { day:today, confirmed:state.confirmedDay === today, locked:hit, capitalLimit:CAPITAL, perTradeLimit:PER_TRADE, dailyLossLimit:DAILY, netRealizedPnl:net, openRisk, openCapital, availableRisk:Math.min(PER_TRADE,remaining), availableCapital:money(Math.max(0,CAPITAL - Math.max(0,-totalNet) - openCapital)), openTrades:open.length, source:'MANUAL_LEDGER', checkedAt:new Date(now).toISOString() };
}
function apply(state, operation, input, now = new Date()) {
  const s = JSON.parse(JSON.stringify(state));
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId || '')) throw new Error('INVALID_REQUEST_ID');
  if (s.operations.includes(input.requestId)) return s;
  const time = new Date(now).toISOString();
  if (operation === 'import') {
    importBrokerFills(s,input); // Historical broker fills, excluded from live ledger budget.
  } else if (operation === 'confirm') {
    if (input.reconciled !== true) throw new Error('RECONCILIATION_REQUIRED');
    s.confirmedDay = day(now);
  } else if (operation === 'open') {
    const quantity = number(input.quantity,'QUANTITY',1);
    if (!Number.isInteger(quantity)) throw new Error('INVALID_QUANTITY');
    if (typeof input.contract !== 'string' || !/^[A-Za-z0-9 |._-]{3,100}$/.test(input.contract)) throw new Error('INVALID_CONTRACT');
    if (!['LONG_CALL','LONG_PUT','OTHER'].includes(input.strategy)) throw new Error('INVALID_STRATEGY');
    const costs = number(input.estimatedCosts,'COST_RESERVE',0.01);
    let capitalUsed, reservedRisk;
    const entry = number(input.entry,'ENTRY',0.01);
    let stop = null;
    if (input.strategy !== 'OTHER') {
      stop = number(input.stop,'STOP');
      if (stop >= entry) throw new Error('STOP_MUST_BE_BELOW_ENTRY');
      capitalUsed = money(entry * quantity + costs);
      reservedRisk = money((entry-stop)*quantity + costs);
    } else {
      capitalUsed = number(input.capitalUsed,'CAPITAL',0.01) + costs;
      reservedRisk = number(input.plannedLoss,'PLANNED_LOSS',0.01) + costs;
    }
    // This records an actual broker fill, including out-of-policy fills. Never hide real risk.
    s.trades.push({ id:input.requestId, contract:input.contract, strategy:input.strategy, quantity, entry, stop, estimatedCosts:costs, capitalUsed:money(capitalUsed), reservedRisk:money(reservedRisk), openedAt:time, signalId:typeof input.signalId==='string'?input.signalId.slice(0,200):null });
  } else if (operation === 'close') {
    const t = s.trades.find(t=>t.id===input.tradeId);
    if (!t || t.closedAt) throw new Error('TRADE_NOT_OPEN');
    const charges = number(input.charges,'ACTUAL_TOTAL_CHARGES');
    const exit = number(input.exit,'EXIT');
    const gross = t.strategy === 'OTHER' ? numberSigned(input.grossPnl) : money((exit-t.entry)*t.quantity);
    Object.assign(t,{ exit, charges, grossPnl:gross, netPnl:money(gross-charges), closedAt:time });
  } else throw new Error('INVALID_OPERATION');
  s.operations.push(input.requestId);
  if (budget(s,now).locked && !s.lockedDays.includes(day(now))) s.lockedDays.push(day(now));
  return s;
}
function numberSigned(v) { if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>10000000)throw new Error('INVALID_GROSS_PNL');return money(v); }
function createLedger({ pool, ownerToken, onChange = ()=>{}, getPlan = ()=>null }) {
  let current = null, error = 'LEDGER_NOT_LOADED', loadedAt = 0, generation = 0;
  async function refresh() {
    const started = generation;
    try { if(!pool)throw new Error(); const r=await pool.query("SELECT payload FROM edge_trade_ledger_v1 WHERE owner_id='owner'"); if(!r.rows[0])throw new Error(); if(started !== generation)return refresh(); current=r.rows[0].payload;error=null;loadedAt=Date.now();return budget(current); }
    catch (_) { error='LEDGER_UNAVAILABLE';return null; }
  }
  function snapshot() {
    return current && !error && Date.now()-loadedAt<60000 ? {...budget(current),checkedAt:new Date(loadedAt).toISOString()} : {confirmed:false,error:error||'LEDGER_UNAVAILABLE',availableRisk:0,availableCapital:0};
  }
  async function mutate(op,input) {
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const r=await c.query("SELECT payload FROM edge_trade_ledger_v1 WHERE owner_id='owner' FOR UPDATE");
      const next=apply(r.rows[0].payload,op,input);
      await c.query("UPDATE edge_trade_ledger_v1 SET payload=$1,updated_at=now() WHERE owner_id='owner'",[JSON.stringify(next)]);
      await c.query('COMMIT');generation++;current=next;error=null;loadedAt=Date.now();
      // Importing historical records must not blank the live dashboard or alter trade approval.
      if(op!=='import')onChange();
      const result={budget:budget(next),trades:next.trades};
      if(op==='import'){
        result.broker=summarizeBroker(next);
        result.importResult={added:(next.brokerFills||[]).length-(r.rows[0].payload.brokerFills||[]).length,
          duplicates:(input.fills||[]).length-((next.brokerFills||[]).length-(r.rows[0].payload.brokerFills||[]).length)};
      }
      return result;
    } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  function routes(app) {
    const guard=fn=>async(req,res)=>{
      res.setHeader('Cache-Control','no-store');
      const auth=String(req.headers.authorization||'');
      if(!ownerToken||!auth.startsWith('Bearer ')||!timingSafeOwnerToken(auth.slice(7),ownerToken))return res.status(401).json({error:'OWNER_AUTH_REQUIRED'});
      try{if(!pool)throw new Error('LEDGER_UNAVAILABLE');return await fn(req,res);}catch(e){const validation=/^(INVALID_|TRADE_NOT_OPEN|STOP_|RECONCILIATION_)/.test(e.message);return res.status(validation?400:503).json({error:validation?e.message:'LEDGER_UNAVAILABLE'});}
    };
    app.get('/api/v1/trades',guard(async(_req,res)=>{if(!await refresh())throw new Error();res.json({budget:snapshot(),trades:current.trades,broker:summarizeBroker(current),plan:getPlan()});}));
    for(const op of ['confirm','open','close','import'])app.post('/api/v1/trades/'+op,guard(async(req,res)=>res.json(await mutate(op,req.body||{}))));
  }
  return { refresh, snapshot, routes };
}
module.exports={budget,apply,createLedger};
