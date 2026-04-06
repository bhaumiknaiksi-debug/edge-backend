// src/engine/oiEngine.js
// Finds Support (max PE OI below spot) and Resistance (max CE OI above spot)

const { getATMStrike, fmt } = require("../utils/helpers");

function findSupportResistance(chain) {
  let support    = null;
  let resistance = null;

  for (const row of chain.strikes) {
    // Support = highest PE OI at or below spot (bulls defending)
    if (row.strike <= chain.spot) {
      if (!support || row.pe.oi > support.pe.oi) {
        support = row;
      }
    }

    // Resistance = highest CE OI at or above spot (bears defending)
    if (row.strike >= chain.spot) {
      if (!resistance || row.ce.oi > resistance.ce.oi) {
        resistance = row;
      }
    }
  }

  return {
    support: {
      strike: support?.strike ?? null,
      peOI:   support?.pe.oi ?? 0,
      peOIChange: support?.pe.oiChange ?? 0
    },
    resistance: {
      strike: resistance?.strike ?? null,
      ceOI:   resistance?.ce.oi ?? 0,
      ceOIChange: resistance?.ce.oiChange ?? 0
    },
    atmStrike: getATMStrike(chain.strikes, chain.spot)?.strike ?? null
  };
}

module.exports = { findSupportResistance };
