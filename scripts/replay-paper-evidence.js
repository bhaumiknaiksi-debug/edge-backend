#!/usr/bin/env node
'use strict';
// Local files in, JSON report out. Never fetches data or accepts broker credentials.
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {replayEvidence}=require('../src/replay/paperEvidence');
function main(args) {
  const allowed=new Set(['--input','--quotes','--instruments','--tier','--reconstruct-plans']);
  const options={};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(!allowed.has(arg) || options[arg]!==undefined)throw Error('INVALID_ARGUMENTS');
    if(arg==='--reconstruct-plans')options[arg]=true;
    else {if(!args[i+1] || args[i+1].startsWith('--'))throw Error('MISSING_ARGUMENT');options[arg]=args[++i];}
  }
  if(!options['--input'])throw Error('INPUT_REQUIRED');
  const raw=fs.readFileSync(options['--input'],'utf8');
  const read=flag=>options[flag]?JSON.parse(fs.readFileSync(options[flag],'utf8')):[];
  return {inputSha256:createHash('sha256').update(raw).digest('hex'),...replayEvidence(JSON.parse(raw),{
    tier:options['--tier']||'C',quotes:read('--quotes'),instruments:read('--instruments'),reconstructPlans:options['--reconstruct-plans']===true})};
}
if(require.main===module) {
  try {process.stdout.write(JSON.stringify(main(process.argv.slice(2)),null,2)+'\n');}
  catch(error){process.stderr.write('Paper replay failed: '+error.message+'\n');process.exitCode=1;}
}
module.exports={main};
