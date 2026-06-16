'use strict';

const os = require('os');
const { EventEmitter } = require('events');

/**
 * 把 os.cpus() 的 times 汇总成 {idle, total}。
 * total = user + nice + sys + irq + idle。
 */
function summarize(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

/**
 * CpuMonitor：双采样算整机 CPU 占用率（所有逻辑核平均），EMA 平滑。
 * 事件：
 *   - 'sample' { pct } pct 为 0..100 的 EMA 平滑值。
 */
class CpuMonitor extends EventEmitter {
  constructor({ intervalMs = 1000, ema = 0.3, now, logger } = {}) {
    super();
    this._interval = intervalMs;
    this._alpha = ema;
    this._now = now || (() => Date.now());
    this._logger = logger;
    this._prev = null;
    this._ema = null;
    this._timer = null;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[cpu] ${msg}`);
  }

  start() {
    if (this._timer) return;
    this._prev = summarize(os.cpus());
    this._timer = setInterval(() => this._tick(), this._interval);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    const cur = summarize(os.cpus());
    const dTotal = cur.total - this._prev.total;
    const dIdle = cur.idle - this._prev.idle;
    this._prev = cur;
    let pct = 0;
    if (dTotal > 0) {
      pct = (1 - dIdle / dTotal) * 100;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
    }
    this._ema = this._ema === null ? pct : this._ema * (1 - this._alpha) + pct * this._alpha;
    this.emit('sample', { pct: this._ema });
  }
}

module.exports = { CpuMonitor, summarize };
