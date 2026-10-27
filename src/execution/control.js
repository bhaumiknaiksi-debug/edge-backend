'use strict';
(()=>{
 const base='/api/v1/execution/sandbox',el=id=>document.getElementById(id);
 let owner='',timer=null;
 const human=value=>String(value||'').toLowerCase().replaceAll('_',' ');
 async function request(path='',body){
  const response=await fetch(base+path,{method:body?'POST':'GET',cache:'no-store',headers:{...(owner?{Authorization:'Bearer '+owner}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw Error(human(data.error||'Connection unavailable'));return data;
 }
 function message(value){el('message').textContent=value;}
 async function refresh(){
  try{
   const data=await request(),s=data.state,orders=Object.values(s.orders),trades=Object.values(s.trades);
   el('limits').textContent='Sandbox limits: ₹'+s.policy.capital+' capital · ₹'+s.policy.perTradeRisk+' planned risk/trade · ₹'+s.policy.dailyLoss+' daily loss threshold · '+s.policy.maxTradesPerDay+' entries/day';
   el('system').textContent=s.killed?'Stopped':s.armed?'Armed':'Disarmed';
   el('orders').textContent=orders.filter(o=>!['COMPLETE','CANCELLED','REJECTED','EXPIRED'].includes(o.state)).length;
   el('positions').textContent=trades.filter(t=>!t.closedAt).length;
   el('position-basis').textContent=s.positionBasis==='SANDBOX_ORDER_BOOK_DERIVED'?'Exposure is derived from sandbox order fills; it is not independently confirmed by a positions API.':s.positionBasis==='BROKER_POSITIONS'?'Exposure is checked against broker positions.':'';
   el('arm').disabled=s.armed;el('stop').disabled=false;
   message(s.haltReason?human(s.haltReason):data.status.reason?human(data.status.reason):human(data.status.lastEntryResult||'Connected'));
   el('list').replaceChildren();
   for(const order of orders.slice(-15).reverse()){
    const row=document.createElement('div');row.className='order';const title=document.createElement('strong'),detail=document.createElement('span');
    title.textContent=(order.contractId||order.instrumentKey)+' · '+order.side;
    detail.textContent=human(order.kind)+' · '+human(order.state)+' · filled '+order.filled+' / '+order.quantity;
    row.append(title,detail);el('list').append(row);
   }
   if(!orders.length)el('list').textContent='No sandbox orders yet.';
  }catch(e){el('arm').disabled=true;message(e.message);}
 }
 el('connect').addEventListener('click',async()=>{owner=el('owner').value.trim();el('owner').value='';if(!owner){message('Enter your owner code.');return;}await refresh();if(timer)clearInterval(timer);timer=setInterval(refresh,5000);});
 for(const name of ['arm','stop'])el(name).addEventListener('click',async()=>{el(name).disabled=true;try{await request('/'+name,{requestId:crypto.randomUUID(),confirmSandbox:true});await refresh();}catch(e){message(e.message);}});
 request('/status').then(s=>message(s.configured?'Ready to connect.':'Sandbox connection needs setup: '+human(s.reason))).catch(()=>message('Connection unavailable.'));
})();
