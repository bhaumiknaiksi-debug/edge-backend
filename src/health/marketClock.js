'use strict';

// NSE session start 09:15 IST (UTC+05:30); India does not use daylight savings.
// Uses date parts in Asia/Kolkata rather than constructing a fake "local" Date.
function nextMarketOpenIST(now = new Date(), holidays = new Set()) {
  const fields = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const today = Date.UTC(fields.year, fields.month - 1, fields.day);
  for (let offset = 0; offset < 14; offset++) {
    const utcDate = new Date(today + offset * 86400000);
    const iso = utcDate.toISOString().slice(0, 10);
    const dow = utcDate.getUTCDay();
    if (dow === 0 || dow === 6 || holidays.has(iso)) continue;
    // 09:15 IST corresponds to 03:45 UTC.
    const openUTC = utcDate.getTime() + 3 * 3600000 + 45 * 60000;
    if (openUTC > now.getTime()) return new Date(openUTC);
  }
  return null;
}
module.exports = { nextMarketOpenIST };
