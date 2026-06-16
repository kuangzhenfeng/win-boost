'use strict';

const { execFileSync } = require('child_process');
const { REG_RUN_KEY, REG_VALUE_NAME } = require('./constants');

/**
 * 开机自启：写/删/查注册表 HKCU\...\Run（用户级，无需管理员）。
 *
 * 实现要点：
 *  - 直接 spawn reg.exe（execFileSync），**不**经过 cmd.exe / shell。
 *    经 shell 会在中文系统 + git-bash 环境下出现参数解析错乱（`/v` 被误判）
 *    且子进程 stderr 乱码（GBK）会泄漏到父进程控制台。
 *  - 直接传参数数组，每个 token 独立，彻底规避转义与路径转换。
 *  - windowsHide 避免黑窗。
 */

const REG = 'reg.exe';

/** 项不存在（退出码 1）不算错误，统一返回 null。 */
function _run(args) {
  try {
    const out = execFileSync(REG, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out ? out.toString() : '';
  } catch {
    return null;
  }
}

/**
 * 写入自启项。
 * @param {string} exePath 可执行文件全路径（pkg 产物或 node 入口）
 */
function install(exePath) {
  if (!exePath) throw new Error('install 需要 exePath');
  // REG_SZ 的值若含空格需自行加引号（reg 不会自动处理）
  const value = exePath.includes(' ') && !/^".*"$/.test(exePath) ? `"${exePath}"` : exePath;
  const out = _run(['add', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/t', 'REG_SZ', '/d', value, '/f']);
  if (out === null) throw new Error(`写入自启项失败: reg add 返回非 0`);
  return true;
}

/**
 * 删除自启项。项不存在不算错误。
 */
function uninstall() {
  _run(['delete', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/f']);
  return true;
}

/**
 * 查询自启项是否存在，存在则返回其值，否则返回 null。
 */
function query() {
  const out = _run(['query', REG_RUN_KEY, '/v', REG_VALUE_NAME]);
  if (out === null) return null;
  // 形如：    win-boost    REG_SZ    "C:\path\win-boost.exe"
  const m = /REG_SZ\s+(.+)$/m.exec(out);
  return m ? m[1].trim() : '';
}

function isInstalled() {
  return query() !== null;
}

module.exports = { install, uninstall, query, isInstalled };
