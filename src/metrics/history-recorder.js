'use strict';

const { atomicWriteJson, readJsonSafe } = require('../util/atomic-write');
const { getMetricsPath } = require('../util/paths');
const { SCHEME_ORDER } = require('../constants');

/**
 * HistoryRecorder：把 orchestrator 运行态周期采样为时间序列，多级降采样滚降并落盘。
 *
 * 职责边界：只做"数据记录"，不进 orchestrator、不新增 native 调用——
 * 复用 orchestrator.getRuntime() 的现成快照（cpuEma / pdhPerfPct / janksPerMin / state）。
 *
 * 三档桶（复制式滚降：fold 是把上级粒度的汇总写入下一档，不从源档删除）：
 *   raw    1 秒粒度  保留 2 小时（7200 点）  内存     服务 1 小时维度
 *   minute 60 秒粒度 保留 2 天  （2880 点）   落盘     服务 1 天维度
 *   hour   3600 秒   保留 30 天（720 点）     落盘     服务 30 天维度
 *
 * 折叠（rollup）：对"已结束的完整分钟/小时"，按时间边界对齐，
 *   cpu/perf 取平均、scheme 取众数，归并为一个上级点。
 *
 * 持久化：仅 minute/hour 落 metrics.json；fold 产生新点时标 dirty，
 *   每 PERSIST_INTERVAL（60s）若有 dirty 则写一次；stop() 最后写一次。
 *   raw 不落盘（秒级细节，重启可丢，趋势可接受）。
 */
const RAW_CAP = 7200; // 2h × 1s
const MINUTE_CAP = 2880; // 2d × 24 × 60
const HOUR_CAP = 720; // 30d × 24
const PERSIST_INTERVAL = 60 * 1000;
const ROLLUP_STEP_CAP = 100000; // 防御：时钟回拨/损坏数据导致 while 失控

/** 整分钟起点（秒级时间戳）。 */
function minuteStart(sec) {
  return Math.floor(sec / 60) * 60;
}
/** 整小时起点（秒级时间戳）。 */
function hourStart(sec) {
  return Math.floor(sec / 3600) * 3600;
}

