// src/engine/strikeEngine.js
// Ranks strikes by OI conviction strength
// Alpha Strike = highest OI + highest OI buildup (oiChange) near ATM

function rankAlphaStrikes(chain) {
  const spot = chain.spot;

  const scored = chain.strikes.map(row => {
    const distFromSpot = Math.abs(row.strike - spot);
    const proximity    = 1 / (1 + distFromSpot / 100); // closer = higher score

    // CE side score (resistance strength)
    const ceScore = (row.ce.oi * 0.6 + Math.max(row.ce.oiChange, 0) * 0.4) * proximity;

    // PE side score (support strength)
    const peScore = (row.pe.oi * 0.6 + Math.max(row.pe.oiChange, 0) * 0.4) * proximity;

    // Combined conviction
    const totalScore = ceScore + peScore;

    // Dominant side
    const dominant = row.ce.oi > row.pe.oi ? "CE" : "PE";

    return {
      strike:     row.strike,
      ceScore:    Math.round(ceScore),
      peScore:    Math.round(peScore),
      totalScore: Math.round(totalScore),
      dominant,
      ceOI:       row.ce.oi,
      peOI:       row.pe.oi,
      ceOIChange: row.ce.oiChange,
      peOIChange: row.pe.oiChange
    };
  });

  // Sort by total score descending, return top 3
  const ranked = scored
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 3)
    .map((row, i) => ({ rank: i + 1, ...row }));

  return ranked;
}

module.exports = { rankAlphaStrikes };
