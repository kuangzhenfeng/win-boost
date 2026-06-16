'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Hysteresis } = require('../src/state/hysteresis');

test('未达 enter 不翻转', () => {
  let t = 0;
  const h = new Hysteresis({ enter: 70, exit: 45, enterHoldMs: 1000, exitHoldMs: 1000, now: () => t });
  h.feed(50);
  t += 2000;
  h.feed(50);
  assert.equal(h.active, false);
});

test('达到 enter 且持续 hold → enter', () => {
  let t = 0;
  const h = new Hysteresis({ enter: 70, exit: 45, enterHoldMs: 1000, exitHoldMs: 1000, now: () => t });
  h.feed(80);
  t += 1500;
  assert.equal(h.feed(80), 'enter');
  assert.equal(h.active, true);
});

test('enter 未持续够 hold → 不翻转', () => {
  let t = 0;
  const h = new Hysteresis({ enter: 70, exit: 45, enterHoldMs: 1000, exitHoldMs: 1000, now: () => t });
  h.feed(80);
  t += 500; // 不足
  assert.equal(h.feed(80), null);
  assert.equal(h.active, false);
});

test('enter 中断后重新计时', () => {
  let t = 0;
  const h = new Hysteresis({ enter: 70, exit: 45, enterHoldMs: 1000, exitHoldMs: 1000, now: () => t });
  h.feed(80); // 候选
  t += 500;
  h.feed(50); // 回落到中间，方向改变，重置
  t += 800;
  assert.equal(h.feed(80), null); // 重新计时不足
});

test('滞回：进入后未到 exit 阈值不退出', () => {
  let t = 0;
  const h = new Hysteresis({ enter: 70, exit: 45, enterHoldMs: 0, exitHoldMs: 1000, now: () => t });
  h.feed(80);
  t += 10;
  h.feed(80); // enter
  assert.equal(h.active, true);
  t += 2000;
  h.feed(60); // 介于 exit(45) 和 enter(70)，不应退出
  assert.equal(h.active, true);
});

test('到 exit 阈值且持续 hold → exit', () => {
  let t = 0;
  const h = new Hysteresis({ enter: 70, exit: 45, enterHoldMs: 0, exitHoldMs: 1000, now: () => t });
  h.feed(80);
  t += 10;
  h.feed(80); // enter
  t += 2000;
  h.feed(30); // 候选 exit
  t += 1500;
  assert.equal(h.feed(30), 'exit');
  assert.equal(h.active, false);
});
