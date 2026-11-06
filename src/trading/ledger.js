'use strict';
const { istParts } = require('../evidence/evidenceHealth');
const { timingSafeOwnerToken } = require('../notifications/edgeWebPush');
const { importBrokerFills, summarizeBroker } = require('./kiteTradebook');
const { importStatement, summarizedReports } = require('./kitePnl');
// DEFAULT_LIMITS apply only when a caller supplies no limits at all (legacy callers and tests). The server always
// supplies the owner's limits; if those are missing or malformed the budget is UNAVAILABLE and approves nothing.
// Nothing ever falls back to wider numbers.
const DEFAULT_LIMITS = Object.freeze({ capital:10000, daily:1000, perTrade:1000, costReserve:100, source:'DEFAULT', version:null });
const UNAVAILABLE_LIMITS = Object.freeze({ capital:0, daily:0, perTrade:0, costReserve:100, source:'UNAVAILABLE', version:null });
function resolveLimits(l) {
  const ok = (x, max) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= max;
  if (!l || !ok(l.capital, 1000000) || !ok(l.daily, 100000) || !ok(l.perTrade, 100000)) return UNAVAILABLE_LIMITS;
  const costReserve = typeof l.costReserve === 'number' && Number.isFinite(l.costReserve) && l.costReserve >= 0 ? money(l.costReserve) : 100;
  return { capital:money(l.capital), daily:money(l.daily), perTrade:money(Math.min(l.perTrade, l.daily)), costReserve, source:l.source || 'OWNER_POLICY', version:l.version || null };
}
const money = n => Math.round(n * 100) / 100;
function number(v, name, min = 0) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > 10000000) throw new Error('INVALID_' + name);
  return money(v);
}
function day(now) { const p=istParts(now); return p.minutes<555 ? istParts(new Date(new Date(now).getTime()-86400000)).date : p.date; }
function budget(state, now = new Date(), limits = DEFAULT_LIMITS) {
  const resolved = resolveLimits(limits), unavailable = resolved.source === 'UNAVAILABLE';
  const { capital:CAPITAL, daily:DAILY, perTrade:PER_TRADE } = resolved;
  const today = day(now), trades = state.trades || [];
  const closed = trades.filter(t => t.closedAt && day(new Date(t.closedAt)) === today).sort((a,b)=>a.closedAt.localeCompare(b.closedAt));
  let net = 0, hit = (state.lockedDays || []).includes(today);
  // Without limits, nothing is approved, but the day is never locked from a missing number.
  for (const t of closed) { net = money(net + t.netPnl); if (!unavailable && net <= -DAILY) hit = true; }
  const totalNet = money(trades.filter(t=>t.closedAt).reduce((a,t)=>a+t.netPnl,0));
  const open = trades.filter(t => !t.closedAt);
  const openRisk = money(open.reduce((a,t)=>a+t.reservedRisk,0));
  const openCapital = money(open.reduce((a,t)=>a+t.capitalUsed,0));
  const remaining = hit ? 0 : money(Math.max(0, DAILY - Math.max(0,-net) - openRisk));
  return { day:today, confirmed:state.confirmedDay === today, locked:hit, capitalLimit:CAPITAL, perTradeLimit:PER_TRADE, dailyLossLimit:DAILY, limitsSource:resolved.source, limitsVersion:resolved.version, costReserve:resolved.costReserve, netRealizedPnl:net, openRisk, openCapital, availableRisk:Math.min(PER_TRADE,remaining), availableCapital:money(Math.max(0,CAPITAL - Math.max(0,-totalNet) - openCapital)), openTrades:open.length, source:'MANUAL_LEDGER', checkedAt:new Date(now).toISOString() };
}
function apply(state, operation, input, now = new Date(), limits = DEFAULT_LIMITS) {
  const s = JSON.parse(JSON.stringify(state));
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId || '')) throw new Error('INVALID_REQUEST_ID');
  if (s.operations.includes(input.requestId)) return s;
  const time = new Date(now).toISOString();
  if (operation === 'import') {
    importBrokerFills(s,input); // Historical broker fills, excluded from live ledger budget.
  } else if (operation === 'pnl') {
    importStatement(s,input); // Broker statement snapshots never touch trade risk.
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
  const after = budget(s,now,limits);
  if (after.limitsSource !== 'UNAVAILABLE' && after.locked && !s.lockedDays.includes(day(now))) s.lockedDays.push(day(now));
  return s;
}
function numberSigned(v) { if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>10000000)throw new Error('INVALID_GROSS_PNL');return money(v); }
function createLedger({ pool, ownerToken, onChange = ()=>{}, onBrokerImport = ()=>{}, getPlan = ()=>null, getLimits }) {
  // With getLimits, the owner's limits or UNAVAILABLE; never a wider fallback. Without it (legacy), the defaults.
  const limits = () => { if (typeof getLimits !== 'function') return DEFAULT_LIMITS; try { return getLimits() || null; } catch (_) { return null; } };
  let current = null, error = 'LEDGER_NOT_LOADED', loadedAt = 0, generation = 0;
  async function refresh() {
    const started = generation;
    try { if(!pool)throw new Error(); const r=await pool.query("SELECT payload FROM edge_trade_ledger_v1 WHERE owner_id='owner'"); if(!r.rows[0])throw new Error(); if(started !== generation)return refresh(); current=r.rows[0].payload;error=null;loadedAt=Date.now();return budget(current,new Date(),limits()); }
    catch (_) { error='LEDGER_UNAVAILABLE';return null; }
  }
  function snapshot() {
    return current && !error && Date.now()-loadedAt<60000 ? {...budget(current,new Date(),limits()),checkedAt:new Date(loadedAt).toISOString()} : {confirmed:false,error:error||'LEDGER_UNAVAILABLE',availableRisk:0,availableCapital:0};
  }
  async function mutate(op,input) {
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const r=await c.query("SELECT payload FROM edge_trade_ledger_v1 WHERE owner_id='owner' FOR UPDATE");
      const next=apply(r.rows[0].payload,op,input,new Date(),limits());
      await c.query("UPDATE edge_trade_ledger_v1 SET payload=$1,updated_at=now() WHERE owner_id='owner'",[JSON.stringify(next)]);
      await c.query('COMMIT');generation++;current=next;error=null;loadedAt=Date.now();
      // Importing historical records must not blank the live dashboard or alter trade approval.
      if(op!=='import'&&op!=='pnl')onChange();
      // Reporting-only matching; cannot make broker imports fail or modify live readiness.
      if(op==='import'||op==='pnl')Promise.resolve().then(onBrokerImport).catch(()=>console.error('[trade snapshots] background reconciliation unavailable'));
      const result={budget:budget(next,new Date(),limits()),trades:next.trades,broker:summarizeBroker(next),pnl:summarizedReports(next)};
      if(op==='import'){
        result.importResult={added:(next.brokerFills||[]).length-(r.rows[0].payload.brokerFills||[]).length,
          duplicates:(input.fills||[]).length-((next.brokerFills||[]).length-(r.rows[0].payload.brokerFills||[]).length)};
      }
      if(op==='pnl'){
        const incoming=next.pnlStatements?.find(p=>p.id===input.startDate+'_'+input.endDate);
        const before=r.rows[0].payload.pnlStatements?.find(p=>p.id===incoming?.id);
        result.pnlResult={period:incoming?.id,unchanged:!!before&&JSON.stringify(before)===JSON.stringify(incoming),replaced:!!before&&JSON.stringify(before)!==JSON.stringify(incoming)};
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
    app.get('/api/v1/trades',guard(async(_req,res)=>{if(!await refresh())throw new Error();res.json({budget:snapshot(),trades:current.trades,broker:summarizeBroker(current),pnl:summarizedReports(current),plan:getPlan()});}));
    for(const op of ['confirm','open','close','import','pnl'])app.post('/api/v1/trades/'+op,guard(async(req,res)=>res.json(await mutate(op,req.body||{}))));
  }
  return { refresh, snapshot, routes };
}
module.exports={budget,apply,createLedger,resolveLimits,DEFAULT_LIMITS,UNAVAILABLE_LIMITS};
