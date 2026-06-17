'use strict';

/**
 * 配置字段元数据：供 GET /api/schema 返回与前端表单渲染共用。
 *
 * control 取值：switch | select | slider | number
 * - switch：布尔开关
 * - select：枚举（options 固定；schemeOptions=true 表示档位动态选项，由运行态 available 填充）
 * - slider：数字 + 滑块（必带 min/max/step）
 * - number：数字 + 数字框
 *
 * depends：该字段仅在依赖的布尔字段为 true 时才可编辑（如处理器性能详细字段依赖 pdhEnabled）。
 */

const F = (o) => o;
const CONFIG_SCHEMA = [
  F({ key: 'mode', group: '模式', label: '运行模式', type: 'enum', control: 'select', options: [{ v: 'auto', t: '自动切换' }, { v: 'manual', t: '手动锁定' }], help: '自动=状态机按负载/空闲切换；手动=锁定到指定档位' }),
  F({ key: 'manualScheme', group: '模式', label: '锁定档位', type: 'enum', control: 'select', schemeOptions: true, help: '仅“手动”模式生效' }),
  F({ key: 'idleThresholdMin', group: '空闲检测', label: '空闲阈值', type: 'number', control: 'slider', unit: '分钟', min: 1, max: 60, step: 1, help: '无操作超过该分钟 → 切节能' }),
  F({ key: 'idlePollMs', group: '空闲检测', label: '采样周期', type: 'number', control: 'number', unit: 'ms', min: 500, max: 10000, step: 100, help: '空闲检测轮询间隔' }),

  F({ key: 'cpuHighPct', group: 'CPU 阈值', label: '升档阈值', type: 'number', control: 'slider', unit: '%', min: 10, max: 100, step: 1, help: 'CPU 占用率超过此值并持续 → 升档（须高于降档阈值形成死区，UI 会强制限制）' }),
  F({ key: 'cpuCooldownPct', group: 'CPU 阈值', label: '降档阈值', type: 'number', control: 'slider', unit: '%', min: 0, max: 95, step: 1, help: 'CPU 占用率低于此值并持续 → 回平衡（须低于升档阈值形成死区，UI 会强制限制）' }),
  F({ key: 'cpuHighHoldSec', group: 'CPU 阈值', label: '升档持续', type: 'number', control: 'number', unit: '秒', min: 0, max: 120, step: 1, help: '持续超阈值多久才升档' }),
  F({ key: 'cpuCooldownHoldSec', group: 'CPU 阈值', label: '降档持续', type: 'number', control: 'number', unit: '秒', min: 0, max: 120, step: 1, help: '持续低于阈值多久才降档' }),
  F({ key: 'cpuEma', group: 'CPU 阈值', label: '平滑系数(EMA)', type: 'number', control: 'slider', unit: '', min: 0.05, max: 1, step: 0.05, help: '越大越敏感、越抖；越小越平滑' }),
  F({ key: 'cpuSampleMs', group: 'CPU 阈值', label: '采样周期', type: 'number', control: 'number', unit: 'ms', min: 200, max: 10000, step: 100, help: 'CPU 采样间隔' }),

  F({ key: 'pdhEnabled', group: '处理器性能', label: '启用性能反馈检测', type: 'boolean', control: 'switch', help: '处理器性能比(睿频)作为升档副判据；RDP/锁屏下仍有效' }),
  F({ key: 'pdhHighPct', group: '处理器性能', label: '升档阈值', type: 'number', control: 'number', unit: '%', min: 110, max: 300, step: 5, depends: 'pdhEnabled', help: '处理器性能比超过此值并持续 → 升档（100=标称频率，>100=睿频）' }),
  F({ key: 'pdhHoldSec', group: '处理器性能', label: '持续秒数', type: 'number', control: 'number', unit: '秒', min: 0, max: 120, step: 1, depends: 'pdhEnabled' }),
  F({ key: 'pdhPollMs', group: '处理器性能', label: '采样周期', type: 'number', control: 'number', unit: 'ms', min: 200, max: 10000, step: 100, depends: 'pdhEnabled' }),

  F({ key: 'jankEnabled', group: '卡顿检测', label: '启用卡顿检测', type: 'boolean', control: 'switch', help: '事件循环抖动(心跳探针)作为升档副判据；全场景有效，RDP/锁屏下不失效' }),
  F({ key: 'jankPerMin', group: '卡顿检测', label: '卡顿阈值', type: 'number', control: 'number', unit: '次/分', min: 1, max: 600, step: 1, depends: 'jankEnabled', help: '每分钟卡顿超过此值 → 升档' }),
  F({ key: 'jankHoldSec', group: '卡顿检测', label: '持续秒数', type: 'number', control: 'number', unit: '秒', min: 0, max: 120, step: 1, depends: 'jankEnabled' }),

  F({ key: 'uiBoostEnabled', group: 'UI 提速', label: '启用 UI 提速', type: 'boolean', control: 'switch', help: '提高前台 UI 调度优先级 + 解除网络节流，系统高负载下减轻卡顿。改系统调度参数需管理员：首次开启会弹一次 UAC 授权（之后免 UAC），关闭时自动还原。下方子参数仅在开启后调节生效' }),
  F({ key: 'uiBoostPriorityLevel', group: 'UI 提速', label: '前台优先级', type: 'enum', control: 'select', options: [{ v: 2, t: '系统默认' }, { v: 26, t: '前台优先' }, { v: 38, t: '极致前台' }], depends: 'uiBoostEnabled', help: '前台进程调度优先级提升幅度（Win32PrioritySeparation）。值越大前台 UI 抢 CPU 越优先；改完即时生效' }),
  F({ key: 'uiBoostSystemResponsiveness', group: 'UI 提速', label: '后台预留', type: 'number', control: 'slider', unit: '%', min: 0, max: 20, step: 1, depends: 'uiBoostEnabled', help: '保留给后台低优先级任务的 CPU 百分比（SystemResponsiveness）。值越小后台抢占越少、前台越流畅；0 最激进' }),
  F({ key: 'uiBoostEnableNetworkThrottle', group: 'UI 提速', label: '保持网络节流', type: 'boolean', control: 'switch', depends: 'uiBoostEnabled', help: '关闭=解除网络中断节流（默认，高负载下响应更快）；开启=保留 Windows 默认节流。解除后由 MMCSS 调度，重启后完整生效' }),

  F({ key: 'preferUltimate', group: '状态机', label: '升档优先卓越性能', type: 'boolean', control: 'switch', help: '升档时优先卓越性能（本机未启用则回退高性能）' }),
  F({ key: 'minDwellSec', group: '状态机', label: '最小驻留', type: 'number', control: 'number', unit: '秒', min: 0, max: 300, step: 1, help: '档位切换后该秒数内抑制再次切换（防抖）' }),

  F({ key: 'logLevel', group: '系统', label: '日志级别', type: 'enum', control: 'select', options: [{ v: 'error', t: 'error' }, { v: 'warn', t: 'warn' }, { v: 'info', t: 'info' }, { v: 'debug', t: 'debug' }], help: '保存后需重启进程生效' }),
];

