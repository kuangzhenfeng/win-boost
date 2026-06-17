'use strict';

const { EventEmitter } = require('events');
const { getIdleMilliseconds, isAvailable } = require('../native/idle-native');

/**
 * IdleMonitor：周期采样空闲毫秒，跨阈值时发边沿信号。
 * 只在 idle↔active 翻转时 emit，不每 tick 都发，减少状态机噪声。
 *
 * 事件：
 *   - 'signal' { type: 'idle' | 'active', idleMs }
 *   - 'sample' { idleMs } （--debug 时供观察）
 */
class IdleMonitor extends EventEmitter {
  constructor({ idleThresholdMs = 5 * 60 * 1000, pollMs = 2000, debug = false, logger } = {}) {
    super();
    this._threshold = idleThresholdMs;
    this._pollMs = pollMs;
    this._debug = debug;
    this._logger = logger;
    this._idle = false; // 当前是否处于空闲态
    this._lastIdleMs = 0; // 最近一次采样值（供 web 状态展示）
    this._timer = null;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[idle] ${msg}`);
  }

  start() {
    if (!isAvailable()) {
      this._log('error', 'idle-native 不可用，空闲检测停用');
      return;
    }
    if (this._timer) return;
    this._tick();
    this._timer = setInterval(() => this._tick(), this._pollMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    let idleMs;
    try {
      idleMs = getIdleMilliseconds();
    } catch (e) {
      this._log('error', `采样失败: ${e.message}`);
      return;
    }
    this._lastIdleMs = idleMs;
    if (this._debug) this.emit('sample', { idleMs });

    const nowIdle = idleMs >= this._threshold;
    if (nowIdle !== this._idle) {
      this._idle = nowIdle;
      const type = nowIdle ? 'idle' : 'active';
      this._log('info', `${type.toUpperCase()} (idleMs=${idleMs}, 阈值=${this._threshold})`);
      this.emit('signal', { type, idleMs });
    }
  }

  get isIdle() {
    return this._idle;
  }

  // ---- 运行态/热重载（供 web 状态展示与配置热重载）----
  get thresholdMs() {
    return this._threshold;
  }

  get pollMs() {
    return this._pollMs;
  }

  get lastIdleMs() {
    return this._lastIdleMs;
  }

  setThreshold(ms) {
    this._threshold = ms;
  }

  /** 改采样周期：若定时器在跑则重建，保证热重载即时生效。 */
  setPollMs(ms) {
    this._pollMs = ms;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = setInterval(() => this._tick(), this._pollMs);
      if (this._timer.unref) this._timer.unref();
    }
  }
}

module.exports = { IdleMonitor };
