'use strict';

const fs = require('fs');
const path = require('path');
const { REG_PARAMS, valuesFromConfig } = require('./ui-boost-registry');
const { apply: applyBoost, revert: revertBoost, isBoosted, readBackup, OP_FILE } = require('./ui-boost-ops');
const { installTask, runTask, deleteTask, taskExists } = require('./elevated-runner');
const { getRootDir } = require('../util/paths');

/**
 * UI 提速控制器：协调"启用 / 禁用 / 应用新值 / 启动恢复 / 退出还原"全流程。
 *
 * 职责边界（单一职责）：
 *  - 决定"现在要不要提速、用什么值"，编排 ops（注册表读写）+ elevated-runner（提权）+ op 指令文件。
 *  - 不直接碰注册表（那是 ui-boost-ops 的事），不直接碰计划任务细节（那是 elevated-runner 的事）。
 *
 * 关键不变量：
 *  - backup.json 存在 ⇔ 当前已提速（boosted）。它是"提速状态"的唯一可信事实来源，
 *    而非 config.uiBoostEnabled（开关只是用户意图，可能因崩溃/UAC 拒绝与实际不一致）。
 *  - 启用走"提权实例 apply"（需 HKLM 写权限）；禁用/退出同理走提权实例 revert。
 *  - 启动恢复：若 config 想开但实际未开（崩溃/UAC 拒绝后）→ 重试启用；若 config 想关但
 *    实际还开着（异常退出残留）→ 还原。以 backup.json 为准对齐实际态。
 *
 * 依赖注入：ops 与 runner 经构造注入，便于单元测试（用桩替换，不真碰注册表/计划任务）。
 */