/** 数组平均（空返回 0）。 */
function avg(nums) {
  if (!nums.length) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

/** scheme 众数：出现次数最多；并列时按 SCHEME_ORDER（性能从低到高）取靠前者，保证稳定。空输入回退 BALANCED。 */
function modeScheme(schemes) {
  if (!schemes.length) return 'BALANCED';
  const counts = new Map();
  for (const s of schemes) counts.set(s, (counts.get(s) || 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const s of SCHEME_ORDER) {
    const c = counts.get(s) || 0;
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best || 'BALANCED';
}

/** 把一组点折叠成一个上级点（cpu/perf/jank 取平均保留 1 位小数，scheme 取众数）。 */
function aggregate(points, bucketStart) {
  return {
    t: bucketStart,
    cpu: Math.round(avg(points.map((p) => p.cpu)) * 10) / 10,
    perf: Math.round(avg(points.map((p) => p.perf || 0)) * 10) / 10,
    jank: Math.round(avg(points.map((p) => p.jank || 0)) * 10) / 10,
    scheme: modeScheme(points.map((p) => p.scheme)),
  };
}

class HistoryRecorder {
  /**
   * @param {{orchestrator:object, logger?:object, now?:()=>number, intervalMs?:number}} opts
   *   now/intervalMs 注入便于测试（沿用项目其他 monitor 的做法）。
   */
  constructor({ orchestrator, logger, now, intervalMs } = {}) {
    this._orchestrator = orchestrator;
    this._logger = logger;
    this._now = now || (() => Date.now());
    this._intervalMs = intervalMs || 1000;

    this._raw = [];
    this._minute = [];
    this._hour = [];

    const sec = Math.floor(this._now() / 1000);
    this._minFolded = minuteStart(sec); // 下一个待 fold 的分钟起点（< 此值的分钟已 fold）
    this._hrFolded = hourStart(sec);

    this._dirty = false;
    this._lastPersistMs = 0;
    this._timer = null;
    this._path = getMetricsPath();
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[history] ${msg}`);
  }

  // ---- 生命周期 ----
  start() {
    this._load();
    if (this._timer) return;
    this._timer = setInterval(() => this._sample(), this._intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._dirty) this._persist();
  }

  // ---- 采样 ----
  _sample() {
    let rt;
    try {
      rt = this._orchestrator.getRuntime();
    } catch (e) {
      this._log('debug', `采样跳过: ${e && e.message}`);
      return;
    }
    const t = Math.floor(this._now() / 1000);
    this.push({
      t,
      cpu: rt.cpuEma || 0,
      perf: rt.pdhPerfPct || 0,
      jank: rt.janksPerMin || 0,
      scheme: rt.state || 'BALANCED',
    });
    this._maybePersist();
  }

  /** 写入一个秒级采样点并触发滚降。 */
  push(point) {
    this._raw.push(point);
    this._rollup();
    this._trim();
  }

  // ---- 滚降 ----
  _rollup() {
    const sec = Math.floor(this._now() / 1000);
    const curMin = minuteStart(sec);
    const curHr = hourStart(sec);

    // raw → minute：fold [minFolded, curMin) 内已结束的完整分钟
    // raw 为空（如刚加载、无秒级数据）时直接对齐指针，避免空 filter 的无意义循环
    if (this._raw.length) {
      let steps = 0;
      while (this._minFolded < curMin && steps < ROLLUP_STEP_CAP) {
        const lo = this._minFolded;
        const hi = lo + 60;
        const pts = this._raw.filter((p) => p.t >= lo && p.t < hi);
        if (pts.length) {
          this._minute.push(aggregate(pts, lo));
          this._dirty = true;
        }
        this._minFolded = hi;
        steps += 1;
      }
      if (this._minFolded < curMin) {
        // 超出步数上限（异常）：强制对齐，避免一直卡住
        this._minFolded = curMin;
      }
    } else {
      this._minFolded = curMin;
    }

    // minute → hour：fold [hrFolded, curHr) 内已结束的完整小时
    let steps = 0;
    while (this._hrFolded < curHr && steps < ROLLUP_STEP_CAP) {
      const lo = this._hrFolded;
      const hi = lo + 3600;
      const pts = this._minute.filter((p) => p.t >= lo && p.t < hi);
      if (pts.length) {
        this._hour.push(aggregate(pts, lo));
        this._dirty = true;
      }
      this._hrFolded = hi;
      steps += 1;
    }
    if (this._hrFolded < curHr) {
      this._hrFolded = curHr;
    }
  }

  _trim() {
    if (this._raw.length > RAW_CAP) this._raw = this._raw.slice(-RAW_CAP);
    if (this._minute.length > MINUTE_CAP) this._minute = this._minute.slice(-MINUTE_CAP);
    if (this._hour.length > HOUR_CAP) this._hour = this._hour.slice(-HOUR_CAP);
  }

  // ---- 查询 ----
  /**
   * 按维度切片返回时间序列。非法 range 返回 null。
   * @param {'1h'|'1d'|'30d'} range
   * @returns {Array<{t:number,cpu:number,perf:number,jank:number,scheme:string}>|null}
   */
  queryByRange(range) {
    const sinceSec = Math.floor(this._now() / 1000);
    if (range === '1h') {
      const since = sinceSec - 3600;
      return this._raw.filter((p) => p.t >= since);
    }
    if (range === '1d') {
      const since = sinceSec - 24 * 3600;
      return this._minute.filter((p) => p.t >= since);
    }
    if (range === '30d') {
      const since = sinceSec - 30 * 24 * 3600;
      return this._hour.filter((p) => p.t >= since);
    }
    return null;
  }

  // ---- 持久化 ----
  _maybePersist() {
    if (!this._dirty) return;
    if (this._now() - this._lastPersistMs < PERSIST_INTERVAL) return;
    this._persist();
  }

  _persist() {
    try {
      atomicWriteJson(this._path, this._serialize());
      this._dirty = false;
      this._lastPersistMs = this._now();
    } catch (e) {
      this._log('warn', `metrics 落盘失败: ${e && e.message}`);
    }
  }

  _serialize() {
    return {
      minute: this._minute,
      hour: this._hour,
      minFolded: this._minFolded,
      hrFolded: this._hrFolded,
    };
  }

  _load() {
    const data = readJsonSafe(this._path, null);
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.minute)) this._minute = data.minute;
    if (Array.isArray(data.hour)) this._hour = data.hour;
    if (typeof data.minFolded === 'number') this._minFolded = data.minFolded;
    if (typeof data.hrFolded === 'number') this._hrFolded = data.hrFolded;
    this._trim();
    this._log('debug', `加载 metrics: minute=${this._minute.length} hour=${this._hour.length}`);
  }
}

module.exports = { HistoryRecorder, aggregate, modeScheme, minuteStart, hourStart };
