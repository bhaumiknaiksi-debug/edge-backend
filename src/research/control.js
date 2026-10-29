'use strict';
(()=>{
 const el=id=>document.getElementById(id),human=v=>String(v??'unknown').toLowerCase().replaceAll('_',' '),money=v=>v==null?'Unavailable':Number(v).toFixed(2);
 const when=v=>v?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium'}).format(new Date(v)):'Unknown';
 let owner='',report=null,shown=0;
 function cell(row,value){const td=document.createElement('td');td.textContent=value;row.append(td);return td;}
 function table(id,rows,values){const body=el(id);body.replaceChildren();for(const item of rows){const row=document.createElement('tr');for(const value of values(item))cell(row,value);body.append(row);}if(!rows.length){const row=document.createElement('tr');cell(row,'No records');body.append(row);}}
 async function request(path='',post=false){const response=await fetch('/api/v1/opportunities'+path,{method:post?'POST':'GET',cache:'no-store',headers:{Authorization:'Bearer '+owner}});const data=await response.json();if(!response.ok)throw Error(human(data.error));return data;}
 function renderEpisodes(){const rows=report.candidateEpisodes.slice(0,shown);table('episodes',rows,e=>[when(e.at),e.tier+' · '+e.legs.map(l=>l.contractId||l.strike+' '+l.type).join(' / '),human(e.result.status),money(e.result.estimatedNetRupees),human(e.result.reason||e.result.basis)]);el('more').disabled=shown>=report.candidateEpisodes.length;}
 async function load(){try{
  el('status').textContent='Reading persisted records…';report=await request();el('report').hidden=false;
  el('source').textContent='Archive: '+when(report.source.firstObservationAt)+' → '+when(report.source.lastObservationAt)+'. '+report.source.observations+' saved observations.';
  el('totals').textContent=report.totals.importedFills+' imported fills · '+report.totals.savedSnapshots+' snapshots · '+report.totals.candidateEpisodes+' candidate episodes';
  table('fills',report.fills,f=>[when(f.time+'+05:30'),f.symbol+' · '+f.side,human(f.coverage.status),(f.coverage.candidateTiers||[]).join(', ')||'Unknown',f.coverage.signalTier||'Unknown',human((f.coverage.rejectedBy||[]).join(', ')||f.coverage.primaryMiss||'None')]);
  [...el('fills').children].forEach((row,i)=>{const f=report.fills[i];if(!f)return;const td=document.createElement('td'),details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=(f.coverage.history||[]).length+' changes';details.append(summary);for(const h of f.coverage.history||[]){const p=document.createElement('p');p.textContent=when(h.at)+' · readiness '+h.signalTier+' · '+h.candidates.map(c=>'card '+c.tier+' '+c.strategy+' ('+human(c.matchKind)+'): '+human(c.rejectedBy.join(', ')||'no recorded rejection')).join(' | ')+' · rule '+h.ruleVersion;details.append(p);}td.append(details);row.append(td);});
  el('snapshots').replaceChildren();for(const s of report.snapshots){const p=document.createElement('p');p.textContent=when(s.at)+' · card '+s.tier+' · readiness '+s.actualSignalTier+' · saved '+when(s.capturedAt)+' · '+s.importedFillKeys.length+' nearby contract fills (not automatic P&L attribution)';el('snapshots').append(p);}if(!report.snapshots.length)el('snapshots').textContent='No saved manual trade snapshots.';
  table('tiers',report.byCandidateTier,t=>[t.tier,t.flagged,t.measured,t.unmeasured,t.monetaryMeasured,t.wins+' / '+t.losses+' / '+t.flat,money(t.estimatedMeanNetRupees),t.observedDays]);
  table('readiness',report.bySignalTier,t=>[t.tier,t.flagged,t.measured,t.unmeasured,t.wins+' / '+t.losses+' / '+t.flat,money(t.estimatedMeanNetRupees)]);
  table('versions',report.byRuleVersion,t=>[t.ruleVersion+' · '+human(t.axis),t.tier,t.flagged,t.measured,money(t.estimatedMeanNetRupees)]);
  const q=report.quickExit;if(q){const P=q.primaryRule,line=r=>[r.measured,r.winRatePct==null?'–':r.winRatePct+'%',r.targetHits+' / '+r.stopHits+' / '+r.timeExits,money(r.meanNetRupees),money(r.totalNetRupees)];
   const rule=q.rules.find(r=>r.id===P);el('quick-basis').textContent='Primary rule (fixed in advance): buy at the flagged ask, exit at +'+rule.target+' or −'+rule.stop+' premium points, else at market after '+rule.maxMinutes+' minutes. '+q.basis;
   const missing=Object.entries(q.unmeasuredReasons).map(([k,v])=>human(k)+' '+v).join(' · ');el('quick-progress').textContent=q.overall[P].measured+' of '+q.episodes+' single-leg cards measured'+(missing?' · not yet: '+missing:'');
   table('quick-tier',[{key:'All cards',...q.overall[P]},...q.byCardTier[P].map(r=>({...r,key:'Card '+r.key}))],r=>[r.key,...line(r),r.medianMinutes??'–',r.days]);
   table('quick-split',[...q.byDirection[P],...q.byExpiry[P].map(r=>({...r,key:human(r.key)})),...q.byTimeOfDay[P]],r=>[r.key,...line(r),r.medianMinutes??'–',r.days]);
   table('quick-rules',q.rules.map(r=>({...q.overall[r.id],key:'+'+r.target+' / −'+r.stop+' / '+r.maxMinutes+'m'+(r.primary?' (primary)':'')})),r=>[r.key,...line(r)]);
   el('quick-limits').textContent=q.limits.join(' ');}
  shown=50;renderEpisodes();el('gates').replaceChildren();for(const g of report.gateChangeQueue){const p=document.createElement('p');p.textContent=human(g.gate)+' · '+g.missedEntryOrders+' buy orders / '+g.missedEntryFills+' fills · '+human(g.status);el('gates').append(p);}if(!report.gateChangeQueue.length)el('gates').textContent='No classified missed entry fills.';
  el('fingerprint').textContent='Report '+report.reportFingerprint+' · '+when(report.generatedAt);el('status').textContent='Report loaded. No trading rules changed.';
 }catch(e){el('status').textContent=e.message;}}
 el('connect').addEventListener('click',()=>{owner=el('owner').value.trim();el('owner').value='';if(owner)void load();});el('refresh').addEventListener('click',load);
 el('more').addEventListener('click',()=>{shown+=100;renderEpisodes();});el('measure').addEventListener('click',async()=>{try{await request('/measure',true);el('status').textContent='Outcome collection requested. Refresh after it finishes.';}catch(e){el('status').textContent=e.message;}});
 el('download').addEventListener('click',()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='edge-opportunity-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
})();
