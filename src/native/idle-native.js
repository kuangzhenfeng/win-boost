'use strict';

const { loadNative } = require('./koffi-loader');

/**
 * 空闲检测：GetLastInputInfo + GetTickCount。
 * 必须在用户交互式 Session 运行（普通后台进程即可；Windows Service 在 Session 0 拿不到输入，会失效）。
 *
 * GetTickCount 与 LASTINPUTINFO.dwTime 同基准（系统启动后毫秒），
 * (now - dwTime) >>> 0 在 49.7 天回绕点也自洽。
 */

let _ready = null;

function ensure() {
  if (_ready !== null) return _ready;
  const n = loadNative();
  if (!n) {
    _ready = false;
    return false;
  }
  _ready = true;
  return true;
}

/**
 * 返回当前空闲毫秒数。失败抛错。
 * @returns {number}
 */
function getIdleMilliseconds() {
  if (!ensure()) {
    throw new Error('idle-native 不可用（非 Windows 或 koffi 缺失）');
  }
  const n = loadNative();
  const out = [{ cbSize: n.koffi.sizeof(n.LASTINPUTINFO), dwTime: 0 }];
  const ok = n.GetLastInputInfo(out);
  if (!ok) throw new Error('GetLastInputInfo 失败');
  const now = n.GetTickCount();
  // 无符号 32 位差，处理回绕
  return (now - out[0].dwTime) >>> 0;
}

/**
 * 能力探测：idle-native 是否可用。
 */
function isAvailable() {
  return ensure();
}

module.exports = { getIdleMilliseconds, isAvailable };
