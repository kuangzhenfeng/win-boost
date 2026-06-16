'use strict';

/**
 * 生成托盘图标资源 res/tray-icon.b64。
 *
 * 优先级：
 *  1. 若存在 assets/icon.ico（多尺寸 16/32/48/256）→ 直接 base64 编码写入。
 *  2. 否则 → 程序化生成一个可见图标（蓝底圆角方块 + 金色闪电），
 *     渲染多个尺寸并打包成标准 .ico 容器再 base64。
 *
 * 关键：systray2 的底层 getlantern/systray 调 Win32 LookupIconIdFromDirectoryEx
 * 解析图标，**只认 .ico 容器**。喂裸 PNG 会报 "Unable to set icon"（即使 PNG 本身
 * 合法），托盘图标静默不显示。所以必须把位图包装进 .ico 的 ICONDIRENTRY 结构。
 * 用 32bpp BMP（每像素自带 alpha）作为 DIB，全 Windows 通用，无需 AND 掩码。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.ico');
const DST_DIR = path.join(ROOT, 'res');
const DST = path.join(DST_DIR, 'tray-icon.b64');

// ---------------- PNG 编码（生成预览 / .ico 内嵌位图用，本流程实际走 ICO-BMP）----------------
// 保留以备未来需要 PNG-in-ICO；当前 ICO 用 BMP DIB 以求最大兼容。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素缓冲编码为 PNG（8-bit, color type 6）。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba  长度 width*height*4，逐像素 R,G,B,A
 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * 把一张 RGBA 位图包装成单尺寸 .ico（32bpp BMP DIB，自带 alpha，无需 AND 掩码）。
 * 结构：ICONDIR(6) + ICONDIRENTRY(16) + BITMAPINFOHEADER(40) + 自底向上 32bpp 像素。
 * height 字段写 2*size（Win32 约定：DIB 高度 = XOR+AND 合计高度；32bpp 下 AND 部分省略仍需这样声明）。
 * @param {number} size
 * @param {Buffer} rgba
 */
function rgbaToIco(size, rgba) {
  const xorSize = size * size * 4;
  const dibSize = 40 + xorSize;
  const dib = Buffer.alloc(dibSize);
  dib.writeUInt32LE(40, 0); // biSize
  dib.writeInt32LE(size, 4); // biWidth
  dib.writeInt32LE(size * 2, 8); // biHeight = 2*size
  dib.writeUInt16LE(1, 12); // biPlanes
  dib.writeUInt16LE(32, 14); // biBitCount
  // 像素自底向上、BGRA
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size; // 翻转
    for (let x = 0; x < size; x++) {
      const src = (srcRow + x) * 4;
      const dst = 40 + (y * size + x) * 4;
      dib[dst] = rgba[src + 2]; // B
      dib[dst + 1] = rgba[src + 1]; // G
      dib[dst + 2] = rgba[src]; // R
      dib[dst + 3] = rgba[src + 3]; // A
    }
  }
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width（256 用 0 表示）
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // color count
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(dibSize, 8); // bytes in res
  entry.writeUInt32LE(22, 12); // offset = 6 + 16
  return Buffer.concat([dir, entry, dib]);
}

/**
 * 多尺寸打包成单个 .ico：ICONDIR(6) + N×ICONDIRENTRY(16) + N×DIB。
 * @param {Array<{size:number, rgba:Buffer}>} entries
 */
function rgbaMultiIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type=icon
  dir.writeUInt16LE(entries.length, 4);
  const dibs = [];
  const entryBufs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, rgba } of entries) {
    const dib = rgbaToIcoDibOnly(size, rgba);
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(dib.length, 8);
    entry.writeUInt32LE(offset, 12);
    entryBufs.push(entry);
    dibs.push(dib);
    offset += dib.length;
  }
  return Buffer.concat([dir, ...entryBufs, ...dibs]);
}

/** 仅 DIB 部分（BITMAPINFOHEADER + 32bpp 像素），供 rgbaMultiIco 拼装 */
function rgbaToIcoDibOnly(size, rgba) {
  const xorSize = size * size * 4;
  const dib = Buffer.alloc(40 + xorSize);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size;
    for (let x = 0; x < size; x++) {
      const src = (srcRow + x) * 4;
      const dst = 40 + (y * size + x) * 4;
      dib[dst] = rgba[src + 2];
      dib[dst + 1] = rgba[src + 1];
      dib[dst + 2] = rgba[src];
      dib[dst + 3] = rgba[src + 3];
    }
  }
  return dib;
}

// ---------------- 程序化图标：蓝色渐变圆角方块 + 金色闪电 ----------------
// 设计意图：闪电=能量/加速（呼应 boost），蓝色=电源/系统。
// 用距离场做抗锯齿，渲染多尺寸（16/32/48），托盘缩放后仍清晰。

