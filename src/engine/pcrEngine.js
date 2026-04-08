function calcPCR(chain) {
  let totalCeOI = 0, totalPeOI = 0, totalCeVol = 0, totalPeVol = 0;
  for (const row of chain.strikes) {
    totalCeOI += row.ce.oi; totalPeOI += row.pe.oi;
    totalCeVol += row.ce.volume; totalPeVol += row.pe.volume;
  }
  return { overall: { oiPCR: parseFloat((totalPeOI / (totalCeOI || 1)).toFixed(2)), volPCR: parseFloat((totalPeVol / (totalCeVol || 1)).toFixed(2)), totalCeOI, totalPeOI } };
}
module.exports = { calcPCR };
