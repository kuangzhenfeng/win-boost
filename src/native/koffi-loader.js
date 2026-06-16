'use strict';

/**
 * koffi FFI 单例：集中加载 user32 / kernel32 / dwmapi，声明所有 Win32 符号。
 *
 * 关键准则：
 *  - 用 koffi.struct（自然对齐），不用 koffi.pack（pack=1 无填充）。
 *    DWM_TIMING_INFO / LASTINPUTINFO 含 64 位字段，pack 会错位读到垃圾值。
 *  - 重复 load 同名 DLL 在 koffi 中是安全的，但这里用模块级单例避免重复声明类型。
 *  - 非 Windows 平台或 koffi 缺失时，导出 null，调用方各自降级（见 idle-native / dwm-native）。
 */

let _native = null;
let _initError = null;

function tryRequire(name) {
  try {
    // eslint-disable-next-line global-require
    return require(name);
  } catch {
    return null;
  }
}

function loadNative() {
  if (_native) return _native;
  if (_initError) return null;

  if (process.platform !== 'win32') {
    _initError = new Error('koffi 仅在 Windows 使用');
    return null;
  }

  const koffi = tryRequire('koffi');
  if (!koffi) {
    _initError = new Error('koffi 模块未安装');
    return null;
  }

  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const dwmapi = koffi.load('dwmapi.dll');

    // ---- 空闲检测 ----
    const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', {
      cbSize: 'uint32',
      dwTime: 'uint32',
    });
    // 注意：必须用 _Inout_ 而非 _Out_。cbSize 是入参（需预填 sizeof），
    // dwTime 是出参。koffi 对 _Out_ 会清零整个结构体（纯输出语义），
    // 导致 cbSize 被抹成 0 → GetLastInputInfo 判定大小不匹配返回 false。
    const GetLastInputInfo = user32.func(
      'bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *pli)',
    );
    const GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');

    // ---- QPC 高精度计时 ----
    const QueryPerformanceFrequency = kernel32.func(
      'bool __stdcall QueryPerformanceFrequency(_Out_ int64_t *f)',
    );
    const QueryPerformanceCounter = kernel32.func(
      'bool __stdcall QueryPerformanceCounter(_Out_ int64_t *p)',
    );

    // ---- DWM 合成时序 ----
    const UNSIGNED_RATIO = koffi.struct('UNSIGNED_RATIO', {
      uiNumerator: 'uint32',
      uiDenominator: 'uint32',
    });
    // 注意：cFrame 之后字段顺序以 Win SDK dwmapi.h 为准，实测偏移见 dwm-native。
    // 这里声明到 cFrameDropped 之前，保证主判据字段可读。
    const DWM_TIMING_INFO = koffi.struct('DWM_TIMING_INFO', {
      cbSize: 'uint32',
      rateRefresh: UNSIGNED_RATIO,
      qpcRefresh: 'uint64',
      ratePresent: UNSIGNED_RATIO,
      qpcPresent: 'uint64',
      cRefresh: 'uint64',
      cDXPresent_a: 'uint32',
      cRefreshFrame: 'uint64',
      cDXPresentFrame1: 'uint64',
      cFrame: 'uint64',
      cFramePresented: 'uint64',
      cFrameDropped: 'uint64',
      cFramePending: 'uint64',
      cFrameDisplayed: 'uint64',
      qpcFrameDisplayed: 'uint64',
      qpcFrameComplete: 'uint64',
      qpcFramePending: 'uint64',
      cFramesDisplayed: 'uint64',
      cFramesComplete: 'uint64',
      cFramesPending: 'uint64',
      cFramesAvailable: 'uint64',
      cFreshFramesDisplayed: 'uint64',
      cDroppedFrames2: 'uint64',
      cFreshFramesComplete: 'uint64',
    });
    const DwmGetCompositionTimingInfo = dwmapi.func(
      'int __stdcall DwmGetCompositionTimingInfo(void *hwnd, _Out_ DWM_TIMING_INFO *pt)',
    );

    _native = {
      koffi,
      user32,
      kernel32,
      dwmapi,
      LASTINPUTINFO,
      GetLastInputInfo,
      GetTickCount,
      QueryPerformanceFrequency,
      QueryPerformanceCounter,
      UNSIGNED_RATIO,
      DWM_TIMING_INFO,
      DwmGetCompositionTimingInfo,
    };
    return _native;
  } catch (e) {
    _initError = e;
    return null;
  }
}

function getInitError() {
  return _initError;
}

module.exports = { loadNative, getInitError };
