// src/data/optionChain.js - mock only (live fetch is in server.js now)

function getMockChain() {
  return {
    spot: 22143.5,
    expiry: "mock",
    strikes: [
      { strike: 21900, ce: { ltp: 280, oi: 180000, oiChange: 15000, volume: 210000 }, pe: { ltp: 30,  oi: 310000, oiChange: 40000, volume: 290000 } },
      { strike: 22000, ce: { ltp: 210, oi: 250000, oiChange: 20000, volume: 320000 }, pe: { ltp: 55,  oi: 280000, oiChange: 35000, volume: 270000 } },
      { strike: 22100, ce: { ltp: 145, oi: 200000, oiChange: 25000, volume: 300000 }, pe: { ltp: 80,  oi: 150000, oiChange: 10000, volume: 200000 } },
      { strike: 22150, ce: { ltp: 120, oi: 175000, oiChange: 18000, volume: 260000 }, pe: { ltp: 100, oi: 130000, oiChange:  8000, volume: 180000 } },
      { strike: 22200, ce: { ltp: 100, oi: 220000, oiChange: 30000, volume: 350000 }, pe: { ltp: 95,  oi: 120000, oiChange: -5000, volume: 150000 } },
      { strike: 22300, ce: { ltp: 60,  oi: 190000, oiChange: 12000, volume: 240000 }, pe: { ltp: 140, oi:  90000, oiChange: -8000, volume: 120000 } },
      { strike: 22400, ce: { ltp: 30,  oi: 160000, oiChange:  8000, volume: 190000 }, pe: { ltp: 195, oi:  70000, oiChange: -3000, volume:  90000 } }
    ]
  };
}

async function getOptionChain() { return getMockChain(); }

module.exports = { getOptionChain, getMockChain };
