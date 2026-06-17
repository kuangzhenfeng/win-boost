'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createWebServer } = require('../src/web/server');

// 端到端：真实 server + 真实 ConfigStore + 真实 Orchestrator（桩 power/tray，避开原生）
const { EventEmitter } = require('events');
const { ConfigStore } = require('../src/config/config-store');
const { Orchestrator } = require('../src/orchestrator');
const { Scheme } = require('../src/constants');
const path = require('path');
const fs = require('fs');

function makeStores() {
  // 用临时配置目录，避免污染真实配置
  const tmpDir = path.join(require('os').tmpdir(), `wb-e2e-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const cfgPath = path.join(tmpDir, 'config.json');
  // 写默认配置种子
  const { DEFAULT_CONFIG } = require('../src/constants');
  fs.writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG));
  process.env.APPDATA = tmpDir; // ConfigStore 用 APPDATA 定位
  const cs = new ConfigStore({ logger: null });
  cs.load();
  return { cs, tmpDir };
}

function makeOrch(cfg) {
  const power = {
    available: ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE'],
    async getCurrent() { return { scheme: Scheme.BALANCED }; },
    async setActive(s) { return { changed: true, scheme: s }; },
  };
  const tray = Object.assign(new EventEmitter(), { refresh() {}, setAutostart() {} });
  return new Orchestrator({ cfg, power, tray, logger: null });
}

function doReq(port, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (token) headers['x-wb-token'] = token;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('端到端：保存配置→热重载→SSE 推送', async () => {
  const { cs } = makeStores();
  const orch = makeOrch(cs.getAll());
  await orch.start();
  // 接线配置变更→热重载（与 main.js 组合根一致；web server 本身不耦合 orchestrator）
  cs.on('change', (cfg) => orch.applyConfig(cfg));
  const web = await createWebServer({ configStore: cs, orchestrator: orch, token: 'T', logger: null, onAutostart() {} });
  try {
    // 1) 保存 cpuHighPct=88，带令牌
    const save = await doReq(web.port, 'POST', '/api/config', { body: { cpuHighPct: 88 }, token: 'T' });
    assert.equal(save.status, 200);
    assert.equal(JSON.parse(save.body).cpuHighPct, 88);
    // 热重载已生效：LoadMonitor 的 CPU 滞回 enter 阈值应变
    assert.equal(orch._load._cpu._enter, 88);

    // 2) 类型非法（字符串）被 ConfigStore 拒绝，值保持
    const bad = await doReq(web.port, 'POST', '/api/config', { body: { cpuHighPct: 'oops' }, token: 'T' });
    assert.equal(JSON.parse(bad.body).cpuHighPct, 88);

    // 3) 无令牌 → 403
    const noAuth = await doReq(web.port, 'POST', '/api/config', { body: { cpuHighPct: 70 } });
    assert.equal(noAuth.status, 403);

    // 4) SSE 首帧含 runtime（收到即销毁连接，避免悬挂）
    const sseFirst = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: web.port, path: '/api/status/stream' }, (res) => {
        res.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const ln of lines) {
            if (ln.startsWith('data:')) {
              const parsed = JSON.parse(ln.slice(5).trim());
              res.destroy();
              resolve(parsed);
              return;
            }
          }
        });
      });
      r.on('error', () => resolve(null));
      r.end();
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(sseFirst && sseFirst.type === 'runtime');
    assert.equal(sseFirst.runtime.state, 'BALANCED');

    // 5) mode 切手动锁 SAVER
    const mode = await doReq(web.port, 'POST', '/api/mode', { body: { mode: 'manual', scheme: 'SAVER' }, token: 'T' });
    assert.equal(mode.status, 200);
    assert.equal(JSON.parse(mode.body).runtime.state, 'SAVER');
  } finally {
    await web.close();
    orch.stop();
  }
});
