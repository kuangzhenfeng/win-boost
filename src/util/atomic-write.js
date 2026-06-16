'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 原子写 JSON：先写同目录临时文件，再 rename 覆盖目标。
 * 同目录 rename 在同一卷上原子，崩溃/掉电时只会看到旧或新，不会半写。
 *
 * @param {string} filePath
 * @param {object} obj
 */
function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  const data = JSON.stringify(obj, null, 2);
  // 写完整内容
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd); // 尽力保证落盘（桌面工具可省，但加上更稳）
  } finally {
    fs.closeSync(fd);
  }
  // rename 原子覆盖
  fs.renameSync(tmp, filePath);
}

/**
 * 原子读 JSON。读失败（不存在/损坏）返回 fallback。
 */
function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

module.exports = { atomicWriteJson, readJsonSafe };
