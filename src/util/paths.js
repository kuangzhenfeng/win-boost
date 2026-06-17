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

/** web 服务发现信息（端口/令牌/PID）。非持久化配置，独立于此 config.json。 */
function getWebServerInfoPath() {
  return path.join(getRootDir(), 'web-server.json');
}

/** 历史趋势指标落盘（minute/hour 桶）。独立于 config.json。 */
function getMetricsPath() {
  return path.join(getRootDir(), 'metrics.json');
}

module.exports = {
  getRootDir,
  getConfigPath,
  getLogsDir,
  getLockPath,
  getWebServerInfoPath,
  getMetricsPath,
};
