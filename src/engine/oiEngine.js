function findSupportResistance(chain) {
  let support = null, resistance = null;
  for (const row of chain.strikes) {
    if (row.strike <= chain.spot && (!support || row.pe.oi > support.pe.oi)) support = row;
    if (row.strike >= chain.spot && (!resistance || row.ce.oi > resistance.ce.oi)) resistance = row;
  }
  const atm = chain.strikes.reduce((c, r) => Math.abs(r.strike - chain.spot) < Math.abs(c.strike - chain.spot) ? r : c);
  return { support: { strike: support?.strike, peOI: support?.pe.oi }, resistance: { strike: resistance?.strike, ceOI: resistance?.ce.oi }, atmStrike: atm.strike };
}
module.exports = { findSupportResistance };
