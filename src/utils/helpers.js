// src/utils/helpers.js

/**
 * Find the ATM (At The Money) strike closest to spot price
 */
function getATMStrike(strikes, spot) {
  return strikes.reduce((closest, row) => {
    return Math.abs(row.strike - spot) < Math.abs(closest.strike - spot)
      ? row
      : closest;
  });
}

/**
 * Round to nearest strike step (default 50 for NIFTY)
 */
function roundToStrike(price, step = 50) {
  return Math.round(price / step) * step;
}

/**
 * Format numbers for console output
 */
function fmt(n) {
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
  return n.toLocaleString("en-IN");
}

module.exports = { getATMStrike, roundToStrike, fmt };
