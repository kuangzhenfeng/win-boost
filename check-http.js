const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const dir = path.join(os.tmpdir(), `wb-http-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
process.env.APPDATA = dir;

const { EventEmitter } = require('events');
const { Orchestrator } = require('./src/orchestrator');
const { HistoryRecorder } = require('./src/metrics/history-recorder');
const { createWebServer } = require('./src/web/server');
const cfg = require('./src/config/defaults.json');

const power = { available:['SAVER','BALANCED','PERFORMANCE','ULTIMATE'], async getCurrent(){return{scheme:'BALANCED'};}, async setActive(){return{changed:true};} };
const tray = Object.assign(new EventEmitter(), { refresh(){}, setAutostart(){} });

function get(port, p) {
  return new Promise((res, rej) => {
    http.get({host:'127.0.0.1', port, path:p}, (r) => {
      let b=''; r.on('data',d=>b+=d); r.on('end',()=>res(b));
    }).on('error', rej);
  });
}

(async () => {
  const orch = new Orchestrator({ cfg, power, tray, logger: null });
  await orch.start();
  const history = new HistoryRecorder({ orchestrator: orch, logger: null });
  history.start();
  const web = await createWebServer({ configStore:{getAll:()=>cfg,set:()=>cfg}, orchestrator: orch, historyRecorder: history, token:'t', logger:null, onAutostart(){} });
  // 跑 3 秒采几秒数据
  await new Promise(r => setTimeout(r, 3000));
  for (const range of ['1h','1d','30d']) {
    const body = await get(web.port, `/api/metrics?range=${range}`);
    const j = JSON.parse(body);
    const pts = j.points || [];
    const withPerf = pts.filter(p => p.perf != null && p.perf !== 0).length;
    console.log(`range=${range} 总点=${pts.length} perf非零=${withPerf}`);
    if (pts.length) console.log('  末点:', JSON.stringify(pts[pts.length-1]));
  }
  await web.close(); history.stop(); orch.stop(); process.exit(0);
})();
