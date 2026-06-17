'use strict';

const path = require('path');
const fs = require('fs');
const { getLogger } = require('./logging/logger');
const { ConfigStore } = require('./config/config-store');
const { PowerController } = require('./power/power-controller');
const { Orchestrator } = require('./orchestrator');
const { TrayUI } = require('./ui/tray-ui');
const { isDebug, isWindows } = require('./util/env');
const { getLockPath, getRootDir, getConfigPath, getWebServerInfoPath } = require('./util/paths');
const { REG_VALUE_NAME } = require('./constants');
const cli = require('./cli');

/**
 * 单例锁：防止多开导致状态机打架。
 * lock 文件 + PID 存活判断：
 *  - 抢锁用 openSync('wx')（O_EXCL 语义），文件已存在则失败。
 *  - 抢锁失败时读 lock 内 PID 探活：若该 PID 已不存在（崩溃/SIGKILL/断电留下的残留），
 *    清理后重试一次；只有确认 PID 仍存活才判定为真有另一实例。
 *  - 局限（简化版）：PID 可能被系统复用导致误判存活，但 Windows PID 空间大，短期概率极低。
 */
function acquireSingleInstance(firstAttempt = true) {
  const lockPath = getLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // O_EXCL 创建：已存在则失败
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return {
      release() {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      },
    };
  } catch (e) {
    // 抢锁失败：先判断是否为残留（持有进程已死），残留则清理后重试一次
    if (firstAttempt && isStaleLock(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
      return acquireSingleInstance(false);
    }
    // 确有存活实例（或残留清理失败）：放弃抢锁
    return null;
  }
}

/**
 * 判断 lock 文件是否为残留：读出 PID 并探活。
 * process.kill(pid, 0)（不发实际信号，仅检查进程是否存在）：
 *  - 不抛错 → 进程存活，非残留；
 *  - EPERM  → 进程存在但无权限探活，视为存活，非残留；
 *  - ESRCH  → 进程不存在，残留；
 *  - 文件读取/解析失败 → 内容无效，按残留处理（可安全覆盖）。
 * @param {string} lockPath
 */
function isStaleLock(lockPath) {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
  } catch {
    return true; // 读不到 → 当残留
  }
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0); // 探活
    return false; // 进程在 → 非残留
  } catch (e) {
    if (e && e.code === 'EPERM') return false; // 在但无权限 → 非残留
    return true; // ESRCH 或其他 → 不在 → 残留
  }
}

