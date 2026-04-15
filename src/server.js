const express = require("express");
const http    = require("http");
const crypto  = require("crypto");

const { findSupportResistance } = require("./engine/oiEngine");
const { calcPCR }               = require("./engine/pcrEngine");
const { calcSentiment }         = require("./engine/sentimentEngine");
const { rankAlphaStrikes }      = require("./engine/strikeEngine");
const { getTradeDecision }      = require("./engine/decisionEngine");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

app.use(express.json({ limit: "2mb" }));
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -- State --
var clients     = [];
var lastResult  = null;
var lastPushTime = 0;

// -- NSE Holiday list --
var NSE_HOLIDAYS = [
  "2026-01-26","2026-03-25","2026-04-14","2026-05-01",
  "2026-08-15","2026-10-02","2026-10-22","2026-11-05","2026-11-25"
];

function getIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}
function toDateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function isTradingDay(d) {
  var day = d.getDay();
  if (day === 0 || day === 6) return false;
  return NSE_HOLIDAYS.indexOf(toDateStr(d)) < 0;
}
function msUntilNextOpen() {
  var now = getIST(), c = new Date(now);
  for (var i = 0; i < 10; i++) {
    var check = new Date(c); check.setHours(9,15,0,0);
    if (check > now && isTradingDay(check)) return check - now;
    c.setDate(c.getDate() + 1);
  }
  return 0;
}
function getLastSessionDate() {
  var now = getIST(), mins = now.getHours()*60+now.getMinutes();
  var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (isTradingDay(now) && mins >= 930) return days[now.getDay()]+", "+months[now.getMonth()]+" "+now.getDate();
  var c = new Date(now); c.setDate(c.getDate()-1);
  for (var i = 0; i < 10; i++) {
    if (isTradingDay(c)) return days[c.getDay()]+", "+months[c.getMonth()]+" "+c.getDate();
    c.setDate(c.getDate()-1);
  }
  return "--";
}
function getMarketPhase() {
  var now  = getIST(), day = now.getDay();
  var mins = now.getHours()*60+now.getMinutes();
  var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var msLeft, h, m;
  if (day === 0 || day === 6) {
    msLeft = msUntilNextOpen(); h = Math.floor(msLeft/3600000); m = Math.floor((msLeft%3600000)/60000);
    return { phase:"WEEKEND", isOpen:false, message:"Markets reopen Monday", countdown:h+"h "+m+"m", nextSession:"Monday, 9:15 AM", lastSession:getLastSessionDate() };
  }
  if (!isTradingDay(now)) {
    msLeft = msUntilNextOpen(); h = Math.floor(msLeft/3600000); m = Math.floor((msLeft%3600000)/60000);
    return { phase:"HOLIDAY", isOpen:false, message:"NSE Holiday", countdown:h+"h "+m+"m", nextSession:"Next trading day, 9:15 AM", lastSession:getLastSessionDate() };
  }
  if (mins < 555) {
    msLeft = msUntilNextOpen(); h = Math.floor(msLeft/3600000); m = Math.floor((msLeft%3600000)/60000);
    return { phase:"PRE_OPEN", isOpen:false, message:"Pre-market session", countdown:h+"h "+m+"m", nextSession:days[day]+", 9:15 AM", lastSession:getLastSessionDate() };
  }
  if (mins < 915) return { phase:"OPEN",    isOpen:true,  message:"Market Live",      countdown:null, nextSession:null, lastSession:null };
  if (mins <= 930) return { phase:"CLOSING", isOpen:true,  message:"Closing session",  countdown:null, nextSession:null, lastSession:null };
  msLeft = msUntilNextOpen(); h = Math.floor(msLeft/3600000); m = Math.floor((msLeft%3600000)/60000);
  return { phase:"POST_MARKET", isOpen:false, message:"Market Closed", countdown:h+"h "+m+"m", nextSession:days[(day%6===5?day+3:day+1)%7]+", 9:15 AM", lastSession:getLastSessionDate() };
}
function isMarketOpen() { return getMarketPhase().isOpen; }

