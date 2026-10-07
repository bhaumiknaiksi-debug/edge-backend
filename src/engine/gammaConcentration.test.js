'use strict';
const assert=require('assert');
const {buildGammaConcentration}=require('./gammaConcentration');
const out=buildGammaConcentration([
 {strike:22500,ceGamma:.0004,peGamma:.0005,ceOI:10000,peOI:50000},
 {strike:22600,ceGamma:.0007,peGamma:.0007,ceOI:80000,peOI:60000},
 {strike:22700,ceGamma:.0005,peGamma:.0004,ceOI:90000,peOI:15000}
],22610);
assert.equal(out.available,true);assert.ok(out.callWall);assert.ok(out.putWall);assert.ok(out.topStrikes.length>0);
assert.ok(out.methodology.includes('does NOT infer'));
console.log('gammaConcentration tests passed');
