'use strict';

const { EventEmitter } = require('events');
const { Hysteresis } = require('../state/hysteresis');
const { getDwmTiming, isAvailable } = require('../native/dwm-native');

/**
 * LoadMonitor：聚合 CPU 与 DWM 丢帧，带滞回，发 load_high / load_normal 信号。
 *
 * 防抖策略（关键）：
 *  - CPU 与 DWM 任一判为 high → 整体 high（升档）。
 *  - 两者都 normal → 整体 normal（降档）。
 *  这样避免两者交替抖动时反复跳档。
 *
 * DWM 不可用（null）时，仅依赖 CPU。
 *
 * 事件：
 *   - 'signal' { type: 'load_high' | 'load_normal' }
 *   - 'sample' { cpu, dwmDropsPerMin } （debug 观察）
 */
class LoadMonitor extends EventEmitter {
  constructor({
    cfg,
    now = () => Date.now(),
    debug = false,
    logger,
  } = {}) {
    super();
    this._logger = logger;
    this._debug = debug;
    this._now = now;
    this._dwmEnabled = cfg ? cfg.dwmEnabled !== false : true;

    // CPU 滞回：进入阈值高，退出阈值低
    this._cpu = new Hysteresis({
      enter: cfg.cpuHighPct,
      exit: cfg.cpuCooldownPct,
      enterHoldMs: cfg.cpuHighHoldSec * 1000,
      exitHoldMs: cfg.cpuCooldownHoldSec * 1000,
      now,
    });

    // DWM 滞回：以"每分钟丢帧数"为量
    this._dwm = new Hysteresis({
      enter: cfg.dwmDropFramesPerMin,
      exit: 0,
      enterHoldMs: cfg.dwmHoldSec * 1000,
      exitHoldMs: cfg.dwmHoldSec * 1000,
      now,
    });

    // DWM 累计丢帧与时间窗口（按分钟折算）
    this._dwmLast = null; // {cFrameDropped, qpc}
    this._dwmDropsPerMin = 0;

    this._cpuActive = false;
    this._dwmActive = false;
    this._high = false;
    this._dwmUsable = isAvailable();
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[load] ${msg}`);
  }

  /** CPU 采样喂入（pct 0..100） */
  feedCpu(pct) {
    const edge = this._cpu.feed(pct);
    if (edge === 'enter') this._cpuActive = true;
    else if (edge === 'exit') this._cpuActive = false;
    this._recompute();
  }

  /** DWM 采样喂入（由 orchestrator 周期调用，返回 timing 或 null） */
  feedDwm(timing) {
    if (!this._dwmEnabled || !timing) {
      this._dwmDropsPerMin = 0;
      // DWM 不可用：强制 DWM 判据为非 high
      if (this._dwmActive) {
        this._dwmActive = false;
        this._recompute();
      }
      return;
    }
    const cur = { cFrameDropped: timing.cFrameDropped, qpc: timing.qpc, qpcFreq: timing.qpcFreq };
    if (this._dwmLast) {
      const dtSec = (cur.qpc - this._dwmLast.qpc) / (cur.qpcFreq || 1);
      const dropped = cur.cFrameDropped - this._dwmLast.cFrameDropped;
      if (dtSec > 0 && dropped >= 0) {
        this._dwmDropsPerMin = (dropped / dtSec) * 60;
      }
    }
    this._dwmLast = cur;
    const edge = this._dwm.feed(this._dwmDropsPerMin);
    if (edge === 'enter') this._dwmActive = true;
    else if (edge === 'exit') this._dwmActive = false;
    this._recompute();
  }

  /** 触发一次 DWM 采样并喂入（封装 getDwmTiming） */
  sampleDwm() {
    this.feedDwm(getDwmTiming());
  }

  _recompute() {
    // 任一 high → high；两者 normal → normal
    const high = this._cpuActive || this._dwmActive;
    if (high !== this._high) {
      this._high = high;
      const type = high ? 'load_high' : 'load_normal';
      this._log('info', `${type} (cpu=${this._cpuActive}, dwm=${this._dwmActive}, drops/min=${this._dwmDropsPerMin.toFixed(1)})`);
      this.emit('signal', { type });
    }
    if (this._debug) {
      // 状态快照（供 debug 观察滞回过程），每次都发以便上层连续打印
      this.emit('sample', {
        high: this._high,
        cpuActive: this._cpuActive,
        dwmActive: this._dwmActive,
        dwmDropsPerMin: this._dwmDropsPerMin,
      });
    }
  }

  get isHigh() {
    return this._high;
  }
}

module.exports = { LoadMonitor };
