'use strict';

const { loadNative } = require('./koffi-loader');

/**
 * 处理器性能反馈（PDH，方案 D）：
 * 读取 \Processor Information(_Total)\% Processor Performance。
 *
 * 语义：
 *  - 100% = 处理器运行在标称（基频 / advertised）频率。
 *  - >100% = 正在睿频（Turbo/Boost），数值为实际频率相对标称频率的百分比。
 *  - <100% = 降频（节能）。
 *
 * 为什么用它作"卡顿升档"副判据：高性能档的唯一作用就是允许更高频率，
 * 直接判"当前频率是否已贴天花板、负载仍高"是最对症的升档信号。
 * 这是 Windows PPM 与业界电源工具实际使用的信号。
 *
 * 全场景有效：RDP 远程会话 / 全屏独占游戏 / 锁屏下都始终有效
 * （它读的是处理器电源管理反馈，与显示管线无关）。
 *
 * 失效场景：非 Windows / koffi 缺失 / 极个别精简系统无该计数器 → 返回 null，调用方降级。
 */

// % Processor Performance：相对标称频率的性能比
const PERF_COUNTER_PATH = '\\Processor Information(_Total)\\% Processor Performance';

let _native = null; // { pdh, funcs, query, counter, ready }
let _unavailable = false;

function ensure() {
  if (_native) return _native;
  if (_unavailable) return null;

  const base = loadNative();
  if (!base) {
    _unavailable = true;
    return null;
  }
  // PDH 无与其他 native 共享的结构类型，自包含加载，但复用 loadNative 的平台/koffi 门控
  const koffi = base.koffi;
  const pdh = koffi.load('pdh.dll');

  // PDH_FMT_DOUBLE = 0x00000200
  // PDH 计数器值结构 PDH_FMT_COUNTERVALUE: { uint32 CStatus; double DoubleValue; }
  // 共 16 字节（4 字节 CStatus + 4 字节对齐填充 + 8 字节 double），用 buffer 读。
  const PdhOpenQueryW = pdh.func('int __stdcall PdhOpenQueryW(void *ds, uintptr_t ud, _Out_ void **phQuery)');
  const PdhAddCounterW = pdh.func('int __stdcall PdhAddCounterW(void *hQuery, void *path, uintptr_t ud, _Out_ void **phCounter)');
  const PdhCollectQueryData = pdh.func('int __stdcall PdhCollectQueryData(void *hQuery)');
  const PdhGetFormattedCounterValue = pdh.func('int __stdcall PdhGetFormattedCounterValue(void *hCounter, uint32_t fmt, _Out_ uint32_t *pType, _Out_ void *pValue)');
  const PdhCloseQuery = pdh.func('int __stdcall PdhCloseQuery(void *hQuery)');

  // UTF-16LE + NUL 终止
  const pathBuf = Buffer.alloc((PERF_COUNTER_PATH.length + 1) * 2);
  pathBuf.write(PERF_COUNTER_PATH, 0, 'utf16le');

  const qOut = [null];
  let hr = PdhOpenQueryW(null, 0, qOut);
  if (hr !== 0) {
    _unavailable = true;
    return null;
  }
  const query = qOut[0];
  const cOut = [null];
  hr = PdhAddCounterW(query, pathBuf, 0, cOut);
  if (hr !== 0) {
    PdhCloseQuery(query);
    _unavailable = true;
    return null;
  }
  // 预热：PDH 首次 collect 后的值不可用（CStatus 非法，需两次采样才有效），
  // 构造时丢弃第一次即可。
  PdhCollectQueryData(query);

  _native = {
    PdhCollectQueryData,
    PdhGetFormattedCounterValue,
    PdhCloseQuery,
    query,
    counter: cOut[0],
  };
  return _native;
}

/**
 * 读取处理器性能比（% Processor Performance）。PDH 不可用或本次值无效时返回 null。
 * @returns {{ perfPct:number }|null}
 */
function getProcessorPerformance() {
  const n = ensure();
  if (!n) return null;
  try {
    let hr = n.PdhCollectQueryData(n.query);
    if (hr !== 0) return null;
    const valBuf = Buffer.alloc(16);
    const typeOut = [0];
    hr = n.PdhGetFormattedCounterValue(n.counter, 0x00000200 /* PDH_FMT_DOUBLE */, typeOut, valBuf);
    if (hr !== 0) return null;
    const cStatus = valBuf.readUInt32LE(0);
    if (cStatus !== 0) return null; // 预热未完成 / 瞬时无效
    const perfPct = valBuf.readDoubleLE(8);
    if (!isFinite(perfPct)) return null;
    return { perfPct };
  } catch {
    return null;
  }
}

function isAvailable() {
  return !!ensure();
}

module.exports = { getProcessorPerformance, isAvailable };
