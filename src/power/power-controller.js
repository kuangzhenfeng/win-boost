'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { Scheme, BUILTIN_GUID_REF } = require('../constants');
const {
  decodePowercfg,
  parseActiveScheme,
  parseAllSchemes,
  classifyScheme,
} = require('./scheme-registry');

const execFileP = promisify(execFile);
const POWERCMD = 'powercfg';
const CMD_TIMEOUT_MS = 3000;

// 标准方案的轻量友好名（/l 未列出时兜底显示用）
const SCHEME_LABEL_LITE = {
  [Scheme.SAVER]: '节能',
  [Scheme.BALANCED]: '平衡',
  [Scheme.PERFORMANCE]: '高性能',
  [Scheme.ULTIMATE]: '卓越性能',
};

/**
 * PowerController：封装所有 powercfg 调用。
 *
 * 注意内置方案的标准 GUID（见 constants.BUILTIN_GUID_REF）：
 *  - 节能/平衡/高性能 三个方案即使 powercfg /l 不列出，powercfg /setactive <标准GUID> 也能用。
 *  - 卓越性能(Ultimate) 必须用户先 -duplicatescheme 启用，否则 setactive 失败 → 降级到高性能。
 *
 * 因此本类的"可用性"判定：对节能/平衡/高性能始终视为可用（用标准 GUID），
 * 对卓越性能用 /l 是否列出 + setactive 实测探测。
 * setActive 幂等：与当前相同则跳过。
 */
