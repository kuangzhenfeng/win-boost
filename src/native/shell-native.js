'use strict';

const { loadNative } = require('./koffi-loader');

/**
 * Shell 原生调用：ShellExecuteW（仅用于触发 UAC 提权）。
 *
 * 为什么用它：child_process 无法触发 UAC（spawn/exec 不带 runas 动词）。
 * ShellExecuteW 的 "runas" 动词是 Win32 触发提权的标准方式，由系统弹出
 * consent.exe 提示框，用户确认后以提升权限启动目标进程。
 *
 * 复用 koffi-loader 的平台/koffi 门控；ShellExecuteW 在 shell32.dll，
 * 自包含加载（与 pdh-native 加载 pdh.dll 同构）。
 *
 * 失效场景：非 Windows / koffi 缺失 → 返回 null，调用方降级（UI 提速不可启用）。
 */

let _native = null; // { ShellExecuteW }
let _unavailable = false;

function ensure() {
  if (_native) return _native;
  if (_unavailable) return null;

  const base = loadNative();
  if (!base) {
    _unavailable = true;
    return null;
  }
  const koffi = base.koffi;
  const shell32 = koffi.load('shell32.dll');

  // 返回 HINSTANCE：成功为伪句柄（数值 > 32），失败为 ≤32 的错误码。
  // 取低 32 位即可判别"是否成功启动"（成功值在实践中恒 > 32）。
  // 真正的成功与否由调用方事后轮询目标副作用确认（UAC 被拒绝时目标不会产生）。
  const ShellExecuteW = shell32.func(
    'int32 __stdcall ShellExecuteW(void *hwnd, void *lpOperation, void *lpFile, void *lpParameters, void *lpDirectory, int32 nShowCmd)',
  );

  _native = { ShellExecuteW };
  return _native;
}

/** 构造 UTF-16LE + NUL 终止的 Buffer（与 pdh-native 同法）。 */
function wstr(s) {
  const buf = Buffer.alloc((s.length + 1) * 2);
  buf.write(s, 0, 'utf16le');
  return buf;
}

/**
 * 以 runas 动词（触发 UAC）启动目标程序。非阻塞：发出后立即返回，目标进程独立运行。
 *
 * @param {string} file 可执行文件名/路径（如 'schtasks.exe'）
 * @param {string} params 参数串（如 '/create /tn ...'）
 * @returns {boolean} 是否成功"启动"（>32）。UAC 被用户拒绝时也返回 true（已发出），
 *                    事后由调用方轮询确认；仅当 API 层面调用失败才返回 false。
 */
function runas(file, params) {
  const n = ensure();
  if (!n) return false;
  try {
    const result = n.ShellExecuteW(null, wstr('runas'), wstr(file), wstr(params || ''), null, 0 /* SW_HIDE */);
    return result > 32;
  } catch {
    return false;
  }
}

function isAvailable() {
  return !!ensure();
}

module.exports = { runas, isAvailable };
