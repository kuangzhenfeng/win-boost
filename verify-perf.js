const os = require('os');
const fs = require('fs');
const path = require('path');
// 临时 APPDATA，完全隔离，不碰用户真实 metrics.json
const dir = path.join(os.tmpdir(), `wb-verify-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
process.env.APPDATA = dir;

const { EventEmitter } = require('events');
const { Orchestrator } = require('./src/orchestrator');
const { HistoryRecorder } = require('./src/metrics/history-recorder');
const cfg = require('./src/config/defaults.json');
const power = { available:['SAVER','BALANCED','PERFORMANCE','ULTIMATE'], async getCurrent(){return{scheme:'BALANCED'};}, async setActive(){return{changed:true};} };
const tray = Object.assign(new EventEmitter(), { refresh(){}, setAutostart(){} });

(async () => {
  const orch = new Orchestrator({ cfg, power, tray, logger: null });
  await orch.start();
  const rec = new HistoryRecorder({ orchestrator: orch, logger: null });
  rec.start();
  console.log('真实 orchestrator 已启动，等待 75 秒（触发分钟边界 fold）...');
  await new Promise(r => setTimeout(r, 75000));
  const mins = rec.queryByRange('1d');
  console.log('\n=== 1d 维度 minute 桶 ===');
  console.log('minute 点数:', mins.length);
  const withPerf = mins.filter(p => p.perf != null && p.perf !== 0).length;
  console.log('带 perf(非0) 的点:', withPerf, '/', mins.length);
  if (mins.length) {
    console.log('末2点:', JSON.stringify(mins.slice(-2), null, 0));
  }
  console.log('\n结论:', withPerf > 0 ? '✓ minute 桶确实带 perf，重启后图表会有值' : '✗ 仍有问题');
  rec.stop(); orch.stop(); process.exit(0);
})();
