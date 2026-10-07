'use strict';
const assert = require('assert');
const { buildSignalTier } = require('./signalTier');

const base={
  setup:{qualified:true},
  risk:{status:'READY'},
  position:{status:'READY'},
  strategy:'BEAR_PUT_SPREAD',
  regime:{direction:'BEARISH'},
  marketPhase:'OPEN',
  chartIntelligence:{verdict:'BEARISH'}
};

let x=buildSignalTier({...base,
  orchestration:{status:'READY_TO_EXECUTE'},
  entry:{triggerReady:true,priceReady:true,liquidityReady:true}
});
assert.equal(x.tier,'A');
assert.equal(x.executionAllowed,true);

x=buildSignalTier({...base,
  orchestration:{status:'WAIT_FOR_LIQUIDITY'},
  entry:{triggerReady:true,priceReady:true,liquidityReady:false}
});
assert.equal(x.tier,'B');
assert.equal(x.executionAllowed,false);
assert.equal(x.researchOnly,true);

x=buildSignalTier({...base,
  orchestration:{status:'NO_TRADE'},
  entry:{triggerReady:false,priceReady:true,liquidityReady:false}
});
assert.equal(x.tier,'C');
assert.equal(x.executionAllowed,false);

x=buildSignalTier({...base,
  orchestration:{status:'NO_TRADE'},
  chartIntelligence:{verdict:'BULLISH'},
  entry:{triggerReady:true,priceReady:true,liquidityReady:false}
});
assert.notEqual(x.tier,'B');
console.log('signalTier tests passed');
