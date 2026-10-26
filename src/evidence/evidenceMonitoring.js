'use strict';

const { buildEvidenceHealth } = require('./evidenceHealth');

// Monitoring only. No selector, trade permissions, evidence writes or harvests are invoked.
function registerEvidenceMonitoring(app, {
  store, archive, postgresPrimary, getSnapshots, getLastPollAt, isInitialized,
  harvester, researchHarvester, collectionMode, now = () => new Date()
}) {
  app.get('/evidence/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const report = buildEvidenceHealth({
      rows:getSnapshots(), storage:store.status(),
      archive:postgresPrimary ? {configured:false,provider:'POSTGRES_PRIMARY'} : archive.status(),
      harvester:harvester.getStatus(), researchHarvester:researchHarvester.getStatus(),
      initialized:isInitialized(), collectionMode, lastPollAt:getLastPollAt(), now:now()
    });
    res.status(report.healthy ? 200 : 503).json(report);
  });

  app.get('/evidence/storage/verify', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isInitialized()) return res.status(503).json({ok:false,error:'EVIDENCE_INITIALIZING'});
    if (!postgresPrimary) return res.status(409).json({ok:false,error:'POSTGRES_NOT_PRIMARY',
      verificationPath:'/evidence/archive/verify',method:'POST'});
    try {
      const rows = getSnapshots();
      const report = await store.verify(rows[rows.length - 1]);
      res.status(report.ok ? 200 : 503).json(report);
    } catch (_) {
      res.status(503).json({ok:false,error:'DATABASE_VERIFICATION_FAILED'});
    }
  });
}

module.exports = { registerEvidenceMonitoring };