class PowerController {
  constructor({ logger } = {}) {
    this._logger = logger;
    // mapping: { SAVER: {guid, friendly}, ... }
    this._mapping = {};
    // available: 按性能从低到高排序且实际可用的档位
    this._available = [];
    this._ultimateUsable = false;
    this._inited = false;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[power] ${msg}`);
  }

  async _run(args) {
    try {
      // 用 Buffer 收集，再按 GBK 解码（中文系统 powercfg 输出非 UTF-8）
      const result = await execFileP(POWERCMD, args, {
        windowsHide: true,
        timeout: CMD_TIMEOUT_MS,
        maxBuffer: 1 * 1024 * 1024,
        encoding: 'buffer',
      });
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
      return decodePowercfg(stdout);
    } catch (e) {
      const errOut = e && e.stdout ? decodePowercfg(e.stdout) : '';
      throw new Error(`powercfg ${args.join(' ')} 失败: ${e && e.message}${errOut ? ` | ${errOut}` : ''}`);
    }
  }

  /**
   * 启动期初始化：
   *  1. powercfg /l 枚举本机方案，建立 GUID→档位映射（用于识别当前活动方案友好名）。
   *  2. 节能/平衡/高性能用标准 GUID 始终可用；/l 缺失时以标准 GUID 兜底。
   *  3. 卓越性能用 setactive 实测探测，不可用则标记并降级。
   */
  async init() {
    // 1) 先把 /l 里的方案解析出来，便于识别自定义/重复方案
    let listed = [];
    try {
      const out = await this._run(['/l']);
      listed = parseAllSchemes(out);
      this._log('info', `枚举到 ${listed.length} 个电源方案`);
    } catch (e) {
      this._log('warn', `powercfg /l 失败，仅用标准 GUID: ${e.message}`);
    }

    this._mapping = {};
    // 1a) 优先采纳 /l 中关键字匹配到的方案
    for (const s of listed) {
      const scheme = classifyScheme(s);
      if (scheme && !this._mapping[scheme]) {
        this._mapping[scheme] = { guid: s.guid, friendly: s.friendlyName };
      }
    }
    // 2) 节能/平衡/高性能用标准 GUID 兜底（这些 setactive 始终可用）
    for (const s of [Scheme.SAVER, Scheme.BALANCED, Scheme.PERFORMANCE]) {
      if (!this._mapping[s]) {
        this._mapping[s] = { guid: BUILTIN_GUID_REF[s], friendly: SCHEME_LABEL_LITE[s] };
      }
    }
    // 卓越性能：先尝试用 /l 或标准 GUID
    if (!this._mapping[Scheme.ULTIMATE]) {
      this._mapping[Scheme.ULTIMATE] = { guid: BUILTIN_GUID_REF[Scheme.ULTIMATE], friendly: SCHEME_LABEL_LITE[Scheme.ULTIMATE] };
    }

    // 3) 探测卓越性能是否真的可 setactive
    this._ultimateUsable = await this._probeUltimate();

    // available：按性能从低到高
    this._available = [Scheme.SAVER, Scheme.BALANCED, Scheme.PERFORMANCE];
    if (this._ultimateUsable) this._available.push(Scheme.ULTIMATE);

    if (!this._ultimateUsable) {
      this._log('info', '卓越性能不可用（未启用），升档时回退到高性能');
    } else {
      this._log('info', '卓越性能可用');
    }
    this._inited = true;
    return this;
  }

  /** 探测卓越性能：切过去再切回，看是否成功。失败则不可用。 */
  async _probeUltimate() {
    const before = await this.getCurrentRaw();
    let ok = false;
    try {
      await this._run(['/setactive', BUILTIN_GUID_REF[Scheme.ULTIMATE]]);
      ok = true;
    } catch {
      ok = false;
    }
    // 探测后恢复原方案
    if (before && before.guid) {
      try {
        await this._run(['/setactive', before.guid]);
      } catch {
        // ignore：恢复失败不影响判定
      }
    }
    return ok;
  }

  /** getCurrent 的原始版本（不分类），用于探测时记录原方案 */
  async getCurrentRaw() {
    try {
      const out = await this._run(['/getactivescheme']);
      return parseActiveScheme(out);
    } catch {
      return null;
    }
  }

  get available() {
    return this._available.slice();
  }

  get mapping() {
    return JSON.parse(JSON.stringify(this._mapping));
  }

  /**
   * 解析档位为实际 GUID。ULTIMATE 不可用时降级到 PERFORMANCE。
   * @param {string} scheme Scheme 枚举
   * @returns {{guid:string, scheme:string, friendly:string}|null}
   */
  resolveGuid(scheme) {
    if (!this._inited) return null;
    if (scheme === Scheme.ULTIMATE && !this._available.includes(Scheme.ULTIMATE)) {
      scheme = Scheme.PERFORMANCE; // 降级
    }
    const entry = this._mapping[scheme];
    if (!entry) return null;
    return { guid: entry.guid, scheme, friendly: entry.friendly };
  }

  /**
   * 读取当前活动方案。
   * @returns {{guid:string, friendlyName:string, scheme:string|null}|null}
   */
  async getCurrent() {
    try {
      const out = await this._run(['/getactivescheme']);
      const parsed = parseActiveScheme(out);
      if (!parsed) return null;
      return {
        guid: parsed.guid,
        friendlyName: parsed.friendlyName,
        scheme: classifyScheme(parsed),
      };
    } catch (e) {
      this._log('error', `读取活动方案失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 切换到指定档位（幂等）。
   * @param {string} scheme Scheme 枚举
   * @returns {{changed:boolean, scheme:string, guid:string}|null}
   */
  async setActive(scheme) {
    const resolved = this.resolveGuid(scheme);
    if (!resolved) {
      this._log('warn', `无法解析档位 ${scheme} 的 GUID，跳过切换`);
      return null;
    }
    const cur = await this.getCurrent();
    if (cur && cur.guid === resolved.guid) {
      // 幂等：相同则跳过
      return { changed: false, scheme: resolved.scheme, guid: resolved.guid };
    }
    try {
      await this._run(['/setactive', resolved.guid]);
      this._log('info', `切换电源方案 → ${resolved.scheme} (${resolved.guid})`);
      return { changed: true, scheme: resolved.scheme, guid: resolved.guid };
    } catch (e) {
      this._log('error', `切换到 ${resolved.scheme} 失败: ${e.message}`);
      return null;
    }
  }
}

module.exports = { PowerController };
