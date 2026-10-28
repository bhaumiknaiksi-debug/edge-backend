'use strict';
(()=>{
 const base='/api/v1/execution/sandbox',el=id=>document.getElementById(id);
 let owner='',timer=null,policyLoaded=false;
 const human=value=>String(value||'').toLowerCase().replaceAll('_',' ');
 async function request(path='',body){
  const response=await fetch(base+path,{method:body?'POST':'GET',cache:'no-store',headers:{...(owner?{Authorization:'Bearer '+owner}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw Error(human(data.error||'Connection unavailable'));return data;
 }
 function message(value){el('message').textContent=value;}
 async function refresh(){
  try{
   const data=await request(),s=data.state,orders=Object.values(s.orders),trades=Object.values(s.trades);
   el('limits').textContent='Sandbox limits: ₹'+s.policy.capital+' capital · ₹'+s.policy.perTradeRisk+' planned risk/trade · ₹'+s.policy.dailyLoss+' daily loss threshold · '+s.policy.maxTradesPerDay+' entries/day · '+(s.policy.entryMode==='OPENING_RANGE_SHADOW_V1'?'any tier after fixed-level crossing (experimental)':'Tier A only');
   if(!policyLoaded){el('daily-goal').value=s.policy.dailyGoal||1000;el('daily-loss').value=s.policy.dailyLoss;el('per-trade-risk').value=s.policy.perTradeRisk;el('entry-mode').value=s.policy.entryMode||'AUTHORITATIVE_A_ONLY';policyLoaded=true;updateRatio();}
   el('save-policy').disabled=!s.killed||s.armed||orders.some(o=>!['COMPLETE','CANCELLED','REJECTED','EXPIRED'].includes(o.state))||trades.some(t=>!t.closedAt);
   el('system').textContent=s.killed?'Stopped':s.armed?'Armed':'Disarmed';
   el('orders').textContent=orders.filter(o=>!['COMPLETE','CANCELLED','REJECTED','EXPIRED'].includes(o.state)).length;
   el('positions').textContent=trades.filter(t=>!t.closedAt).length;
   el('position-basis').textContent=s.positionBasis==='SANDBOX_ORDER_BOOK_DERIVED'?'Exposure is derived from sandbox order fills; it is not independently confirmed by a positions API.':s.positionBasis==='BROKER_POSITIONS'?'Exposure is checked against broker positions.':'';
   el('arm').disabled=s.armed;el('stop').disabled=false;
   message(s.haltReason?human(s.haltReason):data.status.reason?human(data.status.reason):human(data.status.lastEntryResult||'Connected'));
   renderTiers(data.tierSummary);renderStuck(s,trades);
   el('list').replaceChildren();
   for(const order of orders.slice(-15).reverse()){
    const row=document.createElement('div');row.className='order';const title=document.createElement('strong'),detail=document.createElement('span');
    title.textContent=(order.contractId||order.instrumentKey)+' · '+order.side;
    detail.textContent=human(order.kind)+' · '+human(order.state)+' · filled '+order.filled+' / '+order.quantity;
    row.append(title,detail);el('list').append(row);
   }
   if(!orders.length)el('list').textContent='No sandbox orders yet.';
  }catch(e){el('arm').disabled=true;el('save-policy').disabled=true;message(e.message);}
 }
 function renderTiers(summary){
  const box=el('tier-summary'),rows=Object.entries(summary?.byEntryTier||{});box.replaceChildren();
  if(!rows.length){box.textContent='No closed sandbox trades yet.';return;}
  for(const [tier,r] of rows.sort()){const row=document.createElement('div');row.className='order';const a=document.createElement('strong'),b=document.createElement('span');
   a.textContent='Tier '+tier;b.textContent=r.trades+' trades · '+r.wins+' wins · '+r.losses+' losses · estimated net ₹'+r.netPnl;row.append(a,b);box.append(row);}
 }
 function renderStuck(s,trades){
  const today=new Date(Date.now()+19800000).toISOString().slice(0,10),stuck=trades.filter(t=>!t.closedAt&&t.day<today);
  el('stuck').hidden=!stuck.length;el('stuck-list').replaceChildren();
  for(const t of stuck){const row=document.createElement('div');row.className='order';const a=document.createElement('strong'),b=document.createElement('span'),btn=document.createElement('button');
   a.textContent=(t.contractId||t.instrumentKey)+' · '+t.day;b.textContent=' stop first, then resolve ';btn.textContent='Resolve';btn.disabled=!s.killed||s.armed;
   btn.addEventListener('click',async()=>{btn.disabled=true;try{await request('/resolve',{requestId:crypto.randomUUID(),confirmSandbox:true,tradeId:t.id,reason:'Owner resolved prior-day sandbox trade'});await refresh();message('Trade resolved.');}catch(e){message(e.message);}});
   row.append(a,b,btn);el('stuck-list').append(row);}
 }
 function updateRatio(){const goal=Number(el('daily-goal').value),loss=Number(el('daily-loss').value);el('goal-ratio').textContent=goal>0&&loss>0?'Loss threshold: '+(loss/goal*100).toFixed(1)+'% of daily goal.':'';}
 for(const id of ['daily-goal','daily-loss'])el(id).addEventListener('input',updateRatio);
 el('save-policy').addEventListener('click',async()=>{el('save-policy').disabled=true;try{await request('/policy',{requestId:crypto.randomUUID(),confirmSandbox:true,dailyGoal:Number(el('daily-goal').value),dailyLoss:Number(el('daily-loss').value),perTradeRisk:Number(el('per-trade-risk').value),entryMode:el('entry-mode').value});policyLoaded=false;await refresh();message('Sandbox limits saved.');}catch(e){message(e.message);}});
 el('connect').addEventListener('click',async()=>{owner=el('owner').value.trim();el('owner').value='';if(!owner){message('Enter your owner code.');return;}await refresh();if(timer)clearInterval(timer);timer=setInterval(refresh,5000);});
 for(const name of ['arm','stop'])el(name).addEventListener('click',async()=>{el(name).disabled=true;try{await request('/'+name,{requestId:crypto.randomUUID(),confirmSandbox:true});await refresh();}catch(e){message(e.message);}});
 request('/status').then(s=>message(s.configured?'Ready to connect.':'Sandbox connection needs setup: '+human(s.reason))).catch(()=>message('Connection unavailable.'));
})();
