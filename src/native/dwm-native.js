'use strict';

const { loadNative } = require('./koffi-loader');

/**
 * DWM 合成时序：DwmGetCompositionTimingInfo + QPC。
 * 取 cFrameDropped 累计增量作为副判据（丢帧率），按分钟折算。
 *
 * 失效场景（必须当常态，不能当错误）：
 *  - DWM 关闭 / 基本主题 / 全屏独占游戏 / 锁屏 / 安全桌面
 *  - 这些场景 DwmGetCompositionTimingInfo 返回非 0，本函数返回 null，调用方回退纯 CPU。
 */

let _qpcFreq = null;

function ensure() {
  const n = loadNative();
  if (!n) return null;
  if (_qpcFreq === null) {
    // 取 QPC 频率（每秒计数）
    const f = [0];
    if (!n.QueryPerformanceFrequency(f)) return null;
    _qpcFreq = Number(f[0]);
  }
  return n;
}

/**
 * 读取一次 DWM 时序。DWM 不可用时返回 null。
 * @returns {{
 *   refreshHz:number,
 *   cFrame:number,
 *   cFrameDropped:number,
 *   qpc:number,
 *   qpcFreq:number,
 * }|null}
 */
function getDwmTiming() {
  const n = ensure();
  if (!n) return null;
  try {
    const out = [{}];
    out[0].cbSize = n.koffi.sizeof(n.DWM_TIMING_INFO);
    const hr = n.DwmGetCompositionTimingInfo(null, out);
    if (hr !== 0) return null; // 非 S_OK：DWM 关闭/锁屏等
    const t = out[0];
    const refreshHz =
      t.rateRefresh && t.rateRefresh.uiDenominator
        ? t.rateRefresh.uiNumerator / t.rateRefresh.uiDenominator
        : 0;
    const qpc = [0];
    if (!n.QueryPerformanceCounter(qpc)) return null;
    return {
      refreshHz,
      cFrame: Number(t.cFrame || 0),
      cFrameDropped: Number(t.cFrameDropped || 0),
      qpc: Number(qpc[0]),
      qpcFreq: _qpcFreq,
    };
  } catch {
    return null;
  }
}

function isAvailable() {
  return !!ensure();
}

module.exports = { getDwmTiming, isAvailable };
