'use strict';

const http = require('http');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWebServer } = require('../src/web/server');

function makeDeps(token) {
  const cfg = {
    mode: 'auto', manualScheme: 'BALANCED', idleThresholdMin: 5, idlePollMs: 2000,
    cpuHighPct: 70, cpuCooldownPct: 45, cpuHighHoldSec: 8, cpuCooldownHoldSec: 10, cpuEma: 0.3, cpuSampleMs: 1000,
    preferUltimate: true, minDwellSec: 15, autoStart: false, logLevel: 'info', version: 1, schemeMapping: {}, lastScheme: null,
  };
  const configStore = {
    getAll() { return JSON.parse(JSON.stringify(cfg)); },
    set(partial) { Object.assign(cfg, partial); return JSON.parse(JSON.stringify(cfg)); },
  };
  const orchestrator = {
    getRuntime() {
      return { state: 'BALANCED', manual: false, paused: false, available: ['SAVER', 'BALANCED', 'PERFORMANCE'], cpuEma: 12.3, idleMs: 1000, idleThresholdMs: 300000, isHigh: false, uptime: 5 };
    },
    command() {},
    on() {},
    emit() {},
  };
  return { configStore, orchestrator, token };
}

function doReq(port, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('GET /api/config 返回配置', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).mode, 'auto');
  } finally {
    await web.close();
  }
});

test('POST /api/config 无令牌 → 403', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'POST', '/api/config', { body: { cpuHighPct: 80 } });
    assert.equal(r.status, 403);
  } finally {
    await web.close();
  }
});

test('POST /api/config 带令牌保存并返回新配置', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'POST', '/api/config?t=tok', { body: { cpuHighPct: 80 } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).cpuHighPct, 80);
    assert.equal(configStore.getAll().cpuHighPct, 80);
  } finally {
    await web.close();
  }
});

test('GET /api/schema 有字段', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'GET', '/api/schema');
    assert.equal(r.status, 200);
    assert.ok(JSON.parse(r.body).fields.length > 0);
  } finally {
    await web.close();
  }
});

test('GET / 返回 html', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'GET', '/?t=tok');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Win-Boost'));
  } finally {
    await web.close();
  }
});

test('POST /api/autostart 回调被调用', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  let called = null;
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart: (v) => { called = v; } });
  try {
    const r = await doReq(web.port, 'POST', '/api/autostart?t=tok', { body: { value: true } });
    assert.equal(r.status, 200);
    assert.equal(called, true);
  } finally {
    await web.close();
  }
});

test('POST /api/mode auto 切换', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  let cmd = null;
  orchestrator.command = (c) => { cmd = c; };
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'POST', '/api/mode?t=tok', { body: { mode: 'auto' } });
    assert.equal(r.status, 200);
    assert.deepEqual(cmd, { kind: 'mode_auto' });
  } finally {
    await web.close();
  }
});

test('GET /api/metrics?range=1d 返回 points', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const historyRecorder = { queryByRange: (range) => (range === '1d' ? [{ t: 1, cpu: 1, scheme: 'BALANCED' }] : null) };
  const web = await createWebServer({ configStore, orchestrator, historyRecorder, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'GET', '/api/metrics?range=1d');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.range, '1d');
    assert.ok(Array.isArray(body.points));
    assert.equal(body.points.length, 1);
  } finally {
    await web.close();
  }
});

test('GET /api/metrics 非法 range → 400', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const historyRecorder = { queryByRange: () => null };
  const web = await createWebServer({ configStore, orchestrator, historyRecorder, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'GET', '/api/metrics?range=7d');
    assert.equal(r.status, 400);
  } finally {
    await web.close();
  }
});

test('GET /api/metrics 无 recorder 时返回空 points', async () => {
  const { configStore, orchestrator } = makeDeps('tok');
  const web = await createWebServer({ configStore, orchestrator, token: 'tok', logger: null, onAutostart() {} });
  try {
    const r = await doReq(web.port, 'GET', '/api/metrics?range=1d');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.points.length, 0);
  } finally {
    await web.close();
  }
});
