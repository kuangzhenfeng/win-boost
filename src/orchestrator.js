'use strict';

const { EventEmitter } = require('events');
const { IdleMonitor } = require('./monitors/idle-monitor');
const { CpuMonitor } = require('./monitors/cpu-monitor');
const { JankMonitor } = require('./monitors/jank-monitor');
const { LoadMonitor } = require('./monitors/load-monitor');
const { StateMachine } = require('./state/state-machine');
const { getProcessorPerformance } = require('./native/pdh-native');
const { Scheme } = require('./constants');

/**
 * Orchestrator：把 monitors → stateMachine → powerController 串起来，
 * 并把状态快照推给 TrayUI。处理 manual/paused。
 *
 * 信号流：
 *   IdleMonitor.signal  ─┐
 *   CpuMonitor.sample   ─┼─→ LoadMonitor ─signal─→ SM.feed ─→ Power.setActive ─→ Tray.refresh
 *   JankMonitor.sample  ─┤
 *   (PDH 周期采样)       ─┘
 */
class Orchestrator extends EventEmitter {
  constructor({ cfg, power, tray, debug = false, logger } = {}) {
    super();
    this._cfg = cfg;
    this._power = power;
    this._tray = tray;
    this._debug = debug;
    this._logger = logger;
    this._paused = cfg.mode === 'manual';

    this._sm = new StateMachine({
      cfg,
      available: power ? power.available : [],
      logger,
    });

    this._idle = new IdleMonitor({
      idleThresholdMs: cfg.idleThresholdMin * 60 * 1000,
      pollMs: cfg.idlePollMs,
      debug,
      logger,
    });

    this._cpu = new CpuMonitor({
      intervalMs: cfg.cpuSampleMs,
      ema: cfg.cpuEma,
      logger,
    });

    this._jank = new JankMonitor({ enabled: cfg.jankEnabled !== false, logger });

    this._load = new LoadMonitor({ cfg, debug, logger });

    this._pdhTimer = null;
    this._pdhUsable = cfg.pdhEnabled !== false && !!getProcessorPerformance();

    // 心跳周期：把"当前工况"喂给状态机的频率。
    // 关键：monitor 的 signal 是边沿触发（只在 high↔normal 翻转时发一次），
    // 若那次恰好落在 minDwell 驻留窗口内被状态机抑制，就再也不会重发 → 转移永远不发生。
    // 心跳用 level（当前态）周期重喂，使被抑制的转移在驻留期满后自然重试。
    this._beatMs = cfg.idlePollMs || 2000;
    this._beatTimer = null;
    this._startedAt = Date.now();
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[orchestrator] ${msg}`);
  }

  async start() {
    // 初始：把当前系统档位读回来作为状态机起点
    const cur = this._power ? await this._power.getCurrent() : null;
    this._sm.init(cur ? cur.scheme : Scheme.BALANCED);

    // 空闲信号
    this._idle.on('signal', (s) => this._ingest('idle', s));
    if (this._debug) {
      this._idle.on('sample', ({ idleMs }) => {
        if (this._logger && this._logger.debug) {
          this._logger.debug(`[idle] idleMs=${Math.round(idleMs)}`);
        }
      });
    }

    // CPU → Load → 信号
    this._cpu.on('sample', ({ pct }) => {
      if (this._debug && this._logger && this._logger.debug) {
        this._logger.debug(`[cpu] ema=${pct.toFixed(1)}%`);
      }
      this._load.feedCpu(pct);
    });
    // Jank（卡顿探针）→ Load → 信号
    this._jank.on('sample', ({ janksPerMin }) => {
      if (this._debug && this._logger && this._logger.debug) {
        this._logger.debug(`[jank] janks/min=${janksPerMin}`);
      }
      this._load.feedJank(janksPerMin);
    });
    this._load.on('sample', (s) => {
      if (this._debug && this._logger && this._logger.debug) {
        this._logger.debug(`[load] high=${s.high} cpu=${s.cpuActive} pdh=${s.pdhActive} jank=${s.jankActive} perfPct=${s.pdhPerfPct.toFixed(0)} janks/min=${s.janksPerMin}`);
      }
    });
    this._load.on('signal', (s) => this._ingest('load', s));

    // PDH 副判据周期采样（处理器性能比）
    if (this._cfg.pdhEnabled !== false) {
      this._pdhTimer = setInterval(() => this._samplePdh(), this._cfg.pdhPollMs || 1000);
      if (this._pdhTimer.unref) this._pdhTimer.unref();
    }

    // 状态机转移 → 施效
    this._sm.on('transition', ({ to }) => {
      this._apply(to);
    });

    // 托盘命令
    if (this._tray) {
      this._tray.on('command', (cmd) => this._onTrayCommand(cmd));
      this._tray.refresh(this._snapshot());
    }

    // manual 模式：锁定到 manualScheme
    if (this._cfg.mode === 'manual') {
      this._sm.setManual(this._cfg.manualScheme);
      this._apply(this._cfg.manualScheme);
    }

    // 心跳：周期把当前工况重喂状态机，让被 minDwell 抑制的转移在期满后重试
    this._beatTimer = setInterval(() => this._heartbeat(), this._beatMs);
    if (this._beatTimer.unref) this._beatTimer.unref();

    this._idle.start();
    this._cpu.start();
    if (this._cfg.jankEnabled !== false) this._jank.start();
  }

  /**
   * 重喂当前工况。优先级：load_high > idle > active/load_normal。
   *
   * 关键取舍：高负载优先于空闲。
   *  - 真实场景里"满载但无键鼠输入"很常见（后台编译/导出/下载/转码），
   *    此时若按 idle 降档会让任务变慢、反而更耗电（拉长高负载时间）。
   *  - 因此只要 LoadMonitor 判 high，无论是否空闲都保持升档；
   *    只有低负载且空闲超阈值才进 SAVER。
   *
   * 监听器的 signal 是边沿触发（仅 high↔normal 翻转时发一次），若那次
   * 恰好落在 minDwell 驻留窗口被状态机抑制，就再不会重发 → 转移永不发生。
   * 心跳用 level（当前态）周期重喂，使被抑制的转移在驻留期满后自然重试。
   */
  _heartbeat() {
    if (this._paused) return;
    const high = this._load.isHigh;

    // 1) 高负载：最高优先级，保持升档（覆盖空闲判定）
    if (high) {
      this._heartbeatApply('load_high');
      return;
    }
    // 2) 低负载且空闲超阈值：降 SAVER
    if (this._idle.isIdle) {
      this._heartbeatApply('idle');
      return;
    }
    // 3) 低负载且非空闲：若有输入活动则脱离 SAVER 回 BALANCED
    if (this._sm.state === Scheme.SAVER) {
      this._heartbeatApply('active'); // SAVER → BALANCED
      return;
    }
    // 4) 否则维持：显式发 load_normal，让 PERFORMANCE→BALANCED 降档能重试
    this._heartbeatApply('load_normal');
  }

  _heartbeatApply(signalType) {
    const out = this._sm.feed({ type: signalType });
    if (out) this._apply(out);
  }

  /** PDH 副判据采样（回退：PDH 不可用时喂 null） */
  _samplePdh() {
    const p = getProcessorPerformance();
    this._load.feedPdh(p ? p.perfPct : null);
  }

  _ingest(src, signal) {
    if (this._paused) {
      this._log('debug', `已暂停，忽略 ${src} 信号 ${signal.type}`);
      return;
    }
    const out = this._sm.feed(signal);
    if (out) this._apply(out);
  }

  async _apply(scheme) {
    if (!scheme || !this._power) return;
    const res = await this._power.setActive(scheme);
    if (res) this._refreshTray();
  }

  _onTrayCommand(cmd) {
    switch (cmd.kind) {
      case 'mode_auto':
        this._paused = false;
        this._sm.setAuto();
        this._log('info', '切换到自动模式');
        this._refreshTray();
        break;
      case 'manual':
        this._paused = true;
        this._sm.setManual(cmd.scheme);
        this._apply(cmd.scheme);
        this._log('info', `手动切到 ${cmd.scheme}（自动切换已暂停）`);
        break;
      case 'pause':
        this._paused = !!cmd.value;
        if (this._paused) this._sm.setManual(this._sm.state);
        else this._sm.setAuto();
        this._log('info', this._paused ? '已暂停自动切换' : '已恢复自动切换');
        this._refreshTray();
        break;
      case 'autostart':
        this.emit('autostart', !!cmd.value);
        break;
      case 'settings':
        this.emit('settings');
        break;
      case 'web':
        this.emit('web');
        break;
      case 'quit':
        this.emit('quit');
        break;
      default:
        break;
    }
  }

  _refreshTray() {
    if (this._tray) this._tray.refresh(this._snapshot());
    // 状态变化同步推送给 web 侧（SSE）
    this.emit('runtime', this.getRuntime());
  }

  _snapshot() {
    return {
      state: this._sm.state,
      manual: this._sm.isManual,
      paused: this._paused,
      available: this._power ? this._power.available : [],
    };
  }

  /**
   * 运行态快照（供 web 状态展示与 SSE 推送）。
   */
  getRuntime() {
    return {
      state: this._sm.state,
      manual: this._sm.isManual,
      paused: this._paused,
      available: this._power ? this._power.available : [],
      cpuEma: this._cpu.lastPct,
      idleMs: this._idle.lastIdleMs,
      idleThresholdMs: this._idle.thresholdMs,
      pdhPerfPct: this._load.pdhPerfPct,
      janksPerMin: this._load.janksPerMin,
      isHigh: this._load.isHigh,
      uptime: Date.now() - (this._startedAt || Date.now()),
    };
  }

  /**
   * 配置热重载：把新 cfg 应用到正在运行的 monitors / state-machine，不重启进程。
   * 忽略非运行时字段（version/schemeMapping/lastScheme/autoStart/logLevel）。
   * @param {object} cfg 完整配置（来自 ConfigStore.getAll）
   */
  applyConfig(cfg) {
    this._cfg = { ...this._cfg, ...cfg };
    // idle
    this._idle.setThreshold(cfg.idleThresholdMin * 60 * 1000);
    this._idle.setPollMs(cfg.idlePollMs);
    this._beatMs = cfg.idlePollMs || 2000;
    // cpu
    this._cpu.setInterval(cfg.cpuSampleMs);
    this._cpu.setEma(cfg.cpuEma);
    // load（重建滞回，保留态）
    this._load.applyThresholds(cfg);
    // jank 开关联动（探针自带 start/stop）
    const jankOn = cfg.jankEnabled !== false;
    if (jankOn && !this._jank.enabled) {
      this._jank.setEnabled(true);
      this._jank.start();
    } else if (!jankOn && this._jank.enabled) {
      this._jank.stop();
      this._load.feedJank(null);
    }
    // state machine
    this._sm.setPreferUltimate(cfg.preferUltimate !== false);
    this._sm.setMinDwellMs(cfg.minDwellSec * 1000);
    // pdh timer 开关联动
    const pdhOn = cfg.pdhEnabled !== false;
    if (pdhOn && !this._pdhTimer) {
      this._pdhTimer = setInterval(() => this._samplePdh(), cfg.pdhPollMs || 1000);
      if (this._pdhTimer.unref) this._pdhTimer.unref();
    } else if (!pdhOn && this._pdhTimer) {
      clearInterval(this._pdhTimer);
      this._pdhTimer = null;
      this._load.feedPdh(null);
    }
    // beat 周期变更：重启心跳
    this._restartBeat();
    // mode
    if (cfg.mode === 'manual') {
      this._paused = true;
      this._sm.setManual(cfg.manualScheme);
      this._apply(cfg.manualScheme);
    } else if (this._paused) {
      this._paused = false;
      this._sm.setAuto();
    }
    this._refreshTray();
  }

  _restartBeat() {
    if (this._beatTimer) clearInterval(this._beatTimer);
    this._beatTimer = setInterval(() => this._heartbeat(), this._beatMs);
    if (this._beatTimer.unref) this._beatTimer.unref();
  }

  /** web 侧调用托盘等价命令（mode/pause/autostart/web）。 */
  command(cmd) {
    this._onTrayCommand(cmd);
  }

  stop() {
    this._idle.stop();
    this._cpu.stop();
    this._jank.stop();
    if (this._beatTimer) clearInterval(this._beatTimer);
    this._beatTimer = null;
    if (this._pdhTimer) clearInterval(this._pdhTimer);
    this._pdhTimer = null;
  }
}

module.exports = { Orchestrator };
