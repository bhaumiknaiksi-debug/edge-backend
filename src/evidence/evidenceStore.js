'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 10000;

function resolveEvidencePath() {
  if (process.env.EDGE_EVIDENCE_PATH) return process.env.EDGE_EVIDENCE_PATH;
  if (fs.existsSync('/var/data')) return '/var/data/edge-evidence.jsonl';
  return path.join(process.cwd(), '.edge-data', 'edge-evidence.jsonl');
}

function createEvidenceStore({ filePath = resolveEvidencePath(), limit = DEFAULT_LIMIT } = {}) {
  const durable = !!process.env.EDGE_EVIDENCE_PATH || filePath.startsWith('/var/data/');
  let writeError = null;

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function load() {
    try {
      ensureDir();
      if (!fs.existsSync(filePath)) return [];
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
    } catch (err) {
      writeError = err.message;
      return [];
    }
  }

  function append(record) {
    try {
      ensureDir();
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
      writeError = null;
      return true;
    } catch (err) {
      writeError = err.message;
      return false;
    }
  }

  function status() {
    return { filePath, durable, writeError };
  }

  return { load, append, status };
}

module.exports = { createEvidenceStore, resolveEvidencePath };
