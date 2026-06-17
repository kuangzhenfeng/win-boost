'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG_SCHEMA, SCHEMA_GROUPS, FIELD_CONSTRAINTS, FIELD_RANGE, enforceConstraints } = require('../src/web/schema');
const { DEFAULT_CONFIG, CONFIG_TYPES } = require('../src/constants');
const defaultsJson = require('../src/config/defaults.json');

test('schema 每字段有 key/group/label/type/control', () => {
  assert.ok(Array.isArray(CONFIG_SCHEMA));
  assert.ok(CONFIG_SCHEMA.length > 0);
  for (const f of CONFIG_SCHEMA) {
    for (const k of ['key', 'group', 'label', 'type', 'control']) {
      assert.ok(f[k] !== undefined, `字段 ${f.key} 缺 ${k}`);
    }
  }
});

test('schema 覆盖所有可编辑配置键', () => {
  const keys = new Set(CONFIG_SCHEMA.map((f) => f.key));
  for (const k of [
    'mode', 'manualScheme', 'idleThresholdMin', 'idlePollMs',
    'cpuHighPct', 'cpuCooldownPct', 'cpuHighHoldSec', 'cpuCooldownHoldSec', 'cpuEma', 'cpuSampleMs',
    'pdhEnabled', 'pdhHighPct', 'pdhHoldSec', 'pdhPollMs',
    'jankEnabled', 'jankPerMin', 'jankHoldSec',
    'preferUltimate', 'minDwellSec', 'logLevel',
  ]) {
    assert.ok(keys.has(k), `缺字段 ${k}`);
  }
});

test('schema 分组有序且非空', () => {
  assert.ok(SCHEMA_GROUPS.length > 0);
  for (const g of SCHEMA_GROUPS) assert.ok(typeof g === 'string' && g.length > 0);
});

test('slider 字段有 min/max/step', () => {
  for (const f of CONFIG_SCHEMA) {
    if (f.control === 'slider') {
      for (const k of ['min', 'max', 'step']) {
        assert.ok(typeof f[k] === 'number', `slider ${f.key} 缺 ${k}`);
      }
    }
  }
});

test('DEFAULT_CONFIG 自 defaults.json 加载且被冻结', () => {
  // 内容与磁盘 JSON 完全一致（单一事实来源 = 数据文件）
  assert.deepEqual(DEFAULT_CONFIG, defaultsJson);
  // 冻结：运行期不可改
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
});

test('DEFAULT_CONFIG 每个 key 都有对应的 CONFIG_TYPES 规则', () => {
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(CONFIG_TYPES[k] !== undefined, `默认配置字段 ${k} 缺类型规则`);
  }
});

// ---- 跨字段约束 ----

test('FIELD_CONSTRAINTS 声明升档 > 降档死区', () => {
  // 升档阈值必须严格高于降档阈值，否则 Hysteresis 无死区会抖动
  const c = FIELD_CONSTRAINTS.find((x) => x.a === 'cpuHighPct' && x.b === 'cpuCooldownPct');
  assert.ok(c, '缺 cpuHighPct > cpuCooldownPct 约束');
  assert.equal(c.op, 'gt');
  assert.ok(c.gap >= 1, 'gap 死区至少为 1');
});

test('FIELD_RANGE 覆盖受约束字段', () => {
  assert.ok(FIELD_RANGE.cpuHighPct, '缺 cpuHighPct 范围');
  assert.ok(FIELD_RANGE.cpuCooldownPct, '缺 cpuCooldownPct 范围');
});

test('DEFAULT_CONFIG 满足全部跨字段约束（默认即自洽）', () => {
  // 默认值本身不能违反约束，否则首次落盘即不自洽
  const out = enforceConstraints(DEFAULT_CONFIG);
  assert.deepEqual(out, DEFAULT_CONFIG, '默认配置应自洽，enforceConstraints 不改其值');
});

test('enforceConstraints: 不改入参，自洽配置原样返回', () => {
  const cfg = { cpuHighPct: 70, cpuCooldownPct: 45 };
  const out = enforceConstraints(cfg);
  assert.equal(out.cpuHighPct, 70);
  assert.equal(out.cpuCooldownPct, 45);
  assert.equal(cfg.cpuHighPct, 70); // 入参未被改写
});

test('enforceConstraints: 升档 ≤ 降档时，以降档为基准夹紧升档', () => {
  // 反例：升档=40，降档=45 → 升档应被顶到 46
  const out = enforceConstraints({ cpuHighPct: 40, cpuCooldownPct: 45 });
  assert.equal(out.cpuHighPct, 46);
  assert.equal(out.cpuCooldownPct, 45); // 被依赖方不变
});

test('enforceConstraints: 升档==降档时仍夹紧（gap 死区）', () => {
  const out = enforceConstraints({ cpuHighPct: 50, cpuCooldownPct: 50 });
  assert.equal(out.cpuHighPct, 51);
  assert.equal(out.cpuCooldownPct, 50);
});

test('enforceConstraints: 受字段 max 收口', () => {
  // 降档=95（其 max）→ 升档约束下界=96，升档 max=100，合法
  const out = enforceConstraints({ cpuHighPct: 10, cpuCooldownPct: 95 });
  assert.equal(out.cpuHighPct, 96);
  // 降档=100（超其 max，但假设直写）→ 升档下界 101 被 max=100 收口
  const out2 = enforceConstraints({ cpuHighPct: 10, cpuCooldownPct: 100 });
  assert.ok(out2.cpuHighPct <= 100, '升档被 max 收口');
});

test('enforceConstraints: 非数字字段安全跳过', () => {
  const out = enforceConstraints({ cpuHighPct: 'x', cpuCooldownPct: 45, mode: 'auto' });
  assert.equal(out.mode, 'auto');
  assert.equal(out.cpuHighPct, 'x'); // 不处理非数字
});
