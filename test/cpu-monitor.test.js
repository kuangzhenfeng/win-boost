'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../src/monitors/cpu-monitor');

test('summarize 汇总 idle 与 total', () => {
  const cpus = [
    { times: { user: 100, nice: 0, sys: 50, irq: 0, idle: 50 } },
    { times: { user: 200, nice: 0, sys: 100, irq: 0, idle: 100 } },
  ];
  const r = summarize(cpus);
  assert.equal(r.idle, 150);
  assert.equal(r.total, 600);
});

test('summarize 空数组返回 0', () => {
  const r = summarize([]);
  assert.equal(r.idle, 0);
  assert.equal(r.total, 0);
});
