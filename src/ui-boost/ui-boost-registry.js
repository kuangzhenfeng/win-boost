'use strict';

/**
 * UI 提速注册表参数定义（纯数据，单一事实来源）。
 *
 * 三个系统级调度参数，全部位于 HKLM，改写需管理员。本模块只描述"改什么"，
 * 具体怎么改（提权）由 elevated-runner 负责，何时改（启用/禁用/还原）由
 * ui-boost-controller 负责。三者职责分离，不互相侵入。
 *
 * 每个参数：
 *  - key         逻辑键（备份存储与回引用用）
 *  - hive        reg.exe 注册表根（HKLM ...）
 *  - path        子键路径
 *  - name        值名
 *  - type        REG_DWORD
 *  - boostValue  启用时的优化值（十进制整数）
 *  - fallback    Windows 客户端默认值（备份丢失时还原兜底，避免覆盖到非法态）
 *
 * 优化值取值依据：
 *  - Win32PrioritySeparation：默认 38(0x26)。位编码见 PRIORITY_LEVELS。
 *  - SystemResponsiveness：默认 10（保留给低优先级任务的 CPU 百分比）。
 *    客户端默认 20，改 10 后台任务抢占更少、前台 UI 抢占更多。
 *  - NetworkThrottlingIndex：默认 4294967295(0xFFFFFFFF，解除网络中断节流)。
 *    客户端默认 10，高负载下网络中断被节流会拖累系统响应；解除后由 MMCSS 调度，
 *    配合 SystemResponsiveness 收敛响应延迟。
 *
 * 三个参数的实际优化值可由用户配置覆盖（见 valuesFromConfig），REG_PARAMS.boostValue
 * 仅为 defaults 与回退兜底（非提权/未配置时使用）。
 *
 * 生效说明：Win32PrioritySeparation 即时生效；SystemResponsiveness /
 * NetworkThrottlingIndex 由 MMCSS 读取，完整生效需重启 MMCSS（一般重启系统）。
 * 前者是主参数且即时，已能立即改善前台 UI 响应；后两者为锦上添花的延迟收敛。
 */
const REG_PARAMS = Object.freeze([
  {
    key: 'win32PrioritySeparation',
    hive: 'HKLM',
    path: 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl',
    name: 'Win32PrioritySeparation',
    type: 'REG_DWORD',
    boostValue: 38,
    fallback: 2,
  },
  {
    key: 'systemResponsiveness',
    hive: 'HKLM',
    path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile',
    name: 'SystemResponsiveness',
    type: 'REG_DWORD',
    boostValue: 10,
    fallback: 20,
  },
  {
    key: 'networkThrottlingIndex',
    hive: 'HKLM',
    path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile',
    name: 'NetworkThrottlingIndex',
    type: 'REG_DWORD',
    boostValue: 4294967295,
    fallback: 10,
  },
]);

/**
 * Win32PrioritySeparation 预设档位（位编码的安全子集）。
 *
 * 为什么用预设而非自由数值：该值是位编码，bit3 量子类型位若误置为"固定量子"
 * （如 0x18=24），CPU 密集任务会因无动态提升而饿死前台 UI——适得其反。
 * 三个预设都落在"变长量子 + 短量子"安全区（bit3=0），只调前台提升幅度（bit5..6），
 * 规避误设风险。用户无需理解位编码。
 *
 *   v=2(系统默认)：前台中等提升（Windows 客户端出厂值）
 *   v=26(前台优先)：前台较大提升
 *   v=38(极致前台)：前台最大提升
 */
const PRIORITY_LEVELS = Object.freeze([
  { v: 2, t: '系统默认' },
  { v: 26, t: '前台优先' },
  { v: 38, t: '极致前台' },
]);

/**
 * 从用户配置派生三个参数的实际优化值（启用 UI 提速时写入的目标值）。
 *
 * 单一职责：纯函数，cfg → 值对象，无副作用。供控制器/ops 共用，
 * 保证"配置如何映射成注册表值"只有这一处定义。
 *
 *   - Win32PrioritySeparation：取 uiBoostPriorityLevel（预设档位值，默认 38）
 *   - SystemResponsiveness：取 uiBoostSystemResponsiveness（默认 10）
 *   - NetworkThrottlingIndex：uiBoostEnableNetworkThrottle（保持网络节流）为真则保持
 *     Windows 默认节流（10），为假（默认）则解除节流（0xFFFFFFFF）
 *
 * @param {object} cfg 完整配置
 * @returns {{win32PrioritySeparation:number, systemResponsiveness:number, networkThrottlingIndex:number}}
 */
function valuesFromConfig(cfg) {
  const c = cfg || {};
  const lvl = Number.isFinite(c.uiBoostPriorityLevel) ? c.uiBoostPriorityLevel : 38;
  // 档位值兜底：非预设值回退到 38（防配置被外部篡改成有害值）
  const level = PRIORITY_LEVELS.some((p) => p.v === lvl) ? lvl : 38;
  return {
    win32PrioritySeparation: level,
    systemResponsiveness: Number.isFinite(c.uiBoostSystemResponsiveness) ? c.uiBoostSystemResponsiveness : 10,
    // uiBoostEnableNetworkThrottle=true 表示"保持网络节流"（用 Windows 默认 10）；
    // false/默认表示"解除节流"。注意字段语义是"保持节流"而非"启用节流提速"。
    networkThrottlingIndex: c.uiBoostEnableNetworkThrottle === true ? 10 : 4294967295,
  };
}

module.exports = { REG_PARAMS, PRIORITY_LEVELS, valuesFromConfig };
