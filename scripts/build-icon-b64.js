'use strict';

/**
 * 把 assets/icon.ico 转成 base64，写入 res/tray-icon.b64，供托盘与 pkg 打包使用。
 * 运行：node scripts/build-icon-b64.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.ico');
const DST_DIR = path.join(ROOT, 'res');
const DST = path.join(DST_DIR, 'tray-icon.b64');

if (!fs.existsSync(SRC)) {
  process.stderr.write(`缺少 ${SRC}，请先放置一个多尺寸 .ico（16/32/48/256）。\n`);
  process.stderr.write('占位：将写入一个 1x1 透明图标 base64，托盘仍可创建。\n');
  fs.mkdirSync(DST_DIR, { recursive: true });
  fs.writeFileSync(
    DST,
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  );
  process.stdout.write(`已写入占位图标 → ${DST}\n`);
  process.exit(0);
}

fs.mkdirSync(DST_DIR, { recursive: true });
const b64 = fs.readFileSync(SRC).toString('base64');
fs.writeFileSync(DST, b64);
process.stdout.write(`已生成 ${DST} (${b64.length} bytes base64)\n`);
