'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Orchestrator } = require('../src/orchestrator');
const { Scheme } = require('../src/constants');

// 简化桩：power/tray 都是假对象，避免触碰原生/子进程。
// tray 必须是 EventEmitter（orchestrator.start 会 tray.on('command')）。
const { EventEmitter } = require('events');
function makeOrch(cfg) {
  const power = {
    available: ['SAVER', 'BALANCED', 'PERFORMANCE'],
    async getCurrent() {
      return { scheme: Scheme.BALANCED };
    },
    async setActive(s) {
      return { changed: true, scheme: s };
    },
  };
  const tray = Object.assign(new EventEmitter(), { refresh() {}, setAutostart() {} });
  const orch = new Orchestrator({ cfg, power, tray, logger: null });
  return { orch, power };
}

function baseCfg(over = {}) {
  return {
    mode: 'auto',
    manualScheme: Scheme.BALANCED,
    idleThresholdMin: 5,
    idlePollMs: 2000,
    cpuHighPct: 70,
    cpuCooldownPct: 45,
    cpuHighHoldSec: 8,
    cpuCooldownHoldSec: 10,
    cpuEma: 0.3,
    cpuSampleMs: 1000,
    pdhEnabled: true,
    pdhHighPct: 130,
    pdhHoldSec: 8,
    pdhPollMs: 1000,
    jankEnabled: true,
    jankPerMin: 20,
    jankHoldSec: 8,
    preferUltimate: true,
    minDwellSec: 15,
    ...over,
  };
}

test('applyConfig 更新 monitor/state-machine 参数', async () => {
  const { orch } = makeOrch(baseCfg());
  await orch.start();
  orch.applyConfig(baseCfg({ cpuHighPct: 88, idleThresholdMin: 10, preferUltimate: false, minDwellSec: 30, pdhHighPct: 140, jankPerMin: 25 }));
  assert.equal(orch._load._cpu._enter, 88);
  assert.equal(orch._idle.thresholdMs, 10 * 60 * 1000);
  assert.equal(orch._sm._preferUltimate, false);
  assert.equal(orch._sm._minDwellMs, 30000);
  assert.equal(orch._load._pdh._enter, 140); // PDH 阈值热重载生效
  assert.equal(orch._load._jank._enter, 25); // Jank 阈值热重载生效
  orch.stop();
});

test('applyConfig 切换 manual→auto 恢复自动', async () => {
  const { orch } = makeOrch(baseCfg({ mode: 'manual', manualScheme: Scheme.PERFORMANCE, minDwellSec: 0 }));
  await orch.start();
  assert.equal(orch._paused, true);
  orch.applyConfig(baseCfg({ mode: 'auto', manualScheme: Scheme.PERFORMANCE, minDwellSec: 0 }));
  assert.equal(orch._paused, false);
  assert.equal(orch._sm.isManual, false);
  orch.stop();
});

test('getRuntime 返回完整运行态', async () => {
  const { orch } = makeOrch(baseCfg());
  await orch.start();
  const r = orch.getRuntime();
  for (const k of ['state', 'manual', 'paused', 'available', 'cpuEma', 'idleMs', 'idleThresholdMs', 'pdhPerfPct', 'janksPerMin', 'isHigh', 'uptime']) {
    assert.ok(k in r, `缺 ${k}`);
  }
  orch.stop();
});

test('command 走 mode_auto/manual/pause', async () => {
  const { orch } = makeOrch(baseCfg({ mode: 'manual', manualScheme: Scheme.BALANCED }));
  await orch.start();
  orch.command({ kind: 'mode_auto' });
  assert.equal(orch._paused, false);
  orch.command({ kind: 'pause', value: true });
  assert.equal(orch._paused, true);
  orch.command({ kind: 'manual', scheme: Scheme.SAVER });
  assert.equal(orch._sm.state, Scheme.SAVER);
  orch.stop();
});

test('状态变化 emit runtime 事件', async () => {
  const { orch } = makeOrch(baseCfg({ mode: 'manual', manualScheme: Scheme.BALANCED, minDwellSec: 0 }));
  await orch.start();
  let got = null;
  orch.on('runtime', (r) => { got = r; });
  // applyConfig 末尾会 _refreshTray → emit runtime
  orch.applyConfig(baseCfg({ mode: 'manual', manualScheme: Scheme.PERFORMANCE, minDwellSec: 0 }));
  assert.ok(got !== null);
  assert.equal(got.state, Scheme.PERFORMANCE);
  orch.stop();
});
