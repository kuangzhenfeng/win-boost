'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseActiveScheme, parseAllSchemes, classifyScheme } = require('../src/power/scheme-registry');

test('parseActiveScheme 解析英文', () => {
  const r = parseActiveScheme('Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)');
  assert.equal(r.guid, '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
  assert.equal(r.friendlyName, 'High performance');
});

test('parseActiveScheme 解析中文', () => {
  const r = parseActiveScheme('电源方案 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (平衡)');
  assert.equal(r.guid, '381b4222-f694-41f0-9685-ff5bb260df2e');
  assert.equal(r.friendlyName, '平衡');
});

test('parseActiveScheme 无匹配返回 null', () => {
  assert.equal(parseActiveScheme('nothing here'), null);
  assert.equal(parseActiveScheme(''), null);
  assert.equal(parseActiveScheme(null), null);
});

test('parseAllSchemes 解析多行', () => {
  const txt = [
    'Existing Power Schemes:',
    'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Power saver)',
    'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
    'Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)',
  ].join('\n');
  const all = parseAllSchemes(txt);
  assert.equal(all.length, 3);
  assert.equal(all[2].guid, '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
});

test('classifyScheme 关键字识别', () => {
  assert.equal(classifyScheme({ guid: 'x', friendlyName: 'Power saver' }), 'SAVER');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: 'Balanced' }), 'BALANCED');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: 'High performance' }), 'PERFORMANCE');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: 'Ultimate Performance' }), 'ULTIMATE');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: '节能' }), 'SAVER');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: '平衡' }), 'BALANCED');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: '高性能' }), 'PERFORMANCE');
  assert.equal(classifyScheme({ guid: 'x', friendlyName: '卓越性能' }), 'ULTIMATE');
});

test('classifyScheme 自定义方案返回 null', () => {
  assert.equal(classifyScheme({ guid: 'deadbeef-0000-0000-0000-000000000000', friendlyName: '我的方案' }), null);
});
