'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JankMonitor } = require('../src/monitors/jank-monitor');

// 纯逻辑验证：注入 now()，手动 _tick()，避免真实定时器
// 默认 HEARTBEAT_MS=20, JITTER_THRESHOLD_MS=40（即 gap>60ms 计卡顿）, WINDOW_MS=60000

test('JankMonitor: 正常心跳序列不产生卡顿', () => {
  const seq = [0, 20, 40, 60, 80, 100];
  let i = 0;
  const m = new JankMonitor({ now: () => seq[Math.min(i, seq.length - 1)] });
  for (i = 0; i < seq.length; i++) m._tick();
  assert.equal(m.janksPerMin, 0);
});

test('JankMonitor: gap>60ms 计为一次卡顿', () => {
  const seq = [0, 20, 100, 120]; // 0→20（正常）, 20→100（gap80>60 卡顿）, 100→120（正常）
  let i = 0;
  const m = new JankMonitor({ now: () => seq[Math.min(i, seq.length - 1)] });
  for (i = 0; i < seq.length; i++) m._tick();
  assert.equal(m.janksPerMin, 1);
});

test('JankMonitor: 多次卡顿累加', () => {
  const seq = [0, 20, 90, 160, 230]; // 70/70/70 三次卡顿
  let i = 0;
  const m = new JankMonitor({ now: () => seq[Math.min(i, seq.length - 1)] });
  for (i = 0; i < seq.length; i++) m._tick();
  assert.equal(m.janksPerMin, 3);
});

test('JankMonitor: 滚动窗口剔除 60s 外的旧卡顿', () => {
  // 直接塞入一条窗口外的旧卡顿记录，再以正常 gap tick 一次触发 prune。
  // （不能靠"跳时钟"模拟，因为大时间跨度本身会被计为一次卡顿。）
  let t = 100000;
  const m = new JankMonitor({ now: () => t });
  m._recentJanks.push(38000); // 62s 前（< cutoff 40000）
  m._last = t;
  t += 20; // 正常心跳间隔，不产生新卡顿
  m._tick();
  assert.equal(m.janksPerMin, 0); // 旧记录被 prune，本次正常 gap 无新增
});

test('JankMonitor: enabled=false 不启动', () => {
  const m = new JankMonitor({ enabled: false, now: () => Date.now() });
  m.start();
  assert.equal(m._hbTimer, null);
  assert.equal(m.enabled, false);
});

test('JankMonitor: stop 清理定时器', () => {
  const m = new JankMonitor({ now: () => Date.now() });
  m.start();
  assert.ok(m._hbTimer);
  assert.ok(m._emitTimer);
  m.stop();
  assert.equal(m._hbTimer, null);
  assert.equal(m._emitTimer, null);
});
