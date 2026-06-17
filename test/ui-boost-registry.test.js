'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { REG_PARAMS, PRIORITY_LEVELS, valuesFromConfig } = require('../src/ui-boost/ui-boost-registry');
const { _parseRegValue } = require('../src/ui-boost/ui-boost-ops');

test('REG_PARAMS: 三个参数定义完整且为 REG_DWORD', () => {
  assert.equal(REG_PARAMS.length, 3);
  const keys = REG_PARAMS.map((p) => p.key);
  assert.deepEqual(keys.sort(), ['networkThrottlingIndex', 'systemResponsiveness', 'win32PrioritySeparation']);
  for (const p of REG_PARAMS) {
    assert.equal(p.hive, 'HKLM');
    assert.equal(p.type, 'REG_DWORD');
    assert.equal(typeof p.boostValue, 'number');
    assert.equal(typeof p.fallback, 'number');
  }
});

test('REG_PARAMS: 优化值取值正确（与调研结论一致）', () => {
  const byKey = Object.fromEntries(REG_PARAMS.map((p) => [p.key, p]));
  // 短量子 + 前台最大提升
  assert.equal(byKey.win32PrioritySeparation.boostValue, 38);
  assert.equal(byKey.win32PrioritySeparation.fallback, 2);
  // 后台预留降到 10
  assert.equal(byKey.systemResponsiveness.boostValue, 10);
  assert.equal(byKey.systemResponsiveness.fallback, 20);
  // 解除网络节流
  assert.equal(byKey.networkThrottlingIndex.boostValue, 4294967295);
  assert.equal(byKey.networkThrottlingIndex.fallback, 10);
});

test('REG_PARAMS: 路径与值名与实际注册表布局一致', () => {
  const byKey = Object.fromEntries(REG_PARAMS.map((p) => [p.key, p]));
  assert.equal(byKey.win32PrioritySeparation.path, 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl');
  assert.equal(byKey.win32PrioritySeparation.name, 'Win32PrioritySeparation');
  const mmcss = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
  assert.equal(byKey.systemResponsiveness.path, mmcss);
  assert.equal(byKey.systemResponsiveness.name, 'SystemResponsiveness');
  assert.equal(byKey.networkThrottlingIndex.path, mmcss);
  assert.equal(byKey.networkThrottlingIndex.name, 'NetworkThrottlingIndex');
});

test('_parseRegValue: 解析 REG_DWORD 的十六进制与十进制', () => {
  // 中文/英文系统 reg query 输出形如 "    Name    REG_DWORD    0x2"
  assert.equal(_parseRegValue('    Win32PrioritySeparation    REG_DWORD    0x2'), '0x2');
  assert.equal(_parseRegValue('    SystemResponsiveness    REG_DWORD    0x14'), '0x14');
  assert.equal(_parseRegValue('    NetworkThrottlingIndex    REG_DWORD    0xa'), '0xa');
  assert.equal(_parseRegValue('garbage'), null);
  assert.equal(_parseRegValue(''), null);
  assert.equal(_parseRegValue(null), null);
});

test('PRIORITY_LEVELS: 三个预设档位（系统默认/前台优先/极致前台）', () => {
  assert.deepEqual(PRIORITY_LEVELS.map((p) => p.v), [2, 26, 38]);
  assert.deepEqual(PRIORITY_LEVELS.map((p) => p.t), ['系统默认', '前台优先', '极致前台']);
});

test('valuesFromConfig: 默认配置派生 → 极致前台/后台10/解除节流', () => {
  const { DEFAULT_CONFIG } = require('../src/constants');
  const v = valuesFromConfig(DEFAULT_CONFIG);
  assert.equal(v.win32PrioritySeparation, 38);
  assert.equal(v.systemResponsiveness, 10);
  assert.equal(v.networkThrottlingIndex, 4294967295);
});

test('valuesFromConfig: 用户调档 → 前台优先/后台5', () => {
  const v = valuesFromConfig({ uiBoostPriorityLevel: 26, uiBoostSystemResponsiveness: 5, uiBoostEnableNetworkThrottle: false });
  assert.equal(v.win32PrioritySeparation, 26);
  assert.equal(v.systemResponsiveness, 5);
});

test('valuesFromConfig: 保持网络节流开关 → 节流值回 10', () => {
  const on = valuesFromConfig({ uiBoostEnableNetworkThrottle: true });
  assert.equal(on.networkThrottlingIndex, 10); // 保持节流
  const off = valuesFromConfig({ uiBoostEnableNetworkThrottle: false });
  assert.equal(off.networkThrottlingIndex, 4294967295); // 解除节流
});

test('valuesFromConfig: 非法档位值（固定量子等有害值）→ 回退极致前台 38', () => {
  // 24(0x18) 含固定量子位，CPU 密集任务会饿死前台——必须被回退
  assert.equal(valuesFromConfig({ uiBoostPriorityLevel: 24 }).win32PrioritySeparation, 38);
  // 随便给个非预设值
  assert.equal(valuesFromConfig({ uiBoostPriorityLevel: 100 }).win32PrioritySeparation, 38);
  // 合法预设值原样通过
  assert.equal(valuesFromConfig({ uiBoostPriorityLevel: 2 }).win32PrioritySeparation, 2);
});

test('valuesFromConfig: 配置缺失/空 → 内置默认', () => {
  const v = valuesFromConfig({});
  assert.equal(v.win32PrioritySeparation, 38);
  assert.equal(v.systemResponsiveness, 10);
  assert.equal(v.networkThrottlingIndex, 4294967295);
  assert.deepEqual(valuesFromConfig(null).win32PrioritySeparation, 38);
});
