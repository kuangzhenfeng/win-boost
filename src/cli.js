'use strict';

const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Scheme, SCHEME_LABEL } = require('./constants');
const { PowerController } = require('./power/power-controller');
const { getIdleMilliseconds, isAvailable: idleAvailable } = require('./native/idle-native');
const { summarize } = require('./monitors/cpu-monitor');
const { install, uninstall, query } = require('./autostart');
const { getLogger } = require('./logging/logger');
const { getConfigPath, getRootDir } = require('./util/paths');
const { ConfigStore } = require('./config/config-store');
const os = require('os');

const execP = promisify(exec);

function println(s = '') {
  process.stdout.write(`${s}\n`);
}

function getSelfExePath() {
  // pkg 产物：process.execPath 指向 exe 本身
  // 开发：返回 node + 脚本路径组合，install 时用 node 启动
  if (process.pkg) return process.execPath;
  return `"${process.execPath}" "${path.join(__dirname, 'main.js')}"`;
}

/**
 * --status：一次性打印配置、当前档位、CPU、空闲、卡顿、方案映射、自启项后退出。
 */
async function cmdStatus({ debug } = {}) {
  const logger = getLogger({ debug });
  const cfgStore = new ConfigStore({ logger });
  const cfg = cfgStore.load();

  println('=== Win-Boost 状态 ===');
  println(`配置目录 : ${getRootDir()}`);
  println(`配置文件 : ${getConfigPath()}`);
  println('');

  // 电源方案
  const power = new PowerController({ logger });
  try {
    await power.init();
    println('-- 电源方案映射 --');
    for (const s of ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE']) {
      const m = power.mapping[s];
      const avail = power.available.includes(s) ? '可用' : '不可用';
      println(`  ${SCHEME_LABEL[s].padEnd(6)} ${avail}  ${m ? m.guid : '(无)'}`);
    }
    const cur = await power.getCurrent();
    println('');
    println('-- 当前活动方案 --');
    if (cur) {
      const label = cur.scheme ? SCHEME_LABEL[cur.scheme] : '(自定义)';
      println(`  ${label}  ${cur.guid}  (${cur.friendlyName})`);
    } else {
      println('  (读取失败)');
    }
  } catch (e) {
    println(`  电源方案读取失败: ${e.message}`);
  }

  // 空闲
  println('');
  println('-- 空闲检测 --');
  if (idleAvailable()) {
    try {
      println(`  空闲毫秒: ${getIdleMilliseconds()} (阈值 ${cfg.idleThresholdMin} 分钟)`);
    } catch (e) {
      println(`  采样失败: ${e.message}`);
    }
  } else {
    println('  idle-native 不可用（非 Windows 或 koffi 缺失）');
  }

  // CPU
  println('');
  println('-- CPU（单次双采样，间隔 1s）--');
  try {
    const a = summarize(os.cpus());
    await new Promise((r) => setTimeout(r, 1000));
    const b = summarize(os.cpus());
    const dT = b.total - a.total;
    const dI = b.idle - a.idle;
    const pct = dT > 0 ? (1 - dI / dT) * 100 : 0;
    println(`  当前 CPU 占用率: ${pct.toFixed(1)}%`);
  } catch (e) {
    println(`  采样失败: ${e.message}`);
  }

  // 卡顿（心跳探针，短时采样）
  println('');
  println('-- 卡顿（心跳探针，采样 3s）--');
  if (cfg.jankEnabled !== false) {
    const { JankMonitor } = require('./monitors/jank-monitor');
    const jank = new JankMonitor({ now: () => Date.now() });
    let last = null;
    jank.on('sample', ({ janksPerMin }) => { last = janksPerMin; });
    jank.start();
    await new Promise((r) => setTimeout(r, 3000));
    jank.stop();
    println(`  卡顿: ${last == null ? 0 : last} 次/分（阈值 ${cfg.jankPerMin}）`);
  } else {
    println('  已禁用');
  }

  // 自启
  println('');
  println('-- 开机自启 --');
  const q = query();
  println(`  ${q === null ? '未安装' : `已安装: ${q}`}`);
}