function getMockChain() {
  return {
    spot: 22143.5, expiry: "mock",
    strikes: [
      { strike: 21900, ce: { ltp:280, oi:180000, oiChange:15000, volume:210000 }, pe: { ltp:30,  oi:310000, oiChange:40000, volume:290000 } },
      { strike: 22000, ce: { ltp:210, oi:250000, oiChange:20000, volume:320000 }, pe: { ltp:55,  oi:280000, oiChange:35000, volume:270000 } },
      { strike: 22100, ce: { ltp:145, oi:200000, oiChange:25000, volume:300000 }, pe: { ltp:80,  oi:150000, oiChange:10000, volume:200000 } },
      { strike: 22150, ce: { ltp:120, oi:175000, oiChange:18000, volume:260000 }, pe: { ltp:100, oi:130000, oiChange: 8000, volume:180000 } },
      { strike: 22200, ce: { ltp:100, oi:220000, oiChange:30000, volume:350000 }, pe: { ltp:95,  oi:120000, oiChange:-5000, volume:150000 } },
      { strike: 22300, ce: { ltp:60,  oi:190000, oiChange:12000, volume:240000 }, pe: { ltp:140, oi: 90000, oiChange:-8000, volume:120000 } },
      { strike: 22400, ce: { ltp:30,  oi:160000, oiChange: 8000, volume:190000 }, pe: { ltp:195, oi: 70000, oiChange:-3000, volume: 90000 } }
    ]
  };
}

function calcOptionIntel(chain) {
  var spot = chain.spot, callZones=[], putZones=[], clusters=[], pcrByStrike=[], totalCE=0, totalPE=0, maxPainMap={};
  chain.strikes.forEach(function(row) {
    totalCE += row.ce.oi; totalPE += row.pe.oi;
    pcrByStrike.push({ strike:row.strike, pcr:parseFloat((row.pe.oi/(row.ce.oi||1)).toFixed(2)) });
    if (row.ce.oiChange>0 && row.strike>spot) callZones.push({ strike:row.strike, oi:row.ce.oi, oiChange:row.ce.oiChange });
    if (row.pe.oiChange>0 && row.strike<spot) putZones.push({ strike:row.strike, oi:row.pe.oi, oiChange:row.pe.oiChange });
    if (row.ce.oi+row.pe.oi>300000) clusters.push({ strike:row.strike, totalOI:row.ce.oi+row.pe.oi, dominant:row.ce.oi>row.pe.oi?"CE":"PE" });
    chain.strikes.forEach(function(s) {
      if (!maxPainMap[s.strike]) maxPainMap[s.strike]=0;
      maxPainMap[s.strike]+=Math.max(0,row.strike-s.strike)*row.ce.oi+Math.max(0,s.strike-row.strike)*row.pe.oi;
    });
  });
  var maxPain=parseInt(Object.keys(maxPainMap).reduce(function(a,b){return maxPainMap[a]<maxPainMap[b]?a:b;}));
  return { callWritingZones:callZones.sort(function(a,b){return b.oi-a.oi;}).slice(0,3), putWritingZones:putZones.sort(function(a,b){return b.oi-a.oi;}).slice(0,3), oiClusters:clusters.sort(function(a,b){return b.totalOI-a.totalOI;}).slice(0,3), pcrByStrike:pcrByStrike, maxPain:maxPain, overallPCR:parseFloat((totalPE/(totalCE||1)).toFixed(2)) };
}

function analyseStrike(strikePrice, chain, pcr, sentiment) {
  var spot=chain.spot, row=chain.strikes.find(function(r){return r.strike===strikePrice;});
  if (!row) return { confidence:0, action:"WAIT", reasons:["Strike not found"] };
  var reasons=[], score=50, distPct=Math.abs(strikePrice-spot)/spot*100;
  if (distPct<0.5){reasons.push("ATM strike - high gamma");score+=10;}
  else if(distPct<1){reasons.push("Near ATM");score+=5;}
  else{reasons.push("OTM strike");score-=10;}
  if(row.ce.oiChange>50000){reasons.push("Strong CE writing");score-=8;}
  if(row.pe.oiChange>50000){reasons.push("Strong PE writing");score+=8;}
  var strikePCR=row.pe.oi/(row.ce.oi||1);
  if(strikePCR>1.3){reasons.push("Bullish PCR at strike");score+=10;}
  else if(strikePCR<0.7){reasons.push("Bearish PCR at strike");score-=10;}
  if(sentiment.bias==="BULLISH"||sentiment.bias==="STRONGLY BULLISH"){reasons.push("Market bias bullish");score+=8;}
  else if(sentiment.bias==="BEARISH"||sentiment.bias==="STRONGLY BEARISH"){reasons.push("Market bias bearish");score-=8;}
  score=Math.max(10,Math.min(95,score));
  return { strike:strikePrice, confidence:score, action:score>=65?"BUY CE":score<=40?"BUY PE":"WAIT", reasons:reasons, strikePCR:parseFloat(strikePCR.toFixed(2)), ceOI:row.ce.oi, peOI:row.pe.oi };
}