class UiBoostController {
  /**
   * @param {object} opts
   * @param {object} opts.ops 注册表操作模块（默认 ui-boost-ops）
   * @param {object} opts.runner 提权任务模块（默认 elevated-runner）
   * @param {object} opts.taskTarget 提权任务执行目标 { exe, args }（exe 全路径，args 数组）
   * @param {object} [opts.logger]
   */
  constructor({ ops, runner, taskTarget, logger } = {}) {
    this._ops = ops || { apply: applyBoost, revert: revertBoost, isBoosted, readBackup };
    this._runner = runner || { installTask, runTask, deleteTask, taskExists };
    this._taskTarget = taskTarget;
    this._logger = logger;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[ui-boost] ${msg}`);
  }

  /**
   * 写 op 指令文件（控制器决定、提权实例读取）。
   * @param {string} op 'apply' | 'revert'
   * @param {object} [values] apply 时的优化值（省略则提权实例用内置 boostValue）
   */
  _writeOp(op, values) {
    try {
      const payload = values ? { op, values } : { op };
      fs.writeFileSync(path.join(getRootDir(), OP_FILE), JSON.stringify(payload), 'utf8');
    } catch (e) {
      this._log('warn', `写 op 文件失败: ${e.message}`);
    }
  }

  _removeOp() {
    try { fs.unlinkSync(path.join(getRootDir(), OP_FILE)); } catch { /* ignore */ }
  }

  /**
   * 启用 UI 提速：写 op=apply → 确保提权任务 → 触发 → 轮询确认 boosted。
   * 幂等：已 boosted 直接返回成功（改值请用 applyValues）。
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=15000] 轮询确认超时
   * @param {object} [opts.values] 优化值（默认用 valuesFromConfig(DEFAULT_CONFIG)）
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async enable({ timeoutMs = 15000, values } = {}) {
    // 已提速：幂等成功（改值请走 applyValues）
    if (this._ops.isBoosted()) {
      this._log('debug', '已处于提速态，跳过 enable');
      return { ok: true };
    }
    if (!this._taskTarget || !this._taskTarget.exe) {
      return { ok: false, reason: 'taskTarget 未配置（无法构建提权任务）' };
    }

    // 确保提权任务存在；不存在则创建（首次会弹一次 UAC）
    if (!this._runner.taskExists()) {
      this._log('info', '提权任务不存在，创建（将弹一次 UAC 提示）');
      const sent = this._runner.installTask({
        exe: this._taskTarget.exe,
        args: this._taskTarget.args,
      });
      if (!sent) return { ok: false, reason: '触发提权创建失败（shell-native 不可用）' };
      // 创建是 runas 异步，UAC 用户确认；轮询任务是否出现
      const created = await this._poll(() => this._runner.taskExists(), timeoutMs);
      if (!created) {
        return { ok: false, reason: '提权任务创建未完成（UAC 被拒绝或超时）' };
      }
      this._log('info', '提权任务已创建');
    }

    // 写 op=apply + values，触发任务，轮询 boosted
    this._writeOp('apply', values);
    const ran = this._runner.runTask();
    if (!ran) {
      this._removeOp();
      return { ok: false, reason: '触发提权任务执行失败（schtasks /run 失败）' };
    }
    const boosted = await this._poll(() => this._ops.isBoosted(), timeoutMs);
    this._removeOp();
    if (!boosted) {
      return { ok: false, reason: '提速未生效（注册表写入失败或超时）' };
    }
    this._log('info', 'UI 提速已启用（前台优先 + 解除节流）');
    return { ok: true };
  }

  /**
   * 在已提速态下应用新优化值：先 revert 还原原值 → 再 apply 新值。
   *
   * 为什么先还原再应用而非直接覆盖写：直接写新值会污染 backup（原值已不可知，
   * 之后还原会还原成"上一个优化值"而非真正的系统原值）。先 revert 让 backup 恢复成
   * "未提速"基准（原值已知），再 apply(values) 重新备份真原值并写新值——保证 backup
   * 始终指向系统真正的原始值，禁用时还原干净。
   *
   * 幂等：未提速时退化为 enable(values)。
   * @param {object} values 新优化值
   * @param {number} [timeoutMs]
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async applyValues(values, { timeoutMs = 15000 } = {}) {
    if (!this._ops.isBoosted()) {
      // 未提速：等价于启用
      return this.enable({ timeoutMs, values });
    }
    // 已提速：revert → apply(values)，复用 disable 的还原流程但不卸载任务
    if (!this._runner.taskExists()) {
      if (this._taskTarget && this._taskTarget.exe) {
        this._log('warn', '提速态但提权任务缺失，重建以改值');
        this._runner.installTask({ exe: this._taskTarget.exe, args: this._taskTarget.args });
        const created = await this._poll(() => this._runner.taskExists(), timeoutMs);
        if (!created) return { ok: false, reason: '重建提权任务失败，无法改值（请先关闭再开启）' };
      } else {
        return { ok: false, reason: '提速态但提权任务缺失且无法重建' };
      }
    }
    // 1) 先还原到系统原值（清掉 backup）
    this._writeOp('revert');
    if (!this._runner.runTask()) {
      this._removeOp();
      return { ok: false, reason: '改值前还原失败（schtasks /run 失败）' };
    }
    const reverted = await this._poll(() => !this._ops.isBoosted(), timeoutMs);
    this._removeOp();
    if (!reverted) return { ok: false, reason: '改值前还原未完成' };
    // 2) 再应用新值（重新备份真原值）
    this._writeOp('apply', values);
    if (!this._runner.runTask()) {
      this._removeOp();
      return { ok: false, reason: '应用新值失败（schtasks /run 失败）' };
    }
    const boosted = await this._poll(() => this._ops.isBoosted(), timeoutMs);
    this._removeOp();
    if (!boosted) return { ok: false, reason: '应用新值未生效（注册表写入失败或超时）' };
    this._log('info', 'UI 提速参数已更新');
    return { ok: true };
  }

  /**
   * 禁用 UI 提速：写 op=revert → 触发 → 轮询确认还原 → 卸载提权任务（弹一次 UAC）。
   * 幂等：未 boosted 直接返回成功（并清理可能残留的提权任务）。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async disable({ timeoutMs = 15000 } = {}) {
    if (!this._ops.isBoosted()) {
      // 未提速：清理可能残留的提权任务（如用户手动改过注册表后）
      if (this._runner.taskExists()) {
        this._log('info', '未提速但提权任务残留，清理（将弹一次 UAC）');
        this._runner.deleteTask();
      }
      return { ok: true };
    }

    // 还原注册表（仍走提权任务，写 HKLM 需管理员）
    if (!this._runner.taskExists()) {
      // 已 boosted 但任务不在：异常状态，注册表已被提速但无任务还原。
      // 尝试重建任务（弹 UAC）再还原。
      if (this._taskTarget && this._taskTarget.exe) {
        this._log('warn', '提速态但提权任务缺失，重建以还原');
        this._runner.installTask({ exe: this._taskTarget.exe, args: this._taskTarget.args });
        const created = await this._poll(() => this._runner.taskExists(), timeoutMs);
        if (!created) return { ok: false, reason: '重建提权任务失败，无法还原（请手动还原注册表）' };
      } else {
        return { ok: false, reason: '提速态但提权任务缺失且无法重建' };
      }
    }

    this._writeOp('revert');
    const ran = this._runner.runTask();
    if (!ran) {
      this._removeOp();
      return { ok: false, reason: '触发还原任务执行失败' };
    }
    const reverted = await this._poll(() => !this._ops.isBoosted(), timeoutMs);
    this._removeOp();
    if (!reverted) {
      return { ok: false, reason: '还原未完成（注册表写入失败或超时）' };
    }
    this._log('info', 'UI 提速已禁用（注册表已还原）');

    // 还原后卸载提权任务，彻底清理
    this._runner.deleteTask();
    return { ok: true };
  }

  /**
   * 启动恢复：以 backup.json（实际态）为准对齐到期望态（enabled）。
   * - 期望开且未开 → enable；期望开且已开 → 无事。
   * - 期望关且已开（异常残留）→ disable 还原。
   * @param {boolean} enabled 期望是否提速（来自 config.uiBoostEnabled）
   * @param {object} [values] 优化值（enable 时使用）
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async reconcile(enabled, values) {
    const boosted = this._ops.isBoosted();
    if (enabled && !boosted) {
      this._log('info', '启动恢复：期望提速但实际未提速，重试启用');
      return this.enable({ values });
    }
    if (!enabled && boosted) {
      this._log('warn', '启动恢复：期望未提速但实际仍提速（异常退出残留），还原');
      return this.disable();
    }
    return { ok: true };
  }

  /** 当前实际是否提速（以 backup.json 为准）。 */
  get isActive() {
    return this._ops.isBoosted();
  }

  /** 当前备份的原值（诊断用，未提速时为 null）。 */
  get backup() {
    return this._ops.readBackup();
  }

  /**
   * 轮询 cond 直到返回 true 或超时。阻塞式（简化：UI 提速不频繁，可接受同步等待）。
   * 用忙等 + sleep：任务执行通常 1-3s。
   * @param {()=>boolean} cond
   * @param {number} timeoutMs
   */
  _poll(cond, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (cond()) return resolve(true);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(tick, 200);
      };
      tick();
    });
  }
}

module.exports = { UiBoostController, REG_PARAMS, valuesFromConfig };
