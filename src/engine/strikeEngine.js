function rankAlphaStrikes(chain) {
  return chain.strikes.map(row => {
    const prox = 1 / (1 + Math.abs(row.strike - chain.spot) / 100);
    return { strike: row.strike, totalScore: Math.round((row.ce.oi + row.pe.oi) * prox), dominant: row.ce.oi > row.pe.oi ? "CE" : "PE", ceOI: row.ce.oi, peOI: row.pe.oi, ceLTP: row.ce.ltp, peLTP: row.pe.ltp };
  }).sort((a, b) => b.totalScore - a.totalScore).slice(0, 3).map((r, i) => ({ rank: i + 1, ...r }));
}
module.exports = { rankAlphaStrikes };
