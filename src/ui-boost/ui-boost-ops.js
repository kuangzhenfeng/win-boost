'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { REG_PARAMS } = require('./ui-boost-registry');
const { getRootDir } = require('../util/paths');
const { atomicWriteJson, readJsonSafe } = require('../util/atomic-write');

/**
 * UI 提速注册表读写（提权实例执行体）。
 *
 * 由 `--ui-boost-op` 子命令在提权上下文（计划任务 /RL HIGHEST）中调用，
 * 也可在单元测试中直接调用（非提权时 reg add 会失败，测试用桩替换 execFileSync）。
 *
 * 单一职责：只做注册表的读/写/备份/还原，不关心怎么提权、何时触发。
 * 与 elevated-runner（怎么提权）、ui-boost-controller（何时触发）解耦。
 */

const REG = 'reg.exe';
const BACKUP_FILE = 'ui-boost-backup.json';
/**
 * op 指令文件（控制器写、提权实例读）：JSON，{ op:'apply'|'revert', values? }。
 *
 * 为什么用 JSON 而非纯文本：apply 需携带本次的优化值（由用户配置派生）。
 * 提权实例（--ui-boost-op）读它决定 apply/revert 并取 values。文件协议内聚于本模块，
 * 控制器写、ops 读，双方都经 writeOp/readOp，格式单一事实来源。
 */
const OP_FILE = 'ui-boost-op.json';

/** reg query/add 都直接 spawn reg.exe（不经 shell，与 autostart.js 同法，规避中文系统转义/乱码）。 */
function _regQuery(hivePath, name) {
  try {
    const out = execFileSync(REG, ['query', hivePath, '/v', name], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out ? out.toString() : '';
  } catch {
    return null; // 项不存在 / 无权限
  }
}

function _regAdd(hivePath, name, type, value) {
  try {
    execFileSync(REG, ['add', hivePath, '/v', name, '/t', type, '/d', String(value), '/f'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** 解析 reg query 输出中的值（形如 `    Name    REG_DWORD    0x2`），取最后一个 token。 */
function _parseRegValue(out) {
  if (!out) return null;
  const m = /REG_\w+\s+(0x[0-9a-fA-F]+|\d+)\s*$/m.exec(out);
  return m ? m[1] : null;
}

/** 取每个参数的完整键路径（hive + path）。 */
function _fullKey(p) {
  return `${p.hive}\\${p.path}`;
}

/**
 * 启用：备份当前值 → 写优化值 → 仅在全部写入成功后落盘 backup。
 *
 * 原子性保证（工业级，避免半成品状态破坏 isBoosted 不变量）：
 *  - 先把三个原值备份到内存；逐个写优化值。
 *  - 全部成功 → 落盘 backup.json（标记 boosted）。
 *  - 任一失败 → 回滚本轮已成功写入的项（写回各自原值），**不落盘 backup**。
 *    这样 apply 失败后注册表与调用前完全一致，isBoosted() 仍为 false，
 *    控制器可安全重试而不会把优化值误当原值重新备份。
 *
 * 优化值由调用方传入（经 valuesFromConfig 由用户配置派生）；未传则用 REG_PARAMS.boostValue。
 * 幂等：由控制器保证只在"未提速"时调用；重复调用会重新备份当前值
 * （提速态下当前值即优化值，会被当成原值备份——故控制器禁止单独重复 apply）。
 * @param {object} [values] { win32PrioritySeparation, systemResponsiveness, networkThrottlingIndex }
 * @returns {{applied:boolean, backup:object}} applied=三个值是否都写成功
 */
function apply(values) {
  const v = values || {};
  const backup = {};
  const written = []; // 本轮已成功写入的项（用于失败回滚）
  let allApplied = true;
  for (const p of REG_PARAMS) {
    const key = _fullKey(p);
    // 备份当前值（查询失败记为 null，还原时跳过）
    const q = _regQuery(key, p.name);
    backup[p.key] = q !== null ? _parseRegValue(q) : null;
    // 写优化值（配置覆盖 > 内置 boostValue）
    const target = v[p.key] != null ? v[p.key] : p.boostValue;
    if (!_regAdd(key, p.name, p.type, target)) {
      allApplied = false;
      break; // 任一失败立即停止，后续回滚已写入项
    }
    written.push({ p, orig: backup[p.key] });
  }

  if (!allApplied) {
    // 回滚本轮已写入项：写回各自原值，恢复调用前一致态（原值 null 则跳过）
    for (const { p, orig } of written) {
      if (orig != null) _regAdd(_fullKey(p), p.name, p.type, orig);
    }
    return { applied: false, backup };
  }

  atomicWriteJson(path.join(getRootDir(), BACKUP_FILE), backup);
  return { applied: true, backup };
}

/**
 * 还原：读 backup.json → 逐项写回原值 → 删除 backup.json。
 * 原值为 null 的项跳过（查询失败未备份），保留当前态不破坏。
 * @returns {{reverted:boolean}} reverted=有原值且都写成功（无 backup 则 nothing-to-do）
 */
function revert() {
  const backupPath = path.join(getRootDir(), BACKUP_FILE);
  const backup = readJsonSafe(backupPath, null);
  if (!backup || typeof backup !== 'object') {
    return { reverted: true }; // 无备份：nothing-to-do，视为已完成
  }
  let allReverted = true;
  let anyRestored = false;
  for (const p of REG_PARAMS) {
    const orig = backup[p.key];
    if (orig == null) continue; // 未备份，跳过
    if (!_regAdd(_fullKey(p), p.name, p.type, orig)) allReverted = false;
    anyRestored = true;
  }
  // 全部还原成功才删除备份；部分失败保留备份以便重试
  if (allReverted) {
    try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
  }
  return { reverted: allReverted || !anyRestored };
}

/**
 * 读 op 指令文件。返回 { op:'apply'|'revert', values? }；无文件视为默认 apply。
 * @returns {{op:string, values?:object}}
 */
function readOp() {
  try {
    const raw = fs.readFileSync(path.join(getRootDir(), OP_FILE), 'utf8').trim();
    const parsed = JSON.parse(raw);
    return { op: parsed.op === 'revert' ? 'revert' : 'apply', values: parsed.values };
  } catch {
    return { op: 'apply' };
  }
}

/** backup.json 是否存在（= 当前是否已提速）。非提权可读（只判存在）。 */
function isBoosted() {
  try {
    fs.accessSync(path.join(getRootDir(), BACKUP_FILE));
    return true;
  } catch {
    return false;
  }
}

/** 读 backup.json 内容（供测试与诊断）。 */
function readBackup() {
  return readJsonSafe(path.join(getRootDir(), BACKUP_FILE), null);
}

module.exports = { apply, revert, readOp, isBoosted, readBackup, _parseRegValue, BACKUP_FILE, OP_FILE };
