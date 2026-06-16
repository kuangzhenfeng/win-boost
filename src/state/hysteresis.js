'use strict';

/**
 * 通用滞回工具：连续超阈值计数 + enter/exit 双阈值。
 *
 * - enter：进入"高"态的阈值（值 ≥ enter 且持续 enterHoldMs）。
 * - exit：退出"高"态的阈值（值 ≤ exit 且持续 exitHoldMs），exit 应 < enter 留死区。
 * - 用 now() 提供时间，便于测试注入。
 *
 * feed() 返回：'enter' | 'exit' | null（本次是否产生状态翻转）。
 * active 属性反映当前是否处于"高"态。
 */
class Hysteresis {
  constructor({ enter, exit, enterHoldMs, exitHoldMs, now } = {}) {
    this._enter = enter;
    this._exit = exit;
    this._enterHoldMs = enterHoldMs;
    this._exitHoldMs = exitHoldMs;
    this._now = now || (() => Date.now());
    this._active = false;
    this._sinceCandidate = 0; // 当前候选方向的起始时间
    this._direction = null; // 'enter' | 'exit' | null，最近一次采样落在哪侧
  }

  get active() {
    return this._active;
  }

  /**
   * @param {number} value
   * @returns {'enter'|'exit'|null}
   */
  feed(value) {
    const t = this._now();
    let dir;
    if (this._active) {
      // 已在高态：判定是否满足退出条件
      dir = value <= this._exit ? 'exit' : null;
    } else {
      // 不在高态：判定是否满足进入条件
      dir = value >= this._enter ? 'enter' : null;
    }

    // 落在死区内（无候选方向）：中断计时，不翻转
    if (!dir) {
      this._direction = null;
      this._sinceCandidate = 0;
      return null;
    }

    if (dir === this._direction) {
      // 同方向：检查是否累计达 hold
      const elapsed = t - this._sinceCandidate;
      const need = this._active ? this._exitHoldMs : this._enterHoldMs;
      if (elapsed >= need) {
        this._active = dir === 'enter';
        this._direction = null;
        this._sinceCandidate = 0;
        return this._active ? 'enter' : 'exit';
      }
      return null;
    }

    // 方向改变或首次：重置候选起点
    this._direction = dir;
    this._sinceCandidate = t;
    return null;
  }

  reset() {
    this._active = false;
    this._direction = null;
    this._sinceCandidate = 0;
  }
}

module.exports = { Hysteresis };