function analyse(chain) {
  var pcr=calcPCR(chain), sentiment=calcSentiment(pcr), decision=getTradeDecision(chain,pcr,sentiment);
  return { timestamp:new Date().toISOString(), spot:chain.spot, expiry:chain.expiry, sr:findSupportResistance(chain), pcr:pcr, sentiment:sentiment, alphas:rankAlphaStrikes(chain), decision:decision };
}

// -- WebSocket --
function wsHandshake(req, socket) {
  var key=req.headers["sec-websocket-key"];
  var accept=crypto.createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n");
}
function wsEncode(data) {
  var msg=Buffer.from(data), len=msg.length;
  var buf=len<126?Buffer.allocUnsafe(2+len):Buffer.allocUnsafe(4+len);
  buf[0]=0x81;
  if(len<126){buf[1]=len;msg.copy(buf,2);}
  else{buf[1]=126;buf.writeUInt16BE(len,2);msg.copy(buf,4);}
  return buf;
}
function wsSend(socket, obj) { try{socket.write(wsEncode(JSON.stringify(obj)));}catch(e){} }
function broadcast(obj) { clients.forEach(function(s){wsSend(s,obj);}); }

server.on("upgrade", function(req, socket) {
  if(req.headers["upgrade"]!=="websocket"){socket.destroy();return;}
  wsHandshake(req, socket);
  clients.push(socket);
  console.log("WS connected, clients:"+clients.length);
  var r = lastResult || analyse(getMockChain());
  r.market = getMarketPhase();
  wsSend(socket, { type:"analysis", spot:r.spot, expiry:r.expiry, sr:r.sr, pcr:r.pcr, sentiment:r.sentiment, alphas:r.alphas, decision:r.decision, intel:r.intel||null, market:r.market, timestamp:r.timestamp });
  socket.on("close", function(){clients=clients.filter(function(s){return s!==socket;});});
  socket.on("error", function(){clients=clients.filter(function(s){return s!==socket;});});
});

// -- /push: browser sends NSE chain data --
app.post("/push", function(req, res) {
  var now = Date.now();
  if (now - lastPushTime < 5000) return res.json({ success:true, cached:true });
  var chain = req.body;
  if (!chain||!chain.strikes||!Array.isArray(chain.strikes)||chain.strikes.length<3)
    return res.status(400).json({ success:false, message:"Invalid chain" });
  try {
    var result = analyse(chain);
    result.intel = calcOptionIntel(chain);
    result.market = getMarketPhase();
    lastResult = result; lastPushTime = now;
    console.log("PUSH: spot="+result.spot+" bias="+result.sentiment.bias+" pcr="+result.pcr.overall.oiPCR+" strikes="+chain.strikes.length);
    broadcast({ type:"analysis", spot:result.spot, expiry:result.expiry, sr:result.sr, pcr:result.pcr, sentiment:result.sentiment, alphas:result.alphas, decision:result.decision, intel:result.intel, market:result.market, timestamp:result.timestamp });
    res.json({ success:true, spot:result.spot, bias:result.sentiment.bias });
  } catch(e) {
    console.error("Analyse error:", e.message);
    res.status(500).json({ success:false, message:e.message });
  }
});

// -- REST --
app.get("/", function(req,res){ res.json({ status:"EDGE Engine online", phase:3, clients:clients.length, market:getMarketPhase() }); });
app.get("/api/v1/market/status", function(req,res){ res.json(getMarketPhase()); });
app.get("/api/v1/dashboard", function(req,res) {
  var r = lastResult || analyse(getMockChain());
  res.json({ market:getMarketPhase(), analysis:{ timestamp:r.timestamp, spot:r.spot, expiry:r.expiry, sr:r.sr, pcr:r.pcr, sentiment:r.sentiment, alphas:r.alphas, decision:r.decision, intel:r.intel||null }, meta:{ dataSource:lastResult&&lastResult.expiry!=="mock"?"NSE_LIVE":"MOCK", lastUpdated:lastResult?lastResult.timestamp:null, clients:clients.length } });
});
app.get("/analysis", function(req,res) {
  var r = lastResult || analyse(getMockChain());
  res.json(Object.assign({}, r, { market:getMarketPhase() }));
});
app.post("/analyse-strike", function(req,res) {
  var strike=parseInt(req.body.strike), chain=req.body.chain;
  if(!strike||!chain) return res.status(400).json({ error:"strike and chain required" });
  if(!lastResult) return res.status(400).json({ error:"No analysis data yet" });
  try { res.json(analyseStrike(strike, chain, lastResult.pcr, lastResult.sentiment)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

server.listen(PORT, function() {
  console.log("EDGE Engine v3 on port "+PORT);
  console.log("Waiting for NSE data via browser /push ? no server-side fetch");
});