/**
 * --schemes：打印 powercfg /l 解析结果（调试用）。
 */
async function cmdSchemes({ debug } = {}) {
  const logger = getLogger({ debug });
  const power = new PowerController({ logger });
  await power.init();
  println('=== 电源方案解析结果 (powercfg /l) ===');
  const mapping = power.mapping;
  for (const s of ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE']) {
    const m = mapping[s];
    const avail = power.available.includes(s);
    println(`  [${s}] ${SCHEME_LABEL[s]}  ${avail ? '✓ 可用' : '✗ 不可用'}`);
    if (m) println(`        GUID=${m.guid}  友好名="${m.friendly}"`);
  }
  println('');
  println(`available（按性能升序）: ${power.available.join(', ')}`);
}

/**
 * --once：跑一次状态机评估（基于当前 CPU/空闲），施效后退出。CI/脚本用。
 */
async function cmdOnce({ debug } = {}) {
  const logger = getLogger({ debug });
  const cfgStore = new ConfigStore({ logger });
  const cfg = cfgStore.load();

  const power = new PowerController({ logger });
  await power.init();

  // 简化评估：仅基于空闲与即时 CPU
  let signal = null;
  if (idleAvailable()) {
    let idleMs = 0;
    try {
      idleMs = getIdleMilliseconds();
    } catch {
      // ignore
    }
    if (idleMs >= cfg.idleThresholdMin * 60 * 1000) {
      signal = { type: 'idle' };
      println(`评估：空闲 ${Math.round(idleMs / 1000)}s ≥ 阈值 → idle`);
    } else if (idleMs < 5000) {
      // 有输入迹象
      // 进一步看 CPU
    }
  }
  if (!signal) {
    // CPU 双采样
    const a = summarize(os.cpus());
    await new Promise((r) => setTimeout(r, 1000));
    const b = summarize(os.cpus());
    const dT = b.total - a.total;
    const dI = b.idle - a.idle;
    const pct = dT > 0 ? (1 - dI / dT) * 100 : 0;
    println(`评估：CPU 占用 ${pct.toFixed(1)}%`);
    if (pct >= cfg.cpuHighPct) {
      signal = { type: 'load_high' };
      println(`→ load_high（≥ ${cfg.cpuHighPct}%）`);
    } else {
      println('→ 维持当前档位');
    }
  }

  if (signal) {
    const { StateMachine } = require('./state/state-machine');
    const cur = await power.getCurrent();
    const sm = new StateMachine({ cfg, available: power.available, now: () => Date.now() });
    sm.init(cur ? cur.scheme : Scheme.BALANCED);
    const target = sm.feed(signal);
    if (target) {
      println(`状态机建议: ${cur && cur.scheme} → ${target}`);
      const res = await power.setActive(target);
      println(res && res.changed ? `已切换 ✓` : `未切换（幂等或失败）`);
    } else {
      println('状态机：无转移');
    }
  }
}

/**
 * --install / --uninstall
 */
async function cmdInstall({ debug } = {}) {
  const logger = getLogger({ debug });
  const self = getSelfExePath();
  install(self);
  // 同步配置镜像
  const cfgStore = new ConfigStore({ logger });
  cfgStore.load();
  cfgStore.set({ autoStart: true });
  println(`已安装开机自启: ${self}`);
}

async function cmdUninstall({ debug } = {}) {
  const logger = getLogger({ debug });
  uninstall();
  const cfgStore = new ConfigStore({ logger });
  cfgStore.load();
  cfgStore.set({ autoStart: false });
  println('已移除开机自启');
}

module.exports = {
  cmdStatus,
  cmdSchemes,
  cmdOnce,
  cmdInstall,
  cmdUninstall,
};
