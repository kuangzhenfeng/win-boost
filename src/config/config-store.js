'use strict';

const { EventEmitter } = require('events');
const { DEFAULT_CONFIG, CONFIG_TYPES } = require('../constants');
const { getConfigPath } = require('../util/paths');
const { atomicWriteJson, readJsonSafe } = require('../util/atomic-write');
const { enforceConstraints } = require('../web/schema');

/**
 * ConfigStore：加载 / 校验 / 原子保存 / 默认合并 / 变更通知。
 * - load 时合并默认值（新字段向后兼容），非法字段回退默认并记录。
 * - 仅允许白名单字段；未知字段忽略。
 * - set/replace 原子写盘，并 emit('change', fullConfig)。
 * - 跨字段约束（如升档阈值须 > 降档阈值）在每次落盘前由 enforceConstraints 兜底，
 *   保证存储数据始终自洽，防止 API 直写坏数据或历史不自洽数据。
 */
class ConfigStore extends EventEmitter {
  constructor({ logger } = {}) {
    super();
    this._logger = logger;
    this._cfg = this._clone(DEFAULT_CONFIG);
    this._path = getConfigPath();
    this._loaded = false;
  }

  _clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  _logWarn(msg) {
    if (this._logger && this._logger.warn) this._logger.warn(`[config] ${msg}`);
  }

  /**
   * 校验单字段是否符合规范。
   * @param {string} key
   * @param {any} val
   */
  _isValid(key, val) {
    const spec = CONFIG_TYPES[key];
    if (!spec) return false;
    if (typeof spec === 'string') {
      // eslint-disable-next-line valid-typeof
      return typeof val === spec;
    }
    if (typeof spec === 'function') {
      try {
        return !!spec(val);
      } catch {
        return false;
      }
    }
    return false;
  }

  load() {
    const raw = readJsonSafe(this._path, null);
    if (!raw || typeof raw !== 'object') {
      // 首次：写默认
      this._cfg = this._clone(DEFAULT_CONFIG);
      this._persist();
      this._loaded = true;
      return this._cfg;
    }
    // 以默认为基底，逐字段合并校验
    const merged = this._clone(DEFAULT_CONFIG);
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const val = raw[key];
      if (val === undefined) continue;
      if (this._isValid(key, val)) {
        merged[key] = val;
      } else {
        this._logWarn(`非法字段 ${key}=${JSON.stringify(val)}，回退默认`);
      }
    }
    // 跨字段约束兜底（自洽后落盘）
    this._cfg = enforceConstraints(merged);
    this._loaded = true;
    // 合并后落盘，保证 schema 一致
    this._persist();
    return this._cfg;
  }

  _persist() {
    try {
      atomicWriteJson(this._path, this._cfg);
    } catch (e) {
      this._logWarn(`保存配置失败: ${e && e.message}`);
    }
  }

  get(key) {
    return key === undefined ? this._cfg : this._cfg[key];
  }

  getAll() {
    return this._clone(this._cfg);
  }

  /**
   * 深合并部分字段并落盘。
   * @param {object} partial
   */
  set(partial) {
    let changed = false;
    for (const [key, val] of Object.entries(partial || {})) {
      if (this._isValid(key, val)) {
        this._cfg[key] = val;
        changed = true;
      } else {
        this._logWarn(`set() 忽略非法字段 ${key}=${JSON.stringify(val)}`);
      }
    }
    if (changed) {
      // 跨字段约束兜底：例如降档被设到 ≥ 升档时，升档会被夹到自洽值
      this._cfg = enforceConstraints(this._cfg);
      this._persist();
      this.emit('change', this._clone(this._cfg));
    }
    return this._cfg;
  }

  replace(newCfg) {
    if (!newCfg || typeof newCfg !== 'object') return this._cfg;
    const merged = this._clone(DEFAULT_CONFIG);
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const val = newCfg[key];
      if (val !== undefined && this._isValid(key, val)) merged[key] = val;
    }
    this._cfg = enforceConstraints(merged);
    this._persist();
    this.emit('change', this._clone(this._cfg));
    return this._cfg;
  }
}

module.exports = { ConfigStore };
