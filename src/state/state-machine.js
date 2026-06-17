'use strict';

const { EventEmitter } = require('events');
const { Scheme } = require('../constants');

/**
 * 电源档位状态机：统一管理空闲检测与负载检测，避免两个机制打架。
 *
 * 状态：SAVER | BALANCED | PERFORMANCE | ULTIMATE
 *   （ULTIMATE 不可用时由 available 决定，升档目标回退 PERFORMANCE）
 *
 * 输入信号（auto 模式）：
 *   active / idle / load_high / load_normal
 * manual 模式：feed 信号被 Orchestrator 在 paused 时拦截，状态机本身保持。
 *
 * 转移表（auto）：
 *                active      idle        load_high      load_normal
 *   SAVER      →BALANCED    —           →UP†           →BALANCED
 *   BALANCED   —            →SAVER      →UP†           —
 *   PERFORMANCE—            →SAVER      —              →BALANCED
 *   ULTIMATE   —            →SAVER      —              →BALANCED
 *
 *   † UP = preferUltimate && ULTIMATE 可用 ? ULTIMATE : PERFORMANCE
 *
 * 防抖：
 *  - minDwellSec：状态进入后该秒数内禁止再次转移（用 now 注入便于测试）。
 *  - 降档单向：PERFORMANCE/ULTIMATE → normal 只回 BALANCED，不直接 SAVER。
 */
class StateMachine extends EventEmitter {
  constructor({ cfg, available = [], now = () => Date.now(), logger } = {}) {
    super();
    this._logger = logger;
    this._now = now;
    this._available = available.slice();
    this._preferUltimate = cfg ? cfg.preferUltimate !== false : true;
    this._minDwellMs = (cfg ? cfg.minDwellSec : 15) * 1000;
    this._state = Scheme.BALANCED;
    this._since = now();
    this._manualMode = (cfg && cfg.mode === 'manual') || false;
    this._manualScheme = (cfg && cfg.manualScheme) || Scheme.BALANCED;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[state] ${msg}`);
  }

  get state() {
    return this._state;
  }

  get available() {
    return this._available.slice();
  }

  setAvailable(available) {
    this._available = (available || []).slice();
  }

  /** 升档目标 */
  _upTarget() {
    if (this._preferUltimate && this._available.includes(Scheme.ULTIMATE)) {
      return Scheme.ULTIMATE;
    }
    return Scheme.PERFORMANCE;
  }

  /** 初始化状态机起点（来自当前活动方案） */
  init(schemeEnum) {
    if (schemeEnum && Object.values(Scheme).includes(schemeEnum)) {
      this._state = schemeEnum;
    } else {
      this._state = Scheme.BALANCED;
    }
    this._since = this._now();
    this._log('info', `起点 ${this._state}`);
  }

  /** 手动指定档位（用户从托盘选择） */
  setManual(schemeEnum) {
    this._manualMode = true;
    this._manualScheme = schemeEnum;
    this._transition(schemeEnum, 'manual');
    return schemeEnum;
  }

  setAuto() {
    this._manualMode = false;
  }

  // ---- 热重载（供配置热更新，不改当前档位）----
  setPreferUltimate(b) {
    this._preferUltimate = !!b;
  }

  setMinDwellMs(ms) {
    this._minDwellMs = ms;
  }

  get isManual() {
    return this._manualMode;
  }

  /**
   * 喂入一个信号，返回目标档位（发生转移时）或 null（未转移）。
   * @param {{type:string}} signal  type ∈ active|idle|load_high|load_normal
   * @returns {string|null}
   */
  feed(signal) {
    if (this._manualMode) return null;
    const prev = this._state;
    let next = prev;
    switch (signal.type) {
      case 'active':
        if (prev === Scheme.SAVER) next = Scheme.BALANCED;
        break;
      case 'idle':
        next = Scheme.SAVER;
        break;
      case 'load_high':
        if (prev === Scheme.SAVER || prev === Scheme.BALANCED) next = this._upTarget();
        break;
      case 'load_normal':
        if (prev === Scheme.PERFORMANCE || prev === Scheme.ULTIMATE) next = Scheme.BALANCED;
        break;
      default:
        break;
    }
    if (next === prev) return null;
    return this._transition(next, signal.type) ? next : null;
  }

  _transition(next, reason) {
    // 最小驻留防抖（manual 转移不受 dwell 限制）
    if (reason !== 'manual') {
      const elapsed = this._now() - this._since;
      if (elapsed < this._minDwellMs) {
        this._log(
          'debug',
          `抑制转移 ${this._state}→${next}（驻留 ${(elapsed / 1000).toFixed(1)}s < ${this._minDwellMs / 1000}s）`,
        );
        return false;
      }
    }
    const from = this._state;
    this._state = next;
    this._since = this._now();
    this._log('info', `${from} → ${next} (${reason})`);
    this.emit('transition', { from, to: next, reason });
    return true;
  }
}

module.exports = { StateMachine };