/** alpha-over 合成写像素（支持带 alpha 的叠加，抗锯齿用） */
function setPx(buf, w, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w) return;
  const i = (y * w + x) * 4;
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

/** SDF → coverage（0..1），edge 为半像素软边宽度，做抗锯齿 */
function coverage(dist, edge) {
  return Math.max(0, Math.min(1, 0.5 - dist / (2 * edge) + 0.5));
}

/** 点到折线（多段）最短距离 */
function distToPolyline(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
  }
  return d;
}

/** 圆角矩形 SDF：点 到 [0,size]×[0,size] 圆角 r 的带符号距离（外为正） */
function sdRoundRect(x, y, size, r) {
  const qx = Math.abs(x - size / 2) - (size / 2 - r);
  const qy = Math.abs(y - size / 2) - (size / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  const outer = Math.hypot(ax, ay);
  const inner = Math.min(Math.max(qx, qy), 0);
  return outer + inner - r;
}

function generateIcon(size) {
  const buf = Buffer.alloc(size * size * 4, 0); // 全透明
  const r = Math.max(2, Math.round(size * 0.24));
  const edge = 0.75; // 半像素抗锯齿

  // 背景渐变：顶亮(59,130,246 #3B82F6) → 底深(29,78,216 #1D4ED8)
  const top = [59, 130, 246];
  const bot = [29, 78, 216];

  // 闪电折线（归一化坐标 → 像素），经典 Z 字形
  const u = (v) => v * (size - 1);
  const bolt = [
    [u(0.60), u(0.08)],
    [u(0.30), u(0.54)], // 锯齿顶点
    [u(0.52), u(0.50)],
    [u(0.38), u(0.92)],
  ];
  const boltHalfW = size * 0.105; // 主体半宽
  const coreHalfW = size * 0.038; // 高光内核半宽
  const gold = [250, 204, 21]; // #FACC15
  const goldHi = [254, 240, 138]; // #FEF08A 高光

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // 1) 圆角渐变底
      const dRect = sdRoundRect(px, py, size, r);
      const cov = coverage(dRect, edge);
      if (cov > 0) {
        const tt = y / (size - 1);
        const rr = Math.round(top[0] + (bot[0] - top[0]) * tt);
        const gg = Math.round(top[1] + (bot[1] - top[1]) * tt);
        const bb = Math.round(top[2] + (bot[2] - top[2]) * tt);
        setPx(buf, size, x, y, rr, gg, bb, Math.round(cov * 255));
      }

      // 2) 金色闪电主体
      const dBolt = distToPolyline(px, py, bolt);
      const covBolt = coverage(dBolt - boltHalfW, edge);
      if (covBolt > 0) {
        setPx(buf, size, x, y, gold[0], gold[1], gold[2], Math.round(covBolt * 255));
      }
      // 3) 高光内核
      const covCore = coverage(dBolt - coreHalfW, edge);
      if (covCore > 0) {
        setPx(buf, size, x, y, goldHi[0], goldHi[1], goldHi[2], Math.round(covCore * 255));
      }
    }
  }
  return buf;
}

// ---------------- 主流程 ----------------

fs.mkdirSync(DST_DIR, { recursive: true });

let b64;
if (fs.existsSync(SRC)) {
  b64 = fs.readFileSync(SRC).toString('base64');
  process.stdout.write(`已由 ${path.relative(ROOT, SRC)} 生成 ${path.relative(ROOT, DST)}\n`);
} else {
  // 多尺寸打包成单个 .ico。只放托盘实际会用到的尺寸：
  //  - 16：标准小图标区尺寸（绝大多数情况命中）
  //  - 32：高 DPI / 大图标区命中
  // 不放 48/256：体积越大，getlantern/systray 解码并落临时文件越慢，
  // 在主程序定时器密集运行时易触发"临时文件句柄失效"竞态导致 SetIcon 失败。
  const sizes = [16, 32];
  const entries = sizes.map((s) => ({ size: s, rgba: generateIcon(s) }));
  const ico = rgbaMultiIco(entries);
  b64 = ico.toString('base64');
  process.stdout.write(`未找到 assets/icon.ico，已生成程序化图标（蓝底闪电，.ico 多尺寸 ${sizes.join('/')}）→ ${path.relative(ROOT, DST)}\n`);
  process.stdout.write(`提示：放置 assets/icon.ico 可替换为自定义图标（再跑 npm run icon）。\n`);
}

fs.writeFileSync(DST, b64);
process.stdout.write(`写入 ${b64.length} 字节 base64\n`);
