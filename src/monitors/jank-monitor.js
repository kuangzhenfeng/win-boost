'use strict';

const { EventEmitter } = require('events');

/**
 * JankMonitor：卡顿心跳探针（方案 2）。
 *
 * 原理：本进程跑一个高频心跳定时器（≈60fps 量级），测量事件循环触发间隔的异常抖动。
 * win-boost 与前台 app（VS Code/浏览器/Office）共享同一 CPU 调度器与核心，当系统被
 * 编译/打包/索引等 CPU 密集任务占满、调度紧张时，本进程的心跳也会被推迟。
 * 这个"心跳延迟"是"系统调度竞争程度 ≈ 用户可感知卡顿"的有效代理（与显示管线无关，
 * 故非专属 UI 卡顿，而是系统级调度卡顿；为表述简明统一称"卡顿"）。
 *
 * 关键优势：全场景有效——RDP / 锁屏 / 重定向显示 / 全屏独占下都不受影响
 * （测的是进程自身调度，与显示管线无关），且零 native、免管理员。
 *
 * 算法：心跳周期内若 (gap − heartbeatMs) 超过抖动阈值，计一次卡顿；
 *      以滚动 60s 窗口统计卡顿次数（janksPerMin）。
 *
 * 阈值校准（实测）：Windows 默认时钟中断 ~15.6ms，空闲时 20ms 心跳的 gap 抖动上限
 *      ~44ms；jitterThresholdMs=40 远超该抖动，只捕捉真正的调度级卡顿
 *      （gap>60ms ≈ 丢 3 帧@60fps，用户可感知）。
 *
 * 心跳/阈值/窗口硬编码，不暴露为配置——这些是实现旋钮，参数化反而让用户难以调参。
 *      用户侧只有"每分钟卡顿阈值 / 持续秒数 / 开关"（见 LoadMonitor 滞回）。
 *
 * 事件：
 *   - 'sample' { janksPerMin } （按 EMIT_MS 频率向上发，约每 2s 一次，喂 LoadMonitor）
 */
const HEARTBEAT_MS = 20; // 心跳周期（采样率，约 60fps 量级）
const JITTER_THRESHOLD_MS = 40; // gap − HEARTBEAT_MS 超此值算一次卡顿（实际 gap > 60ms）
const WINDOW_MS = 60 * 1000; // 滚动统计窗口（每分钟）
const EMIT_MS = 2000; // 向上 emit 频率（避免每 20ms 喂滞回造成抖动与开销）

class JankMonitor extends EventEmitter {
  constructor({ enabled = true, now, logger } = {}) {
    super();
    this._logger = logger;
    this._now = now || (() => Date.now());
    this._heartbeatMs = HEARTBEAT_MS;
    this._jitterThresholdMs = JITTER_THRESHOLD_MS;
    this._windowMs = WINDOW_MS;
    this._emitMs = EMIT_MS;
    this._enabled = enabled !== false;

    this._recentJanks = []; // 卡顿时刻时间戳（滚动窗口内）
    this._janksPerMin = 0;
    this._last = null;
    this._hbTimer = null;
    this._emitTimer = null;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[jank] ${msg}`);
  }

  start() {
    if (!this._enabled) return;
    if (this._hbTimer) return;
    this._last = null;
    this._hbTimer = setInterval(() => this._tick(), this._heartbeatMs);
    if (this._hbTimer.unref) this._hbTimer.unref();
    this._emitTimer = setInterval(() => {
      this.emit('sample', { janksPerMin: this._janksPerMin });
    }, this._emitMs);
    if (this._emitTimer.unref) this._emitTimer.unref();
  }

  stop() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
    if (this._emitTimer) {
      clearInterval(this._emitTimer);
      this._emitTimer = null;
    }
  }

  /** 心跳一次：测间隔、判卡顿、维护滚动窗口。全部用注入 now()，便于测试。 */
  _tick() {
    const t = this._now();
    if (this._last != null) {
      const gap = t - this._last;
      if (gap - this._heartbeatMs > this._jitterThresholdMs) {
        this._recentJanks.push(t); // 一次卡顿
      }
    }
    this._last = t;
    // 滚动窗口：丢弃 60s 外的旧记录
    const cutoff = t - this._windowMs;
    while (this._recentJanks.length && this._recentJanks[0] < cutoff) {
      this._recentJanks.shift();
    }
    this._janksPerMin = this._recentJanks.length;
  }

  get janksPerMin() {
    return this._janksPerMin;
  }

  get enabled() {
    return this._enabled;
  }

  setEnabled(v) {
    this._enabled = !!v;
    if (!this._enabled) {
      this.stop();
    }
  }
}

module.exports = { JankMonitor };
