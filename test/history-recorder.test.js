'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { HistoryRecorder, aggregate, modeScheme, minuteStart, hourStart } = require('../src/metrics/history-recorder');

// 用临时 APPDATA，隔离 metrics.json 不污染真实环境
function withTmpAppData() {
  const dir = path.join(os.tmpdir(), `wb-hist-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.APPDATA = dir;
  return dir;
}

function makeOrch(state, cpu, perf, jank) {
  return { getRuntime: () => ({ state, cpuEma: cpu, pdhPerfPct: perf, janksPerMin: jank }) };
}

test('modeScheme 取众数，并列按 SCHEME_ORDER 取低性能者', () => {
  assert.equal(modeScheme(['BALANCED', 'BALANCED', 'PERFORMANCE']), 'BALANCED');
  assert.equal(modeScheme(['SAVER', 'PERFORMANCE']), 'SAVER'); // 并列 → SCHEME_ORDER 低者
  assert.equal(modeScheme(['ULTIMATE', 'PERFORMANCE']), 'PERFORMANCE');
  assert.equal(modeScheme([]), 'BALANCED');
});

test('minuteStart / hourStart 边界对齐', () => {
  assert.equal(minuteStart(125), 120);
  assert.equal(hourStart(3700), 3600);
});

test('aggregate 平均 cpu/perf + 众数 scheme', () => {
  const p = aggregate([
    { t: 0, cpu: 10, perf: 100, scheme: 'BALANCED' },
    { t: 1, cpu: 30, perf: 130, scheme: 'BALANCED' },
    { t: 2, cpu: 50, perf: 160, scheme: 'PERFORMANCE' },
  ], 0);
  assert.equal(p.t, 0);
  assert.equal(p.cpu, 30); // (10+30+50)/3
  assert.equal(p.perf, 130); // (100+130+160)/3
  assert.equal(p.jank, 0); // 旧点无 jank，按 0 兜底（(0+0+0)/3）
  assert.equal(p.scheme, 'BALANCED'); // 2 vs 1
});

test('aggregate 平均 jank（卡顿次数/分随平均）', () => {
  const p = aggregate([
    { t: 0, cpu: 10, perf: 100, jank: 12, scheme: 'BALANCED' },
    { t: 1, cpu: 30, perf: 130, jank: 0, scheme: 'BALANCED' },
    { t: 2, cpu: 50, perf: 160, jank: 24, scheme: 'PERFORMANCE' },
  ], 0);
  assert.equal(p.jank, 12); // (12+0+24)/3
});

test('缺 perf 字段的旧点折叠时不报错（按 0 兜底）', () => {
  const p = aggregate([
    { t: 0, cpu: 10, scheme: 'BALANCED' },
    { t: 1, cpu: 30, scheme: 'BALANCED' },
  ], 0);
  assert.equal(p.perf, 0);
  assert.equal(p.jank, 0); // jank 同理兜底
});

test('采样累积到 raw，queryByRange 1h 返回秒级（含 perf）', () => {
  withTmpAppData();
  const t0 = 1_000_000;
  const rec = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 42, 135, 8), now: () => t0 * 1000 });
  rec.start();
  rec.push({ t: t0, cpu: 40, scheme: 'BALANCED' });
  rec.push({ t: t0 + 1, cpu: 50, scheme: 'BALANCED' });
  rec.push({ t: t0 + 2, cpu: 60, scheme: 'PERFORMANCE' });
  const pts = rec.queryByRange('1h');
  assert.equal(pts.length, 3);
  // _sample 喂入的点应带 perf / jank（来自 orchestrator）
  rec._sample();
  const sampled = rec.queryByRange('1h');
  assert.equal(sampled[sampled.length - 1].perf, 135);
  assert.equal(sampled[sampled.length - 1].jank, 8);
  rec.stop();
});

test('latest: 返回最近一个秒级采样点（供 SSE 增量推送曲线）', () => {
  withTmpAppData();
  const t0 = 2_000_000;
  const rec = new HistoryRecorder({ orchestrator: makeOrch('PERFORMANCE', 77, 145, 3), now: () => t0 * 1000 });
  rec.start();
  assert.equal(rec.latest(), null); // 空 → null
  rec.push({ t: t0, cpu: 50, perf: 120, jank: 1, scheme: 'BALANCED' });
  rec.push({ t: t0 + 1, cpu: 60, perf: 130, jank: 2, scheme: 'PERFORMANCE' });
  const lp = rec.latest();
  assert.deepEqual(lp, { t: t0 + 1, cpu: 60, perf: 130, jank: 2, scheme: 'PERFORMANCE' });
  rec.stop();
});

test('跨分钟边界 fold 出 minute 点（perf 随平均）', () => {
  withTmpAppData();
  const base = minuteStart(1_000_000); // 整分钟
  const rec = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 0, 0), now: () => base * 1000 });
  rec.start();
  // 第一分钟内 3 个点（带 perf）
  rec.push({ t: base + 10, cpu: 20, perf: 110, scheme: 'BALANCED' });
  rec.push({ t: base + 20, cpu: 40, perf: 130, scheme: 'BALANCED' });
  rec.push({ t: base + 30, cpu: 60, perf: 150, scheme: 'PERFORMANCE' });
  // 让 now 推进到下一分钟之后，触发 fold
  rec._now = () => (base + 90) * 1000;
  rec.push({ t: base + 90, cpu: 30, perf: 120, scheme: 'BALANCED' });
  const mins = rec.queryByRange('1d');
  assert.equal(mins.length, 1);
  assert.equal(mins[0].t, base);
  assert.equal(mins[0].cpu, 40); // (20+40+60)/3
  assert.equal(mins[0].perf, 130); // (110+130+150)/3
  assert.equal(mins[0].scheme, 'BALANCED'); // 2 vs 1
  rec.stop();
});

test('跨小时边界 fold 出 hour 点', () => {
  withTmpAppData();
  const base = hourStart(10_000_000);
  const rec = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 0, 0), now: () => base * 1000 });
  rec.start();
  // 直接喂两个 minute 点（在同一小时内）
  rec._minute.push({ t: base + 60, cpu: 50, scheme: 'PERFORMANCE' });
  rec._minute.push({ t: base + 120, cpu: 70, scheme: 'PERFORMANCE' });
  // 推进到下一小时之后
  rec._now = () => (base + 3700) * 1000;
  rec.push({ t: base + 3700, cpu: 10, scheme: 'BALANCED' });
  const hrs = rec.queryByRange('30d');
  assert.equal(hrs.length, 1);
  assert.equal(hrs[0].t, base);
  assert.equal(hrs[0].cpu, 60); // (50+70)/2
  assert.equal(hrs[0].scheme, 'PERFORMANCE');
  rec.stop();
});

test('非法 range 返回 null', () => {
  withTmpAppData();
  const rec = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 1, 1), now: () => 1000 });
  assert.equal(rec.queryByRange('7d'), null);
  assert.equal(rec.queryByRange(undefined), null);
});

test('落盘后重启加载，minute/hour 不丢', () => {
  const dir = withTmpAppData();
  // 第一次实例：写入一些 minute 数据并落盘
  const rec1 = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 0, 0), now: () => 1_000_000 * 1000 });
  rec1.start();
  rec1._minute.push({ t: 1_000_000, cpu: 55, scheme: 'BALANCED' });
  rec1._hour.push({ t: 3600, cpu: 44, scheme: 'PERFORMANCE' });
  rec1._dirty = true;
  rec1._persist(); // 直接落盘（_path 已在构造时算定）
  // 文件已写（metrics.json 在 APPDATA\win-boost\ 下）
  const metricsPath = rec1._path;
  assert.ok(fs.existsSync(metricsPath));
  // 第二次实例（模拟重启）：加载
  const rec2 = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 0, 0), now: () => 1_000_000 * 1000 });
  rec2.start();
  const mins = rec2.queryByRange('1d');
  assert.equal(mins.length, 1);
  assert.equal(mins[0].cpu, 55);
  const hrs = rec2.queryByRange('30d');
  assert.equal(hrs.length, 1);
  assert.equal(hrs[0].scheme, 'PERFORMANCE');
  rec2.stop();
});

test('容量裁剪：raw 不超过上限', () => {
  withTmpAppData();
  const rec = new HistoryRecorder({ orchestrator: makeOrch('BALANCED', 0, 0), now: () => 1_000_000 * 1000 });
  rec.start();
  // 喂入超过 raw cap 的点（同分钟内，不触发 fold）
  for (let i = 0; i < 8000; i++) rec.push({ t: 1_000_000 + i, cpu: i % 100, scheme: 'BALANCED' });
  assert.ok(rec.queryByRange('1h').length <= 7200);
  rec.stop();
});
