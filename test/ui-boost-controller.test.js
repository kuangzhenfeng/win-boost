'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { UiBoostController } = require('../src/ui-boost/ui-boost-controller');
const { getRootDir } = require('../src/util/paths');
const { OP_FILE } = require('../src/ui-boost/ui-boost-ops');

/**
 * 构造注入桩：ops 与 runner 全部桩化，完全不碰真实注册表/计划任务。
 * boosted / taskExists / backup 三态可控，便于编排各场景。
 *
 * runTask 忠实复现真实提权流程：读 op 指令文件 → 调 ops.apply/revert 改 boosted。
 * 控制器写 op 文件、触发任务、轮询 boosted；桩按 op 决定副作用，与提权实例行为一致。
 */
function makeStubs({ boosted = false, taskExists = false } = {}) {
  const calls = { apply: 0, revert: 0, installTask: 0, runTask: 0, deleteTask: 0, taskExists: 0 };
  const applied = []; // 记录每次 apply 收到的 values，供断言参数传递
  const state = { boosted, taskExists, backup: boosted ? { win32PrioritySeparation: '0x2' } : null };
  const ops = {
    apply: (values) => { calls.apply += 1; applied.push(values); state.boosted = true; return { applied: true, backup: state.backup || {} }; },
    revert: () => { calls.revert += 1; state.boosted = false; return { reverted: true }; },
    isBoosted: () => state.boosted,
    readBackup: () => state.backup,
  };
  // 读 op 文件（JSON {op,values}）决定 apply/revert，与真实 --ui-boost-op 流程一致
  const readOpFile = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(getRootDir(), OP_FILE), 'utf8'));
      return parsed.op === 'revert' ? { op: 'revert' } : { op: 'apply', values: parsed.values };
    } catch {
      return { op: 'apply' };
    }
  };
  const runner = {
    installTask: () => { calls.installTask += 1; state.taskExists = true; return true; },
    runTask: () => {
      calls.runTask += 1;
      const o = readOpFile();
      if (o.op === 'revert') ops.revert();
      else ops.apply(o.values);
      return true;
    },
    deleteTask: () => { calls.deleteTask += 1; state.taskExists = false; return true; },
    taskExists: () => { calls.taskExists += 1; return state.taskExists; },
  };
  return { ops, runner, calls, state, applied };
}

// 清理可能残留的 op 文件（测试在真实 appdata 目录写 op，控制器应自行清理，兜底）
function cleanupOp() {
  try { fs.unlinkSync(path.join(getRootDir(), OP_FILE)); } catch { /* ignore */ }
}

