'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IdleMonitor } = require('../src/monitors/idle-monitor');
const { CpuMonitor } = require('../src/monitors/cpu-monitor');
const { LoadMonitor } = require('../src/monitors/load-monitor');
const { StateMachine } = require('../src/state/state-machine');
const { Scheme } = require('../src/constants');

test('IdleMonitor: setThreshold/setPollMs/lastIdleMs', () => {
  const m = new IdleMonitor({ idleThresholdMs: 999, pollMs: 60000 });
  m.setThreshold(5000);
  m.setPollMs(1000);
  assert.equal(m.thresholdMs, 5000);
  assert.equal(m.pollMs, 1000);
  assert.equal(m.lastIdleMs, 0); // 未 tick
});

test('CpuMonitor: setInterval/setEma/lastPct', () => {
  let t = 0;
  const m = new CpuMonitor({ intervalMs: 999, ema: 0.3, now: () => t });
  m.setInterval(500);
  m.setEma(0.5);
  assert.equal(m.intervalMs, 500);
  assert.equal(m.emaAlpha, 0.5);
  assert.equal(m.lastPct, 0);
});

test('LoadMonitor: applyThresholds 重建并保留 high 态', () => {
  let t = 0;
  const cfg = { cpuHighPct: 70, cpuCooldownPct: 45, cpuHighHoldSec: 0, cpuCooldownHoldSec: 0, pdhHighPct: 130, pdhHoldSec: 0, pdhEnabled: false, jankPerMin: 20, jankHoldSec: 0, jankEnabled: false };
  const m = new LoadMonitor({ cfg, now: () => t });
  // 滞回需两次采样 + 时间推进才翻转（与 hysteresis.test 一致）
  m.feedCpu(80);
  t += 100;
  m.feedCpu(80);
  assert.equal(m.isHigh, true);
  m.applyThresholds({ ...cfg, cpuHighPct: 90, cpuCooldownPct: 50 });
  assert.equal(m.isHigh, true); // 保留
  assert.equal(m.cpuActive, true);
});

test('LoadMonitor: applyThresholds 暴露运行态', () => {
  let t = 0;
  const m = new LoadMonitor({ cfg: { cpuHighPct: 70, cpuCooldownPct: 45, cpuHighHoldSec: 0, cpuCooldownHoldSec: 0, pdhHighPct: 130, pdhHoldSec: 0, pdhEnabled: false, jankPerMin: 20, jankHoldSec: 0, jankEnabled: false }, now: () => t });
  assert.equal(typeof m.cpuActive, 'boolean');
  assert.equal(typeof m.pdhActive, 'boolean');
});

test('LoadMonitor: feedPdh 滞回翻转（PDH 副判据）', () => {
  let t = 0;
  // PDH 独立判据：cpu 关闭，仅 PDH 生效
  const m = new LoadMonitor({
    cfg: { cpuHighPct: 200, cpuCooldownPct: 0, cpuHighHoldSec: 0, cpuCooldownHoldSec: 0, pdhHighPct: 130, pdhHoldSec: 0, pdhEnabled: true },
    now: () => t,
  });
  // perfPct=150（≥130 且 >100 死区外）两次 + 时间推进 → 进入 high
  m.feedPdh(150);
  assert.equal(m.pdhActive, false); // 首次仅建立候选
  t += 100;
  m.feedPdh(150);
  assert.equal(m.pdhActive, true);
  assert.equal(m.isHigh, true); // PDH 升起整体 high
  assert.equal(m.pdhPerfPct, 150);
  // 回落到 100（标称，≤exit）→ 退出（退出也需两次采样建立候选，与进入对称）
  t += 100;
  m.feedPdh(100); // 建立退出候选
  t += 100;
  m.feedPdh(100); // 满足 hold → 翻转退出
  assert.equal(m.pdhActive, false);
  assert.equal(m.isHigh, false);
  // null（PDH 不可用）→ 强制非 high
  m.feedPdh(null);
  assert.equal(m.pdhActive, false);
});

