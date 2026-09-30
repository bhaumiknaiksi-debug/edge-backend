'use strict';

// Calibrated research cost profiles for NSE equity options.
// Rates are intentionally isolated from live execution logic.
const PROFILES = Object.freeze({
  UPSTOX_STANDARD_NSE_OPTIONS_2026: Object.freeze({
    name:'UPSTOX_STANDARD_NSE_OPTIONS_2026',
    broker:'UPSTOX',
    segment:'NSE_EQUITY_OPTIONS',
    effectiveFrom:'2026-04-01',
    calibratedAsOf:'2026-09-30',
    brokeragePerExecutedOrderRupees:20,
    sttSellPct:0.15,
    exchangeTransactionPct:0.03552,
    sebiPerCroreRupees:10,
    stampDutyBuyPct:0.003,
    gstPct:18,
    ipftPerCroreRupees:50,
    lotSize:65,
    lots:null,
    assumptions:[
      'uses recorded recommendedLots when available; otherwise falls back to a one-lot research baseline',
      'each option leg entry and exit is treated as a separately executed order',
      'brokerage uses the standard Upstox flat Rs20 equity-options schedule',
      'exchange charge uses NSE equity-options premium turnover rate effective 1 March 2026',
      'IPFT uses Upstox client charge of Rs0.50 per lakh of equity-options premium turnover',
      'exit marks are aligned one-minute candle closes; execution slippage can be stress-tested separately but is not claimed as calibrated',
      'exercise/assignment STT is excluded because research horizons model an exit transaction, not expiry exercise'
    ]
  })
});

function n(v){if(v===null||v===undefined||v==='')return null;const x=Number(v);return Number.isFinite(x)?x:null;}
function round(v,dp=4){return Number(Number(v).toFixed(dp));}
function getProfile(name){
  if(!name||String(name).toUpperCase()==='NONE')return null;
  return PROFILES[String(name)]||null;
}
function sideOpposite(side){return side==='BUY'?'SELL':side==='SELL'?'BUY':null;}

function optionOrderCharges({premium,side,quantity,profile}={}){
  const px=n(premium),qty=n(quantity);
  if(px===null||px<0||qty===null||qty<=0||!profile||!['BUY','SELL'].includes(side))return null;
  const turnover=px*qty;
  const brokerage=profile.brokeragePerExecutedOrderRupees;
  const exchange=turnover*profile.exchangeTransactionPct/100;
  const ipft=turnover*profile.ipftPerCroreRupees/10000000;
  const sebi=turnover*profile.sebiPerCroreRupees/10000000;
  const stt=side==='SELL'?turnover*profile.sttSellPct/100:0;
  const stampDuty=side==='BUY'?turnover*profile.stampDutyBuyPct/100:0;
  const gst=(brokerage+exchange+ipft)*profile.gstPct/100;
  const total=brokerage+exchange+ipft+sebi+stt+stampDuty+gst;
  return {
    turnoverRupees:round(turnover,2),
    brokerageRupees:round(brokerage,2),
    exchangeRupees:round(exchange,4),
    ipftRupees:round(ipft,4),
    sebiRupees:round(sebi,4),
    sttRupees:round(stt,4),
    stampDutyRupees:round(stampDuty,4),
    gstRupees:round(gst,4),
    totalRupees:round(total,4)
  };
}

function calibratedRoundTripCost(row,horizon,profileName='UPSTOX_STANDARD_NSE_OPTIONS_2026',opts={}){
  const profile=getProfile(profileName);
  if(!profile)return{available:false,reason:'PROFILE_DISABLED',profile:null};
  const outcome=row?.outcome||{};
  const entryValue=n(outcome.entryValue);
  if(entryValue===null||entryValue<=0)return{available:false,reason:'ENTRY_VALUE_UNAVAILABLE',profile:profile.name};
  const entries=outcome.entryLegMarks;
  const exitContainer=outcome.horizonLegMarks?.[horizon]||outcome.horizonLegMarks?.[String(horizon)];
  const exits=exitContainer?.marks||exitContainer;
  if(!entries||!exits)return{available:false,reason:'LEG_MARKS_UNAVAILABLE',profile:profile.name};
  const lotSize=n(row?.snapshot?.tradeLegs?.lotSize)??profile.lotSize;
  const recordedLots=n(row?.snapshot?.position?.recommendedLots);
  const lots=recordedLots!==null&&recordedLots>=1?recordedLots:(profile.lots||1);
  const quantity=lotSize*lots;
  const slippageBps=Math.max(0,n(opts.slippageBps)??0);
  let total=0,slippageRupees=0;
  const legs={};
  for(const [name,entry] of Object.entries(entries)){
    const side=entry?.side,entryPx=n(entry?.price),exitPx=n(exits?.[name]);
    if(!side||entryPx===null||exitPx===null)return{available:false,reason:'INCOMPLETE_LEG_MARKS',profile:profile.name};
    const entryCharges=optionOrderCharges({premium:entryPx,side,quantity,profile});
    const exitSide=sideOpposite(side);
    const exitCharges=optionOrderCharges({premium:exitPx,side:exitSide,quantity,profile});
    if(!entryCharges||!exitCharges)return{available:false,reason:'CHARGE_CALCULATION_FAILED',profile:profile.name};
    const legSlippage=(entryCharges.turnoverRupees+exitCharges.turnoverRupees)*slippageBps/10000;
    const legTotal=entryCharges.totalRupees+exitCharges.totalRupees+legSlippage;
    total+=legTotal; slippageRupees+=legSlippage;
    legs[name]={entrySide:side,exitSide,entryPremium:entryPx,exitPremium:exitPx,entryCharges,exitCharges,slippageRupees:round(legSlippage,4),totalRupees:round(legTotal,4)};
  }
  const denominatorRupees=entryValue*quantity;
  return {
    available:true,
    profile:profile.name,
    lotSize,lots,quantity,
    slippageBps,
    slippageRupees:round(slippageRupees,4),
    totalRupees:round(total,4),
    denominatorRupees:round(denominatorRupees,2),
    costPct:round(total/denominatorRupees*100,4),
    legs
  };
}

module.exports={PROFILES,getProfile,optionOrderCharges,calibratedRoundTripCost};
