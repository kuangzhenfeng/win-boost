'use strict';

const { Scheme, BUILTIN_GUID_REF } = require('../constants');

/**
 * 把 powercfg 的 GBK/默认代码页输出解码为字符串。
 * 中文 Windows 下 powercfg 输出是 GBK（CP936）；en 则是 ASCII/兼容 UTF-8。
 * TextDecoder 在 Node 18+ 默认可选支持 GBK。
 * @param {Buffer} buf
 * @returns {string}
 */
function decodePowercfg(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  // 先尝试 GBK（中文系统最常见）
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    // 无 GBK 支持：按 utf8
    try {
      return new TextDecoder('utf8').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/**
 * 友好名 → 档位枚举的关键字正则（避免依赖系统语言）。
 * 同时保留 GUID 兜底比对。
 */
const KEYWORDS = {
  [Scheme.SAVER]: [/saver|节能|省电|節電/i],
  [Scheme.BALANCED]: [/balanced|平衡/i],
  [Scheme.PERFORMANCE]: [/high\s*performance|高性能|高效能/i],
  [Scheme.ULTIMATE]: [/ultimate|卓越|極致|終極/i],
};

/**
 * 解析 powercfg /getactivescheme 的单行输出。
 * 输出形如（多语言）：
 *   "Power Scheme GUID: 381b4222-...  (Balanced)"
 *   "电源方案 GUID: 381b4222-...  (平衡)"
 * @param {string} text
 * @returns {{guid:string, friendlyName:string}|null}
 */
const RE_ACTIVE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*\(([^)]+)\)/;
function parseActiveScheme(text) {
  if (!text) return null;
  const m = RE_ACTIVE.exec(String(text));
  if (!m) return null;
  return { guid: m[1].toLowerCase(), friendlyName: m[2].trim() };
}

/**
 * 解析 powercfg /l 的多行输出，返回所有方案。
 * @param {string} text
 * @returns {Array<{guid:string, friendlyName:string}>}
 */
const RE_LIST = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*\(([^)]+)\)/g;
function parseAllSchemes(text) {
  const out = [];
  if (!text) return out;
  RE_LIST.lastIndex = 0;
  let m;
  while ((m = RE_LIST.exec(String(text)))) {
    out.push({ guid: m[1].toLowerCase(), friendlyName: m[2].trim() });
  }
  return out;
}

/**
 * 把一个方案归入档位枚举。先用友好名关键字，失败再用内置 GUID 比对。
 * @param {{guid:string, friendlyName:string}} scheme
 * @returns {string|null} Scheme 枚举或 null（用户自定义方案）
 */
function classifyScheme(scheme) {
  if (!scheme) return null;
  for (const [s, regs] of Object.entries(KEYWORDS)) {
    if (regs.some((r) => r.test(scheme.friendlyName))) return s;
  }
  for (const [s, ref] of Object.entries(BUILTIN_GUID_REF)) {
    if (scheme.guid === ref) return s;
  }
  return null;
}

module.exports = {
  KEYWORDS,
  decodePowercfg,
  parseActiveScheme,
  parseAllSchemes,
  classifyScheme,
};
