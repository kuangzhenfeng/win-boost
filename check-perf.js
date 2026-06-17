const os = require('os');
const fs = require('fs');
const path = require('path');
const dir = path.join(os.tmpdir(), `wb-check-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
process.env.APPDATA = dir;

const { EventEmitter } = require('events');
const { Orchestrator } = require('./src/orchestrator');
const { HistoryRecorder } = require('./src/metrics/history-recorder');
const cfg = require('./src/config/defaults.json');
console.log('defaults pdh 字段:', { pdhEnabled: cfg.pdhEnabled, pdhHighPct: cfg.pdhHighPct, pdhPollMs: cfg.pdhPollMs, pdhHoldSec: cfg.pdhHoldSec });

const power = {
  available: ['SAVER','BALANCED','PERFORMANCE','ULTIMATE'],
  async getCurrent() { return { scheme: 'BALANCED' }; },
  async setActive() { return { changed: true }; },
};
const tray = Object.assign(new EventEmitter(), { refresh(){}, setAutostart(){} });

(async () => {
  const orch = new Orchestrator({ cfg, power, tray, logger: null });
  await orch.start();
  await new Promise(r => setTimeout(r, 2600));
  console.log('getRuntime pdhPerfPct =', orch.getRuntime().pdhPerfPct);
  const rec = new HistoryRecorder({ orchestrator: orch, logger: null });
  rec.start();
  await new Promise(r => setTimeout(r, 2600));
  const pts = rec.queryByRange('1h');
  console.log('points =', pts.length, ' 有perf>0:', pts.filter(p=>p.perf>0).length);
  console.log('末3点:', JSON.stringify(pts.slice(-3)));
  rec.stop(); orch.stop(); process.exit(0);
})();