/**
 * 返回某字段的默认值（取自 constants.DEFAULT_CONFIG，其来源为 src/config/defaults.json）。
 * defaults.json 是默认配置的单一事实来源，schema 在此镜像，供"重置为默认"按钮使用。
 * @param {string} key
 */
const { DEFAULT_CONFIG } = require('../constants');
function defaultValue(key) {
  return DEFAULT_CONFIG[key];
}

const SCHEMA_GROUPS = ['模式', '空闲检测', 'CPU 阈值', '处理器性能', '卡顿检测', 'UI 提速', '状态机', '系统'];

/**
 * 跨字段约束：参数间相互限制，前端据此物理强制，后端据此兜底。
 *
 * 每条 { a, b, op, gap } 语义：a 相对 b 必须满足 op，并以 gap 为死区宽度。
 *   - 'gt'：a 必须 > b + gap
 *   - 'lt'：a 必须 < b − gap
 * enforceConstraints 以"被依赖方" b 为基准夹紧 a，保证存储数据始终自洽。
 *
 * 例：cpuHighPct(升档) 必须 > cpuCooldownPct(降档)，否则升/降档阈值无死区，
 *     Hysteresis 在临界值附近会反复翻转 → CPU 档位抖动。
 */
const FIELD_CONSTRAINTS = Object.freeze([
  { a: 'cpuHighPct', b: 'cpuCooldownPct', op: 'gt', gap: 1 },
]);

/**
 * 字段取值范围（取自 CONFIG_SCHEMA 的 min/max/step），供前端按约束动态夹紧。
 */
const FIELD_RANGE = (() => {
  const map = {};
  for (const f of CONFIG_SCHEMA) {
    if (typeof f.min === 'number' && typeof f.max === 'number') {
      map[f.key] = { min: f.min, max: f.max, step: f.step };
    }
  }
  return Object.freeze(map);
})();

/**
 * 对完整配置施加跨字段约束，返回自洽副本（不改入参）。
 * 以"被依赖方" b 为基准：a 夹紧到约束侧（再受字段自身 min/max 收口）。
 * 单字段 min/max 由 ConfigStore 类型校验负责，本函数只处理跨字段关系。
 * @param {object} cfg 完整配置
 * @returns {object} 自洽副本
 */
function enforceConstraints(cfg) {
  const out = { ...(cfg || {}) };
  for (const c of FIELD_CONSTRAINTS) {
    const av = Number(out[c.a]);
    const bv = Number(out[c.b]);
    if (!isFinite(av) || !isFinite(bv)) continue;
    const range = FIELD_RANGE[c.a];
    const min = range ? range.min : -Infinity;
    const max = range ? range.max : Infinity;
    let fixed = av;
    if (c.op === 'gt' && av <= bv + c.gap) {
      // a 必须 > b + gap，不足则顶到 b + gap（再受 max 收口）
      fixed = Math.min(max, bv + c.gap);
    } else if (c.op === 'lt' && av >= bv - c.gap) {
      // a 必须 < b - gap，超界则压到 b - gap（再受 min 收口）
      fixed = Math.max(min, bv - c.gap);
    }
    out[c.a] = fixed;
  }
  return out;
}

module.exports = { CONFIG_SCHEMA, SCHEMA_GROUPS, defaultValue, FIELD_CONSTRAINTS, FIELD_RANGE, enforceConstraints };
