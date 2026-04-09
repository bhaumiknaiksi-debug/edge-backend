// src/engine/optionIntelEngine.js
// Computes call/put writing zones, OI clusters, PCR trend data

function calcOptionIntel(chain, pcr) {
  var spot = chain.spot;
  var strikes = chain.strikes;

  // Call writing zones: strikes above spot with highest CE OI (writers are selling here = resistance)
  var callWriteZones = strikes
    .filter(function (r) { return r.strike >= spot; })
    .sort(function (a, b) { return b.ce.oi - a.ce.oi; })
    .slice(0, 4)
    .map(function (r) {
      return {
        strike: r.strike,
        ceOI: r.ce.oi,
        ceOIChange: r.ce.oiChange,
        ceLTP: r.ce.ltp,
        distance: r.strike - spot,
        distPct: parseFloat((((r.strike - spot) / spot) * 100).toFixed(2)),
        strength: r.ce.oiChange > 0 ? "BUILDING" : "UNWINDING",
      };
    });

  // Put writing zones: strikes below spot with highest PE OI (writers are selling here = support)
  var putWriteZones = strikes
    .filter(function (r) { return r.strike <= spot; })
    .sort(function (a, b) { return b.pe.oi - a.pe.oi; })
    .slice(0, 4)
    .map(function (r) {
      return {
        strike: r.strike,
        peOI: r.pe.oi,
        peOIChange: r.pe.oiChange,
        peLTP: r.pe.ltp,
        distance: spot - r.strike,
        distPct: parseFloat((((spot - r.strike) / spot) * 100).toFixed(2)),
        strength: r.pe.oiChange > 0 ? "BUILDING" : "UNWINDING",
      };
    });

  // OI Clusters: strikes with highest combined OI
  var oiClusters = strikes
    .map(function (r) {
      var total = r.ce.oi + r.pe.oi;
      return {
        strike: r.strike,
        totalOI: total,
        ceOI: r.ce.oi,
        peOI: r.pe.oi,
        dominant: r.ce.oi > r.pe.oi ? "CE" : "PE",
        ratio: parseFloat((r.pe.oi / (r.ce.oi || 1)).toFixed(2)),
        isAboveSpot: r.strike > spot,
      };
    })
    .sort(function (a, b) { return b.totalOI - a.totalOI; })
    .slice(0, 5);

  // PCR by strike (for PCR trend visualization)
  var pcrByStrike = strikes.map(function (r) {
    return {
      strike: r.strike,
      pcr: parseFloat((r.pe.oi / (r.ce.oi || 1)).toFixed(2)),
      isAboveSpot: r.strike > spot,
    };
  });

  // Max Pain calculation (strike where total premium loss to option buyers is highest)
  var maxPain = null;
  var maxPainVal = 0;
  strikes.forEach(function (r) {
    var pain = 0;
    strikes.forEach(function (s) {
      if (s.strike < r.strike) pain += s.ce.oi * (r.strike - s.strike);
      if (s.strike > r.strike) pain += s.pe.oi * (s.strike - r.strike);
    });
    if (pain > maxPainVal || maxPain === null) {
      maxPainVal = pain;
      maxPain = r.strike;
    }
  });

  return {
    callWriteZones: callWriteZones,
    putWriteZones: putWriteZones,
    oiClusters: oiClusters,
    pcrByStrike: pcrByStrike,
    maxPain: maxPain,
    overallPCR: pcr.overall.oiPCR,
    spotPrice: spot,
  };
}

module.exports = { calcOptionIntel };
