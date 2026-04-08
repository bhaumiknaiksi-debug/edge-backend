// src/engine/pcrEngine.js
// PCR = Put OI / Call OI
// PCR > 1.2 → Bullish (more puts = market expects support)
// PCR < 0.8 → Bearish (more calls = market expects resistance)
// PCR 0.8–1.2 → Neutral

function calcPCR(chain) {
let totalCeOI = 0;
let totalPeOI = 0;
let totalCeVol = 0;
let totalPeVol = 0;

const strikesPCR = chain.strikes.map(row => {
totalCeOI  += row.ce.oi;
totalPeOI  += row.pe.oi;
totalCeVol += row.ce.volume;
totalPeVol += row.pe.volume;

```
const oiPCR  = row.pe.oi     / (row.ce.oi     || 1);
const volPCR = row.pe.volume / (row.ce.volume  || 1);

return {
  strike: row.strike,
  oiPCR:  parseFloat(oiPCR.toFixed(2)),
  volPCR: parseFloat(volPCR.toFixed(2))
};
```

});

const overallOIPCR  = parseFloat((totalPeOI  / (totalCeOI  || 1)).toFixed(2));
const overallVolPCR = parseFloat((totalPeVol / (totalCeVol || 1)).toFixed(2));

return {
overall: {
oiPCR:  overallOIPCR,
volPCR: overallVolPCR,
totalCeOI,
totalPeOI
},
strikes: strikesPCR
};
}

module.exports = { calcPCR };
