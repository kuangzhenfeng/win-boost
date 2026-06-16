'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const { getLogsDir } = require('../util/paths');

let _logger = null;

/**
 * 全局 logger 单例：控制台 + 按日轮转文件。
 * - debug（--debug / WINBOOST_DEBUG）：额外输出到控制台，级别 debug。
 * - 文件：%APPDATA%\win-boost\logs\win-boost-YYYY-MM-DD.log，单文件 5MB、保留 14 天。
 * - error 单独写到 error.log。
 *
 * @param {{debug?: boolean, level?: string}} [opts]
 */
function getLogger(opts = {}) {
  if (_logger) return _logger;

  const debug = opts.debug ?? false;
  const level = opts.level || (debug ? 'debug' : 'info');
  const logsDir = getLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });

  const fmt = format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level: lv, message }) => `${timestamp} [${lv}] ${message}`),
  );

  const tps = [
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      format: fmt,
    }),
    new transports.DailyRotateFile({
      filename: path.join(logsDir, 'win-boost-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '5m',
      maxFiles: '14d',
      format: fmt,
    }),
  ];

  if (debug) {
    tps.push(
      new transports.Console({
        level,
        format: format.combine(format.colorize(), fmt),
      }),
    );
  }

  _logger = createLogger({ level, transports: tps, exitOnError: false });
  return _logger;
}

function resetLogger() {
  _logger = null;
}

module.exports = { getLogger, resetLogger };