test('LoadMonitor: applyThresholds 保留 PDH 态', () => {
  let t = 0;
  const cfg = { cpuHighPct: 200, cpuCooldownPct: 0, cpuHighHoldSec: 0, cpuCooldownHoldSec: 0, pdhHighPct: 130, pdhHoldSec: 0, pdhEnabled: true, jankPerMin: 20, jankHoldSec: 0, jankEnabled: false };
  const m = new LoadMonitor({ cfg, now: () => t });
  m.feedPdh(150);
  t += 100;
  m.feedPdh(150);
  assert.equal(m.pdhActive, true);
  m.applyThresholds({ ...cfg, pdhHighPct: 140 });
  assert.equal(m.pdhActive, true); // 热重载不误翻转
  assert.equal(typeof m.pdhPerfPct, 'number');
});

test('LoadMonitor: feedJank 滞回翻转（Jank 副判据）', () => {
  let t = 0;
  // Jank 独立判据：其余两路关闭
  const m = new LoadMonitor({
    cfg: { cpuHighPct: 200, cpuCooldownPct: 0, cpuHighHoldSec: 0, cpuCooldownHoldSec: 0, pdhHighPct: 9999, pdhHoldSec: 0, pdhEnabled: false, jankPerMin: 20, jankHoldSec: 0, jankEnabled: true },
    now: () => t,
  });
  // janks=30（≥20）两次 + 时间推进 → 进入 high
  m.feedJank(30);
  assert.equal(m.jankActive, false); // 首次仅建立候选
  t += 100;
  m.feedJank(30);
  assert.equal(m.jankActive, true);
  assert.equal(m.isHigh, true); // Jank 升起整体 high
  assert.equal(m.janksPerMin, 30);
  // 回落到 0（≤exit）→ 退出（退出也需两次采样）
  t += 100;
  m.feedJank(0);
  t += 100;
  m.feedJank(0);
  assert.equal(m.jankActive, false);
  assert.equal(m.isHigh, false);
  // null（未启用/不可用）→ 强制非 high
  m.feedJank(null);
  assert.equal(m.jankActive, false);
});

test('LoadMonitor: applyThresholds 保留 Jank 态', () => {
  let t = 0;
  const cfg = { cpuHighPct: 200, cpuCooldownPct: 0, cpuHighHoldSec: 0, cpuCooldownHoldSec: 0, pdhHighPct: 9999, pdhHoldSec: 0, pdhEnabled: false, jankPerMin: 20, jankHoldSec: 0, jankEnabled: true };
  const m = new LoadMonitor({ cfg, now: () => t });
  m.feedJank(30);
  t += 100;
  m.feedJank(30);
  assert.equal(m.jankActive, true);
  m.applyThresholds({ ...cfg, jankPerMin: 25 });
  assert.equal(m.jankActive, true); // 热重载不误翻转
  assert.equal(typeof m.janksPerMin, 'number');
});

test('StateMachine: setPreferUltimate/setMinDwellMs', () => {
  let t = 0;
  const sm = new StateMachine({ cfg: { minDwellSec: 0, preferUltimate: true }, available: [Scheme.SAVER, Scheme.BALANCED, Scheme.PERFORMANCE, Scheme.ULTIMATE], now: () => t });
  sm.init(Scheme.BALANCED);
  assert.equal(sm.feed({ type: 'load_high' }), Scheme.ULTIMATE);
  sm.setPreferUltimate(false);
  sm.init(Scheme.BALANCED);
  assert.equal(sm.feed({ type: 'load_high' }), Scheme.PERFORMANCE);
  sm.setMinDwellMs(100000);
  sm.init(Scheme.BALANCED);
  t = 1000;
  assert.equal(sm.feed({ type: 'load_high' }), null); // 被 dwell 抑制
});
