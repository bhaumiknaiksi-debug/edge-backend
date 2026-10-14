'use strict';
const fs=require('fs');const {Pool}=require('pg');
(async()=>{const connectionString=process.env.EDGE_DATA_DATABASE_URL||process.env.EDGE_PUSH_DATABASE_URL;if(!connectionString)throw new Error('Database configuration required');const p=new Pool({connectionString,connectionTimeoutMillis:10000});try{await p.query(fs.readFileSync(require.resolve('../src/storage/schema.sql'),'utf8'));console.log('Evidence and trade ledger schema ready');}finally{await p.end();}})().catch(()=>{console.error('Data migration failed');process.exitCode=1;});
