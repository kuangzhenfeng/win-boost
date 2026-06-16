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
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  mode: 'auto', // 'auto' | 'manual'
  manualScheme: Scheme.BALANCED,

  // 空闲检测
  idleThresholdMin: 5,
  idlePollMs: 2000,

  // CPU 主判据（滞回）
  cpuHighPct: 70,
  cpuCooldownPct: 45,
  cpuHighHoldSec: 8,
  cpuCooldownHoldSec: 10,
  cpuEma: 0.3,
  cpuSampleMs: 1000,

  // DWM 副判据
  dwmEnabled: true,
  dwmDropFramesPerMin: 60,
  dwmHoldSec: 8,
  dwmPollMs: 1000,

  // 状态机防抖
  preferUltimate: true,
  minDwellSec: 15,

  // 运行时镜像
  autoStart: false,
  schemeMapping: {}, // 启动填充：{ SAVER:{guid,friendly}, ... }
  lastScheme: null,

  logLevel: 'info',
});

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
  dwmEnabled: 'boolean',
  dwmDropFramesPerMin: 'number',
  dwmHoldSec: 'number',
  dwmPollMs: 'number',
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
