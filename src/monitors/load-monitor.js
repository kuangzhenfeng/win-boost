'use strict';

const { EventEmitter } = require('events');
const { Hysteresis } = require('../state/hysteresis');

/**
 * LoadMonitor：聚合 CPU 利用率、处理器性能比、卡顿，带滞回，发 load_high / load_normal 信号。
 *
 * 防抖策略（关键）：
 *  - CPU / PDH / Jank 任一判为 high → 整体 high（升档）。
 *  - 三者都 normal → 整体 normal（降档）。
 *  这样避免任一路抖动时反复跳档。
 *
 * 各判据失效（CPU/Jank 路无失效；PDH 在不可用时）返回 null，仅依赖其余。
 *
 * 事件：
 *   - 'signal' { type: 'load_high' | 'load_normal' }
 *   - 'sample' { pdhPerfPct, janksPerMin } （debug 观察）
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
    this._pdhEnabled = cfg ? cfg.pdhEnabled !== false : true;
    this._jankEnabled = cfg ? cfg.jankEnabled !== false : true;

    // CPU 滞回：进入阈值高，退出阈值低
    this._cpu = new Hysteresis({
      enter: cfg.cpuHighPct,
      exit: cfg.cpuCooldownPct,
      enterHoldMs: cfg.cpuHighHoldSec * 1000,
      exitHoldMs: cfg.cpuCooldownHoldSec * 1000,
      now,
    });

    // PDH 滞回：以"% Processor Performance"为量
    // exit 固定 100（标称频率，回到不睿频即退出；与 enter≥110 形成死区）
    this._pdh = new Hysteresis({
      enter: cfg.pdhHighPct,
      exit: 100,
      enterHoldMs: cfg.pdhHoldSec * 1000,
      exitHoldMs: cfg.pdhHoldSec * 1000,
      now,
    });

    // 卡顿滞回：以"每分钟卡顿次数"为量（exit:0）
    this._jank = new Hysteresis({
      enter: cfg.jankPerMin,
      exit: 0,
      enterHoldMs: cfg.jankHoldSec * 1000,
      exitHoldMs: cfg.jankHoldSec * 1000,
      now,
    });

    this._cpuActive = false;
    this._pdhActive = false;
    this._jankActive = false;
    this._pdhPerfPct = 0;
    this._janksPerMin = 0;
    this._high = false;
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

  /** 处理器性能比采样喂入（perfPct 为 % Processor Performance，100=标称/>100=睿频） */
  feedPdh(perfPct) {
    if (!this._pdhEnabled || perfPct == null || !isFinite(perfPct)) {
      // PDH 不可用：强制 PDH 判据为非 high
      if (this._pdhActive) {
        this._pdhActive = false;
        this._recompute();
      }
      return;
    }
    this._pdhPerfPct = perfPct;
    const edge = this._pdh.feed(perfPct);
    if (edge === 'enter') this._pdhActive = true;
    else if (edge === 'exit') this._pdhActive = false;
    this._recompute();
  }

  /** 卡顿采样喂入（janksPerMin 为每分钟卡顿次数） */
  feedJank(janksPerMin) {
    if (!this._jankEnabled || janksPerMin == null || !isFinite(janksPerMin)) {
      // Jank 不可用/未启用：强制 Jank 判据为非 high
      if (this._jankActive) {
        this._jankActive = false;
        this._recompute();
      }
      return;
    }
    this._janksPerMin = janksPerMin;
    const edge = this._jank.feed(janksPerMin);
    if (edge === 'enter') this._jankActive = true;
    else if (edge === 'exit') this._jankActive = false;
    this._recompute();
  }

  _recompute() {
    // 任一 high → high；三者 normal → normal
    const high = this._cpuActive || this._pdhActive || this._jankActive;
    if (high !== this._high) {
      this._high = high;
      const type = high ? 'load_high' : 'load_normal';
      this._log('info', `${type} (cpu=${this._cpuActive}, pdh=${this._pdhActive}, jank=${this._jankActive}, perfPct=${this._pdhPerfPct.toFixed(0)}, janks/min=${this._janksPerMin})`);
      this.emit('signal', { type });
    }
    if (this._debug) {
      // 状态快照（供 debug 观察滞回过程），每次都发以便上层连续打印
      this.emit('sample', {
        high: this._high,
        cpuActive: this._cpuActive,
        pdhActive: this._pdhActive,
        jankActive: this._jankActive,
        pdhPerfPct: this._pdhPerfPct,
        janksPerMin: this._janksPerMin,
      });
    }
  }

  get isHigh() {
    return this._high;
  }

  // ---- 运行态/热重载（供 web 状态展示与配置热重载）----
  get cpuActive() {
    return this._cpuActive;
  }

  get pdhActive() {
    return this._pdhActive;
  }

  get pdhPerfPct() {
    return this._pdhPerfPct;
  }

  get jankActive() {
    return this._jankActive;
  }

  get janksPerMin() {
    return this._janksPerMin;
  }

  /**
   * 热重载阈值：用新 cfg 重建 CPU/PDH/Jank 三套 Hysteresis。
   * 保留当前 high/cpuActive/pdhActive/jankActive 态，避免热重载瞬间误翻转。
   * @param {object} cfg
   */
  applyThresholds(cfg) {
    this._pdhEnabled = cfg ? cfg.pdhEnabled !== false : true;
    this._jankEnabled = cfg ? cfg.jankEnabled !== false : true;
    const now = this._now;
    const cpuWasActive = this._cpu.active;
    const pdhWasActive = this._pdh.active;
    const jankWasActive = this._jank.active;
    this._cpu = new Hysteresis({
      enter: cfg.cpuHighPct,
      exit: cfg.cpuCooldownPct,
      enterHoldMs: cfg.cpuHighHoldSec * 1000,
      exitHoldMs: cfg.cpuCooldownHoldSec * 1000,
      now,
    });
    this._pdh = new Hysteresis({
      enter: cfg.pdhHighPct,
      exit: 100,
      enterHoldMs: cfg.pdhHoldSec * 1000,
      exitHoldMs: cfg.pdhHoldSec * 1000,
      now,
    });
    this._jank = new Hysteresis({
      enter: cfg.jankPerMin,
      exit: 0,
      enterHoldMs: cfg.jankHoldSec * 1000,
      exitHoldMs: cfg.jankHoldSec * 1000,
      now,
    });
    this._cpuActive = cpuWasActive;
    this._pdhActive = pdhWasActive;
    this._jankActive = jankWasActive;
    this._recompute();
  }
}

module.exports = { LoadMonitor };