test('enable: 已提速时幂等成功，不重复操作', async () => {
  const { ops, runner, calls } = makeStubs({ boosted: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.enable();
  assert.equal(res.ok, true);
  assert.equal(calls.apply, 0); // 幂等：不再 apply
  assert.equal(calls.runTask, 0);
});

test('enable: 未提速且无任务 → 创建任务(首次 UAC) → apply → boosted', async () => {
  cleanupOp();
  const { ops, runner, calls, state } = makeStubs({ boosted: false, taskExists: false });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.enable({ timeoutMs: 1000 });
  assert.equal(res.ok, true);
  assert.equal(calls.installTask, 1); // 首次创建提权任务
  assert.equal(calls.runTask, 1); // 触发任务执行 apply
  assert.equal(state.boosted, true);
});

test('enable: 任务已存在 → 直接 apply，不重复创建', async () => {
  cleanupOp();
  const { ops, runner, calls } = makeStubs({ boosted: false, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.enable({ timeoutMs: 1000 });
  assert.equal(res.ok, true);
  assert.equal(calls.installTask, 0); // 任务在，不再创建
  assert.equal(calls.runTask, 1);
});

test('disable: 已提速 → revert → 卸载任务', async () => {
  cleanupOp();
  const { ops, runner, calls, state } = makeStubs({ boosted: true, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.disable({ timeoutMs: 1000 });
  assert.equal(res.ok, true);
  assert.equal(calls.runTask, 1); // 触发还原
  assert.equal(calls.deleteTask, 1); // 还原后卸载
  assert.equal(state.boosted, false);
});

test('disable: 未提速且无任务 → 幂等成功', async () => {
  const { ops, runner, calls } = makeStubs({ boosted: false, taskExists: false });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.disable();
  assert.equal(res.ok, true);
  assert.equal(calls.runTask, 0);
  assert.equal(calls.deleteTask, 0);
});

test('disable: 未提速但有残留任务 → 清理任务', async () => {
  const { ops, runner, calls } = makeStubs({ boosted: false, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.disable();
  assert.equal(res.ok, true);
  assert.equal(calls.deleteTask, 1); // 残留任务清理
  assert.equal(calls.runTask, 0); // 未提速不触发还原
});

test('reconcile: 期望开但未开 → enable', async () => {
  cleanupOp();
  const { ops, runner, calls } = makeStubs({ boosted: false, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.reconcile(true);
  assert.equal(res.ok, true);
  assert.equal(calls.runTask, 1);
});

test('reconcile: 期望关但已开（异常残留）→ disable 还原', async () => {
  cleanupOp();
  const { ops, runner, calls } = makeStubs({ boosted: true, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const res = await c.reconcile(false);
  assert.equal(res.ok, true);
  assert.equal(calls.runTask, 1);
  assert.equal(calls.deleteTask, 1);
});

test('reconcile: 已一致 → 无操作', async () => {
  const on = makeStubs({ boosted: true });
  const c1 = new UiBoostController({ ops: on.ops, runner: on.runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const r1 = await c1.reconcile(true);
  assert.equal(r1.ok, true);
  assert.equal(on.calls.runTask, 0);

  const off = makeStubs({ boosted: false });
  const c2 = new UiBoostController({ ops: off.ops, runner: off.runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const r2 = await c2.reconcile(false);
  assert.equal(r2.ok, true);
  assert.equal(off.calls.runTask, 0);
});

test('enable: taskTarget 缺失 → 失败且不操作', async () => {
  const { ops, runner, calls } = makeStubs({ boosted: false });
  const c = new UiBoostController({ ops, runner }); // 无 taskTarget
  const res = await c.enable();
  assert.equal(res.ok, false);
  assert.ok(res.reason);
  assert.equal(calls.runTask, 0);
});

test('isActive / backup: 反映实际态', () => {
  const on = makeStubs({ boosted: true });
  const c1 = new UiBoostController({ ops: on.ops, runner: on.runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  assert.equal(c1.isActive, true);
  assert.ok(c1.backup);

  const off = makeStubs({ boosted: false });
  const c2 = new UiBoostController({ ops: off.ops, runner: off.runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  assert.equal(c2.isActive, false);
  assert.equal(c2.backup, null);
});

test('enable: values 透传给 ops.apply', async () => {
  cleanupOp();
  const { ops, runner, applied } = makeStubs({ boosted: false, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const values = { win32PrioritySeparation: 26, systemResponsiveness: 5, networkThrottlingIndex: 4294967295 };
  const res = await c.enable({ timeoutMs: 1000, values });
  assert.equal(res.ok, true);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], values); // op 文件携带 values，提权实例按它写
});

test('applyValues: 已提速 → revert 后再 apply 新值（保证 backup 指向真原值）', async () => {
  cleanupOp();
  const { ops, runner, calls, applied } = makeStubs({ boosted: true, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const values = { win32PrioritySeparation: 2, systemResponsiveness: 0, networkThrottlingIndex: 4294967295 };
  const res = await c.applyValues(values, { timeoutMs: 1000 });
  assert.equal(res.ok, true);
  // 先还原再应用：runTask 两次（一次 revert 一次 apply）
  assert.equal(calls.runTask, 2);
  assert.equal(calls.apply, 1); // 只 apply 一次（带新值）
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], values);
});

test('applyValues: 未提速 → 退化为 enable(values)', async () => {
  cleanupOp();
  const { ops, runner, calls, applied } = makeStubs({ boosted: false, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const values = { win32PrioritySeparation: 38, systemResponsiveness: 10, networkThrottlingIndex: 4294967295 };
  const res = await c.applyValues(values, { timeoutMs: 1000 });
  assert.equal(res.ok, true);
  assert.equal(calls.runTask, 1); // 未提速只 apply 一次
  assert.deepEqual(applied[0], values);
});

test('reconcile: 期望开 → 透传 values 给 enable', async () => {
  cleanupOp();
  const { ops, runner, applied } = makeStubs({ boosted: false, taskExists: true });
  const c = new UiBoostController({ ops, runner, taskTarget: { exe: 'wb.exe', args: ['--ui-boost-op'] } });
  const values = { win32PrioritySeparation: 26, systemResponsiveness: 10, networkThrottlingIndex: 4294967295 };
  const res = await c.reconcile(true, values);
  assert.equal(res.ok, true);
  assert.deepEqual(applied[0], values);
});
