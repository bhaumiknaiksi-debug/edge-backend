'use strict';
const { Pool } = require('pg');
function createDatabase(env = process.env) {
  const connectionString = env.EDGE_DATA_DATABASE_URL || env.EDGE_PUSH_DATABASE_URL;
  if (!connectionString) return null;
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 15000, statement_timeout: 10000 });
  pool.on('error', () => console.error('[data store] idle database connection failed'));
  return pool;
}
module.exports = { createDatabase };