async function runDaemon({ debug } = {}) {
  const logger = getLogger({ debug });

  const lock = acquireSingleInstance();
  if (!lock) {
    logger.error('检测到已有实例运行（或残留 lock 文件），退出。');
    logger.error(`如确认无实例，删除 ${getLockPath()} 后重试。`);
    process.exit(1);
  }

  if (!isWindows()) {
    logger.error('win-boost 仅支持 Windows，退出。');
    process.exit(1);
  }

  logger.info(`Win-Boost 启动（PID=${process.pid}）`);
  logger.info(`配置: ${getConfigPath()}`);
  logger.info(`日志目录: ${path.join(getRootDir(), 'logs')}`);

  const cfgStore = new ConfigStore({ logger });
  cfgStore.load();

  const power = new PowerController({ logger });
  await power.init();
  logger.info(`可用电源档位: ${power.available.join(', ')}`);

  const tray = new TrayUI({ tooltip: 'Win-Boost 电源自动切换', logger });

  const orch = new Orchestrator({
    cfg: cfgStore.getAll(),
    power,
    tray,
    debug,
    logger,
  });

  // 托盘命令 → 自启/设置/退出
  /**
   * 设置开机自启：写/删注册表项 + 同步配置镜像 + 刷新托盘。
   * 提炼为函数，供 web 侧 onAutostart 复用。
   */
  async function setAutostart(value) {
    try {
      if (value) {
        const self = process.pkg ? process.execPath : `"${process.execPath}" "${path.join(__dirname, 'main.js')}"`;
        const { install } = require('./autostart');
        install(self);
        cfgStore.set({ autoStart: true });
        logger.info('已安装开机自启');
      } else {
        const { uninstall } = require('./autostart');
        uninstall();
        cfgStore.set({ autoStart: false });
        logger.info('已移除开机自启');
      }
      tray.setAutostart(value);
    } catch (e) {
      logger.error(`自启操作失败: ${e.message}`);
    }
  }

  orch.on('autostart', (value) => setAutostart(value));

  /**
   * UI 提速联动：处理开关与子参数变更。
   *
   * 两类动作由调用方判定后传入：
   *  - 开关翻转（enableToggled=true）：enable/disable 整套
   *  - 仅子参数变更（enableToggled=false，仍处于提速态）：applyValues 重写注册表
   * 提权流程异步、首次会弹 UAC；结果经 resultCb 回传（web 侧转 SSE toast）。
   * 优化值统一由 valuesFromConfig(cfg) 派生，保证"配置→注册表值"映射唯一。
   */
  async function setUiBoost({ enableToggled, cfg }, resultCb) {
    try {
      const { valuesFromConfig } = require('./ui-boost/ui-boost-registry');
      const values = valuesFromConfig(cfg);
      let res;
      if (enableToggled) {
        // 开关翻转：整体启用/禁用
        const enabled = cfg.uiBoostEnabled === true;
        res = enabled ? await uiBoost.enable({ values }) : await uiBoost.disable();
      } else if (cfg.uiBoostEnabled) {
        // 已提速、仅子参数变更：重写注册表为新优化值（不改开关态）
        res = await uiBoost.applyValues(values);
      } else {
        // 未提速且非开关翻转：无动作（子参数改动等开启时再生效）
        res = { ok: true };
      }
      if (res.ok) {
        if (enableToggled) {
          cfgStore.set({ uiBoostEnabled: cfg.uiBoostEnabled === true });
          logger.info(cfg.uiBoostEnabled ? 'UI 提速已开启' : 'UI 提速已关闭');
        } else if (cfg.uiBoostEnabled) {
          logger.info('UI 提速参数已更新');
        }
      } else {
        // 失败：开关翻转失败时回退开关态（与实际对齐），子参数失败不影响开关
        if (enableToggled) cfgStore.set({ uiBoostEnabled: uiBoost.isActive });
        logger.warn(`UI 提速操作失败: ${res.reason}`);
      }
      if (resultCb) resultCb(res.ok, res.reason);
    } catch (e) {
      logger.error(`UI 提速操作异常: ${e.message}`);
      if (resultCb) resultCb(false, e.message);
    }
  }

  orch.on('settings', () => {
    const { exec } = require('child_process');
    exec(`explorer "${getRootDir()}"`, { windowsHide: true });
  });

  orch.on('quit', async () => {
    logger.info('收到退出命令');
    await shutdown();
  });

  await tray.start();   // 等托盘子进程 ready（菜单注册完成）后再启动 orchestrator，
                        // 否则 orch.start() 里的 tray.refresh 会在 ready 前发 update-item，
                        // 触发 getlantern/systray 端 "index out of range" panic 使托盘崩溃。
  await orch.start();

  // 托盘自动同步自启状态
  const { isInstalled } = require('./autostart');
  tray.setAutostart(isInstalled());

  // ---- UI 提速控制器 ----
  // 提权任务的执行目标：固定指向 win-boost 自身的 --ui-boost-op 流程。
  // 打包态 exe 直接跑；开发态 node 跑 main.js。结构化 {exe, args} 经 XML 装载，
  // 规避 schtasks /tr 对含空格路径的引号嵌套解析问题。
  const taskTarget = process.pkg
    ? { exe: process.execPath, args: ['--ui-boost-op'] }
    : { exe: process.execPath, args: [path.join(__dirname, 'main.js'), '--ui-boost-op'] };
  const { UiBoostController } = require('./ui-boost/ui-boost-controller');
  const uiBoost = new UiBoostController({ taskTarget, logger });
  // 启动恢复：以实际态（backup.json）对齐配置意图。
  // - 配置想开但实际未开 → 重新启用（崩溃/UAC 拒绝后自愈）
  // - 配置想关但实际仍开 → 还原（异常退出残留清理）
  try {
    const { valuesFromConfig } = require('./ui-boost/ui-boost-registry');
    const res = await uiBoost.reconcile(
      cfgStore.get('uiBoostEnabled') === true,
      valuesFromConfig(cfgStore.getAll()),
    );
    if (!res.ok) logger.warn(`UI 提速启动恢复失败: ${res.reason}`);
  } catch (e) {
    logger.warn(`UI 提速启动恢复异常: ${e.message}`);
  }

  // ---- 内嵌 web 服务（仅 127.0.0.1，随机端口 + 一次性令牌）----
  const crypto = require('crypto');
  const { createWebServer } = require('./web/server');
  const { HistoryRecorder } = require('./metrics/history-recorder');
  const { atomicWriteJson } = require('./util/atomic-write');
  const token = crypto.randomBytes(18).toString('base64url');
  // 历史趋势记录器：复用 orchestrator 运行态快照，独立于 web server 生命周期
  const history = new HistoryRecorder({ orchestrator: orch, logger });
  history.start();
  let web;
  try {
    web = await createWebServer({
      configStore: cfgStore,
      orchestrator: orch,
      historyRecorder: history,
      token,
      logger,
      onAutostart: (v) => setAutostart(v),
      onUiBoost: (opts, resultCb) => setUiBoost(opts, resultCb),
    });
    logger.info(`配置网页: ${web.url}`);
    // 写发现信息（端口/令牌/PID），供外部工具/书签重建
    try {
      atomicWriteJson(getWebServerInfoPath(), { port: web.port, token, pid: process.pid });
    } catch (e) {
      logger.warn(`写 web-server.json 失败: ${e.message}`);
    }
    // 配置变更 → 热重载
    cfgStore.on('change', (cfg) => {
      try {
        orch.applyConfig(cfg);
      } catch (e) {
        logger.error(`热重载失败: ${e.message}`);
      }
    });
    // 托盘"打开配置网页" → 用默认浏览器打开
    orch.on('web', () => {
      const { exec } = require('child_process');
      exec(`start "" "${web.url}"`, { windowsHide: true });
    });
  } catch (e) {
    logger.warn(`web 服务启动失败（功能不可用，不影响托盘/状态机）: ${e.message}`);
  }

  // 优雅退出
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      orch.stop();
      tray.stop();
      if (history) history.stop();
      if (web) await web.close();
      // UI 提速：退出时若仍提速，还原注册表（保持"走时跟来时一样"）。
      // 仅在用户未显式关闭时还原；config.uiBoostEnabled 仍为 true 表示用户意图持续开启，
      // 但进程退出必须还原系统参数（下次启动由 reconcile 重新启用）——避免崩溃后系统长期处于改动态。
      if (uiBoost && uiBoost.isActive) {
        logger.info('退出前还原 UI 提速参数');
        try {
          await uiBoost.disable();
        } catch (e) {
          logger.warn(`退出还原 UI 提速失败: ${e.message}`);
        }
      }
    } finally {
      lock.release();
      logger.info('Win-Boost 已退出');
      process.exit(0);
    }
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

async function main() {
  const argv = process.argv.slice(2);
  const debug = isDebug(argv);

  const has = (flag) => argv.includes(flag);

  if (has('--version')) {
    const pkg = require('../package.json');
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    return;
  }

  try {
    if (has('--status')) return await cli.cmdStatus({ debug });
    if (has('--schemes')) return await cli.cmdSchemes({ debug });
    if (has('--once')) return await cli.cmdOnce({ debug });
    if (has('--install')) return await cli.cmdInstall({ debug });
    if (has('--uninstall')) return await cli.cmdUninstall({ debug });
    if (has('--ui-boost-op')) return await cli.cmdUiBoostOp();
    // 默认：启动守护
    return await runDaemon({ debug });
  } catch (e) {
    const logger = getLogger({ debug: true });
    logger.error(`致命错误: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

main();
