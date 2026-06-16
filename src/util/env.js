'use strict';

const os = require('os');
const path = require('path');
const { APP_NAME } = require('../constants');

/**
 * 运行环境信息。集中读取，避免散落各处。
 */
function getAppDataDir() {
  const appdata =
    (process.env.APPDATA && process.env.APPDATA.trim()) ||
    path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, APP_NAME);
}

function getPlatform() {
  return process.platform;
}

function getArch() {
  return process.arch;
}

function isWindows() {
  return process.platform === 'win32';
}

/**
 * 是否开启调试（CLI --debug 或环境变量 WINBOOST_DEBUG）。
 * @param {string[]} argv
 */
function isDebug(argv = process.argv) {
  if (process.env.WINBOOST_DEBUG) return true;
  return argv.includes('--debug');
}

module.exports = {
  getAppDataDir,
  getPlatform,
  getArch,
  isWindows,
  isDebug,
};
