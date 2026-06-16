'use strict';

const path = require('path');
const { getAppDataDir } = require('./env');

/**
 * win-boost 在磁盘上的所有路径解析。
 * 根目录：%APPDATA%\win-boost\
 */
function getRootDir() {
  return getAppDataDir();
}
function getConfigPath() {
  return path.join(getRootDir(), 'config.json');
}
function getLogsDir() {
  return path.join(getRootDir(), 'logs');
}
function getLockPath() {
  return path.join(getRootDir(), `${'win-boost'}.lock`);
}

module.exports = {
  getRootDir,
  getConfigPath,
  getLogsDir,
  getLockPath,
};
