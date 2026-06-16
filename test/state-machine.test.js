'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StateMachine } = require('../src/state/state-machine');
const { Scheme } = require('../src/constants');

function makeSM({ available = ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE'], cfg = {} } = {}) {
  let t = 0;
  const now = () => t;
  const sm = new StateMachine({
    cfg: { minDwellSec: 0, preferUltimate: true, ...cfg },
    available,
    now,
  });
  return {
    sm,
    advance: (ms) => {
      t += ms;
    },
    setTime: (ms) => {
      t = ms;
    },
  };
}

test('idle 信号：任意状态 → SAVER', () => {
  const { sm } = makeSM();
  sm.init(Scheme.BALANCED);
  assert.equal(sm.feed({ type: 'idle' }), Scheme.SAVER);
  assert.equal(sm.state, Scheme.SAVER);
});

test('active 信号：SAVER → BALANCED；其他态不变', () => {
  const { sm } = makeSM();
  sm.init(Scheme.SAVER);
  assert.equal(sm.feed({ type: 'active' }), Scheme.BALANCED);

  const { sm: sm2 } = makeSM();
  sm2.init(Scheme.PERFORMANCE);
  assert.equal(sm2.feed({ type: 'active' }), null); // 不变
});

test('load_high：SAVER/BALANCED → ULTIMATE（默认偏好）', () => {
  const { sm } = makeSM();
  sm.init(Scheme.BALANCED);
  assert.equal(sm.feed({ type: 'load_high' }), Scheme.ULTIMATE);
});

test('load_high：ULTIMATE 不可用时降级到 PERFORMANCE', () => {
  const { sm } = makeSM({ available: ['SAVER', 'BALANCED', 'PERFORMANCE'] });
  sm.init(Scheme.BALANCED);
  assert.equal(sm.feed({ type: 'load_high' }), Scheme.PERFORMANCE);
});

test('load_high：已在 PERFORMANCE/ULTIMATE 不再升', () => {
  const { sm } = makeSM();
  sm.init(Scheme.PERFORMANCE);
  assert.equal(sm.feed({ type: 'load_high' }), null);
});

test('load_normal：PERFORMANCE/ULTIMATE → BALANCED；其他不变', () => {
  const { sm } = makeSM();
  sm.init(Scheme.PERFORMANCE);
  assert.equal(sm.feed({ type: 'load_normal' }), Scheme.BALANCED);

  const { sm: sm2 } = makeSM();
  sm2.init(Scheme.BALANCED);
  assert.equal(sm2.feed({ type: 'load_normal' }), null);
});

test('降档单向：PERFORMANCE load_normal 只回 BALANCED 不直接 SAVER', () => {
  const { sm } = makeSM();
  sm.init(Scheme.PERFORMANCE);
  sm.feed({ type: 'load_normal' }); // → BALANCED
  assert.equal(sm.state, Scheme.BALANCED);
});

test('dwell 防抖：minDwellSec 内抑制转移', () => {
  let t = 1000;
  const now = () => t;
  const sm = new StateMachine({
    cfg: { minDwellSec: 10, preferUltimate: true },
    available: ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE'],
    now,
  });
  sm.init(Scheme.BALANCED); // since = 1000
  t = 3000; // 仅过 2s < 10s
  assert.equal(sm.feed({ type: 'load_high' }), null); // 被抑制
  assert.equal(sm.state, Scheme.BALANCED);
  t = 12000; // 过 11s ≥ 10s
  assert.equal(sm.feed({ type: 'load_high' }), Scheme.ULTIMATE);
});

test('manual 模式：自动信号被忽略', () => {
  const { sm } = makeSM();
  sm.init(Scheme.BALANCED);
  sm.setManual(Scheme.PERFORMANCE);
  assert.equal(sm.state, Scheme.PERFORMANCE);
  assert.equal(sm.feed({ type: 'idle' }), null); // 忽略
  assert.equal(sm.state, Scheme.PERFORMANCE);
});

test('setAuto 恢复自动', () => {
  const { sm } = makeSM();
  sm.init(Scheme.BALANCED);
  sm.setManual(Scheme.PERFORMANCE);
  sm.setAuto();
  assert.equal(sm.feed({ type: 'idle' }), Scheme.SAVER);
});
