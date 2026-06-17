'use strict';

/**
 * 全局常量：档位枚举、内置 GUID 参考、默认阈值、路径键名。
 * 注意：内置 GUID 仅作兜底比对，真正以 powercfg /l 实测为准。
 */

// 档位逻辑枚举。ULTIMATE 不可用时由 PowerController 并入 PERFORMANCE。
const Scheme = Object.freeze({
  SAVER: 'SAVER',
  BALANCED: 'BALANCED',
  PERFORMANCE: 'PERFORMANCE',
  ULTIMATE: 'ULTIMATE',
});

// 全部档位，按性能从低到高排序（用于 UI 显示与降级回退）
const SCHEME_ORDER = [Scheme.SAVER, Scheme.BALANCED, Scheme.PERFORMANCE, Scheme.ULTIMATE];

// 档位的中文友好名（托盘显示用）
const SCHEME_LABEL = {
  SAVER: '节能',
  BALANCED: '平衡',
  PERFORMANCE: '高性能',
  ULTIMATE: '卓越性能',
};

// Windows 内置方案标准 GUID（经实测 powercfg /setactive 可用，即使 /l 不列出）。
// 节能 a1841308-...、平衡 381b4222-...、高性能 8c5e7fda-...、卓越性能 e9a42b02-...
// 唯独卓越性能需用户先 powercfg -duplicatescheme 启用，否则 setactive 失败。
const BUILTIN_GUID_REF = {
  SAVER: 'a1841308-3541-4fab-bc81-f71556f20b4a',
  BALANCED: '381b4222-f694-41f0-9685-ff5bb260df2e',
  PERFORMANCE: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  ULTIMATE: 'e9a42b02-d5df-448d-aa00-03f14749eb61',
};

const APP_NAME = 'win-boost';
const APP_DISPLAY = 'Win-Boost';

// 开机自启注册表项（用户级 HKCU，无需管理员）
const REG_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE_NAME = APP_NAME;

// 配置默认值。ConfigStore 用它做"缺失字段补默认 + 非法值回退"。
// 从 src/config/defaults.json 加载（单一事实来源外置为数据文件，便于查看/维护）。
// 深拷贝一份并冻结，避免运行中被误改；每次 require 拿到独立副本。
const DEFAULT_CONFIG = Object.freeze(JSON.parse(JSON.stringify(require('./config/defaults.json'))));

// 配置字段类型规范（用于 ConfigStore 校验）
const CONFIG_TYPES = {
  version: 'number',
  mode: (v) => v === 'auto' || v === 'manual',
  manualScheme: (v) => Object.values(Scheme).includes(v),
  idleThresholdMin: 'number',
  idlePollMs: 'number',
  cpuHighPct: 'number',
  cpuCooldownPct: 'number',
  cpuHighHoldSec: 'number',
  cpuCooldownHoldSec: 'number',
  cpuEma: 'number',
  cpuSampleMs: 'number',
  pdhEnabled: 'boolean',
  pdhHighPct: 'number',
  pdhHoldSec: 'number',
  pdhPollMs: 'number',
  jankEnabled: 'boolean',
  jankPerMin: 'number',
  jankHoldSec: 'number',
  uiBoostEnabled: 'boolean',
  uiBoostPriorityLevel: 'number',
  uiBoostSystemResponsiveness: 'number',
  uiBoostEnableNetworkThrottle: 'boolean',
  preferUltimate: 'boolean',
  minDwellSec: 'number',
  autoStart: 'boolean',
  schemeMapping: 'object',
  lastScheme: (v) => v === null || Object.values(Scheme).includes(v),
  logLevel: 'string',
};

module.exports = {
  Scheme,
  SCHEME_ORDER,
  SCHEME_LABEL,
  BUILTIN_GUID_REF,
  APP_NAME,
  APP_DISPLAY,
  REG_RUN_KEY,
  REG_VALUE_NAME,
  DEFAULT_CONFIG,
  CONFIG_TYPES,
};
