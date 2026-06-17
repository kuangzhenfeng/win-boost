/* ============================================================
   Win-Boost 趋势图 — 纯 canvas 手绘（零依赖）
   - LTTB 简化降采样，保留峰谷
   - 档位色带（背景层）+ 网格 + CPU 草绿曲线(淡填充) + 处理器性能比静灰虚线(左轴扩展) + 卡顿柔紫曲线(右轴)
   - 悬停竖虚线 + 高亮点 + DOM tooltip
   暴露：window.WBChart.render(canvas, { points, range, tooltip })
   ============================================================ */

(() => {
  'use strict';

  // 档位色带配色（淡透明，与暖色主题一致）
  const SCHEME_BAND = {
    SAVER: 'rgba(138,149,165,0.14)',
    BALANCED: 'rgba(107,158,92,0.14)',
    PERFORMANCE: 'rgba(224,153,94,0.18)',
    ULTIMATE: 'rgba(197,107,74,0.18)',
  };
  const CPU_COLOR = '#6B9E5C';
  const PERF_COLOR = '#8A95A5'; // 处理器性能比：静灰，与暖色互补
  const JANK_COLOR = '#9B7BC4'; // 卡顿次数：柔紫，与暖色/草绿/静灰全部区分
  const INK = '#3A3631';
  const SOFT = '#6B645C';
  const GRID = 'rgba(107,100,92,0.08)';

  const PAD = { top: 18, right: 52, bottom: 30, left: 46 };

  /** 把任意点数降采样到 ≤ maxN，保留视觉峰谷（LTTB 思想的简化版）。 */
  function downsample(points, maxN) {
    if (!points || points.length <= maxN) return points || [];
    if (maxN < 2) return points.length ? [points[0]] : [];
    const n = points.length;
    const bucket = (n - 2) / (maxN - 2);
    const out = [points[0]];
    let a = 0;
    for (let i = 0; i < maxN - 2; i++) {
      const rangeStart = Math.floor((i + 1) * bucket) + 1;
      const rangeEnd = Math.floor((i + 2) * bucket) + 1;
      // 区间平均点
      let avgX = 0;
      let avgY = 0;
      let count = 0;
      for (let j = rangeStart; j < rangeEnd && j < n; j++) {
        avgX += points[j].x;
        avgY += points[j].y;
        count += 1;
      }
      if (count) {
        avgX /= count;
        avgY /= count;
      }
      // 在当前桶里选与"上一选中点→区间平均"方向最接近的点
      const pointAX = points[a].x;
      const pointAY = points[a].y;
      let maxArea = -1;
      let nextIdx = rangeStart;
      for (let j = rangeStart; j < rangeEnd && j < n; j++) {
        const area = Math.abs(
          (pointAX - avgX) * (points[j].y - pointAY) - (pointAX - points[j].x) * (avgY - pointAY),
        ) * 0.5;
        if (area > maxArea) {
          maxArea = area;
          nextIdx = j;
        }
      }
      out.push(points[nextIdx]);
      a = nextIdx;
    }
    out.push(points[n - 1]);
    return out;
  }

  /** 用窗口极值粗筛，再 LTTB 精筛，确保峰值不被降采样削平。 */
  function smartDownsample(values, maxN) {
    const pts = values.map((v) => ({ x: v.t, y: v.cpu, ref: v }));
    if (pts.length <= maxN) return values;
    // 窗口极值保峰
    const win = Math.ceil(pts.length / maxN);
    const peaks = [];
    for (let i = 0; i < pts.length; i += win) {
      let maxV = -Infinity;
      let minV = Infinity;
      let maxI = i;
      let minI = i;
      for (let j = i; j < i + win && j < pts.length; j++) {
        if (pts[j].y > maxV) { maxV = pts[j].y; maxI = j; }
        if (pts[j].y < minV) { minV = pts[j].y; minI = j; }
      }
      peaks.push(pts[maxI]);
      peaks.push(pts[minI]);
    }
    // 去重排序
    const uniq = Array.from(new Map(peaks.map((p) => [p.ref.t, p])).values()).sort((a, b) => a.x - b.x);
    const picked = uniq.length > maxN ? downsample(uniq, maxN) : uniq;
    return picked.map((p) => p.ref);
  }

  /** 格式化时间刻度标签。 */
  function fmtTick(tSec, range) {
    const d = new Date(tSec * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    if (range === '30d') return `${M}-${D}`;
    return `${hh}:${mm}`;
  }

  /**
   * 渲染趋势图。
   * @param {HTMLCanvasElement} canvas
   * @param {{points:Array, range:string, tooltip?:HTMLElement, schemeLabel?:(s)=>string}} opts
   */
  function render(canvas, opts) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
    const cssH = canvas.clientHeight || 280;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { points, range, tooltip } = opts;
    const left = PAD.left;
    const right = cssW - PAD.right;
    const top = PAD.top;
    const bottom = cssH - PAD.bottom;
    const plotW = right - left;
    const plotH = bottom - top;

    if (!points || points.length < 2) {
      ctx.fillStyle = SOFT;
      ctx.font = '13px Figtree, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无足够数据，正在采集中…', cssW / 2, cssH / 2);
      return;
    }

    const tMin = points[0].t;
    const tMax = points[points.length - 1].t;
    const tSpan = Math.max(1, tMax - tMin);
    const xOf = (t) => left + ((t - tMin) / tSpan) * plotW;

    // ---- 档位色带（底层背景）----
    let segStart = points[0];
    for (let i = 1; i <= points.length; i++) {
      const cur = i < points.length ? points[i] : null;
      if (!cur || cur.scheme !== segStart.scheme) {
        const x0 = xOf(segStart.t);
        const x1 = cur ? xOf(cur.t) : right;
        ctx.fillStyle = SCHEME_BAND[segStart.scheme] || SCHEME_BAND.BALANCED;
        ctx.fillRect(x0, top, x1 - x0, plotH);
        if (cur) segStart = cur;
      }
    }

    // 左轴上限：CPU 固定 0-100，但 perf 睿频可超 100（如 130/150）→ 轴扩展到容纳 perf 峰值，
    // 向上取整到 25 的倍数与刻度步长对齐，不低于 100（保证 CPU 满载 100 仍在刻度上）。
    let perfPeak = 100;
    for (const p of points) {
      if (p.perf != null && isFinite(p.perf) && p.perf > perfPeak) perfPeak = p.perf;
    }
    const axisMax = Math.max(100, Math.ceil(perfPeak / 25) * 25);

    // ---- 网格 + 左轴刻度（CPU 0-100，扩展区承载 perf 睿频）----
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = SOFT;
    ctx.font = '11px "Spline Sans Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= axisMax; v += 25) {
      const y = bottom - (v / axisMax) * plotH;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillText(String(v), left - 8, y);
    }

    // 降采样后画 CPU / 卡顿（≤ 1200 点）
    const MAXPTS = 1200;
    const sampled = smartDownsample(points, MAXPTS);

    // CPU：草绿曲线 + 下方淡填充（左轴 0-axisMax，但语义仍是 0-100%，>100 无意义故钳到 100）
    const cpuY = (v) => bottom - (Math.max(0, Math.min(100, v)) / axisMax) * plotH;
    ctx.beginPath();
    sampled.forEach((p, i) => {
      const x = xOf(p.t);
      const y = cpuY(p.cpu);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    // 填充
    const fillPath = new Path2D();
    sampled.forEach((p, i) => {
      const x = xOf(p.t);
      const y = cpuY(p.cpu);
      if (i === 0) fillPath.moveTo(x, y);
      else fillPath.lineTo(x, y);
    });
    fillPath.lineTo(xOf(sampled[sampled.length - 1].t), bottom);
    fillPath.lineTo(xOf(sampled[0].t), bottom);
    fillPath.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(107,158,92,0.28)');
    grad.addColorStop(1, 'rgba(107,158,92,0)');
    ctx.fillStyle = grad;
    ctx.fill(fillPath);
    // 线
    ctx.strokeStyle = CPU_COLOR;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(107,158,92,0.35)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    sampled.forEach((p, i) => {
      const x = xOf(p.t);
      const y = cpuY(p.cpu);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 右轴：卡顿次数（次/分，独立计数率，与 CPU 百分比不同量纲）。
    // 取峰值取整到 10 的倍数作为右轴上限。
    let rightMax = 1;
    for (const p of points) {
      if (p.jank > rightMax) rightMax = p.jank;
    }
    rightMax = Math.ceil(rightMax / 10) * 10 || 10;
    const rightY = (v) => bottom - (Math.max(0, Math.min(rightMax, v)) / rightMax) * plotH;
    // 右轴刻度（与卡顿柔紫色一致，表示该轴量纲）
    ctx.fillStyle = JANK_COLOR;
    ctx.textAlign = 'left';
    ctx.strokeStyle = GRID;
    for (let k = 0; k <= 2; k++) {
      const v = (rightMax / 2) * k;
      const y = bottom - (v / rightMax) * plotH;
      ctx.fillText(String(Math.round(v)), right + 8, y);
    }
    // 卡顿次数：柔紫细线，复用右轴（次/分）。
    ctx.strokeStyle = JANK_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    sampled.forEach((p, i) => {
      const x = xOf(p.t);
      const y = rightY(p.jank);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 处理器性能比（perf）：静灰虚线，复用左轴（perf 100=标称基线，>100=睿频，轴已扩展容纳峰值）。
    const perfY = (v) => bottom - (Math.max(0, Math.min(axisMax, v)) / axisMax) * plotH;
    ctx.strokeStyle = PERF_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    let started = false;
    sampled.forEach((p) => {
      if (p.perf == null || !isFinite(p.perf)) { started = false; return; }
      const x = xOf(p.t);
      const y = perfY(p.perf);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // 100% 基线标注（标称频率参考线，睿频时曲线越过此线）
    ctx.fillStyle = PERF_COLOR;
    ctx.font = '10px "Spline Sans Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('100% 标称', left + 6, perfY(100) - 7);

    // 底部时间刻度（约 5 个）
    ctx.fillStyle = SOFT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tickCount = 5;
    for (let i = 0; i <= tickCount; i++) {
      const t = tMin + (tSpan * i) / tickCount;
      const x = xOf(t);
      ctx.fillText(fmtTick(t, range), x, bottom + 8);
    }

    // 缓存用于 hit-test（mutate 已有对象，保留 _lastOpts / _wbHoverBound）
    const stCache = canvas.__wb || (canvas.__wb = {});
    Object.assign(stCache, { sampled, xOf, tMin, tSpan, plotW, left, right, top, bottom, plotH, cpuY, rightY, rightMax, perfY, axisMax, range, tooltip });
  }

  /** 绑定悬停：画竖虚线 + 高亮点，tooltip 显示该时刻数值。 */
  function bindHover(canvas) {
    function move(ev) {
      const st = canvas.__wb;
      if (!st || !st.sampled || st.sampled.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const t = st.tMin + ((x - st.left) / st.plotW) * st.tSpan;
      // 找最近点
      let best = st.sampled[0];
      let bestD = Math.abs(best.t - t);
      for (const p of st.sampled) {
        const d = Math.abs(p.t - t);
        if (d < bestD) { bestD = d; best = p; }
      }
      hoverPaint(canvas, best);
      if (st.tooltip) {
        const tip = st.tooltip;
        tip.innerHTML =
          `<div class="tt-time">${fmtTick(best.t, st.range)}</div>` +
          `<div class="tt-row"><span class="tt-dot cpu"></span>CPU <b>${Math.round(best.cpu)}%</b></div>` +
          `<div class="tt-row"><span class="tt-dot perf"></span>性能比 <b>${best.perf != null && isFinite(best.perf) ? Math.round(best.perf) + '%' + (best.perf > 100 ? ' · 睿频' : '') : '—'}</b></div>` +
          `<div class="tt-row"><span class="tt-dot jank"></span>卡顿 <b>${Math.round(best.jank)} 次/分</b></div>`;
        tip.classList.add('show');
        const tipW = tip.offsetWidth || 150;
        let tx = st.xOf(best.t) + 14;
        if (tx + tipW > rect.width) tx = st.xOf(best.t) - tipW - 14;
        tip.style.left = `${Math.max(8, tx)}px`;
        tip.style.top = `${st.cpuY(best.cpu) - 10}px`;
      }
    }
    function leave() {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 重绘最新一次以清掉 hover 覆层
      const st = canvas.__wb;
      if (st && st._lastOpts) render(canvas, st._lastOpts);
      if (st && st.tooltip) st.tooltip.classList.remove('show');
    }
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', leave);
  }

  /** 在已绘制的图上叠加 hover 覆层（竖虚线 + 双高亮点）。 */
  function hoverPaint(canvas, p) {
    const st = canvas.__wb;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 先整图重绘再覆层（避免叠加残留）
    if (st._lastOpts) render(canvas, st._lastOpts);
    const x = st.xOf(p.t);
    ctx.save();
    ctx.strokeStyle = 'rgba(58,54,49,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, st.top);
    ctx.lineTo(x, st.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    // CPU 点
    ctx.fillStyle = CPU_COLOR;
    ctx.beginPath();
    ctx.arc(x, st.cpuY(p.cpu), 3.5, 0, Math.PI * 2);
    ctx.fill();
    // 性能比点
    if (p.perf != null && isFinite(p.perf)) {
      ctx.fillStyle = PERF_COLOR;
      ctx.beginPath();
      ctx.arc(x, st.perfY(p.perf), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // 卡顿点
    ctx.fillStyle = JANK_COLOR;
    ctx.beginPath();
    ctx.arc(x, st.rightY(p.jank), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 带记忆的渲染入口：记住 opts 供 hover 重绘用，首次绑定 hover。 */
  function mount(canvas, opts) {
    const st = canvas.__wb || (canvas.__wb = {});
    st._lastOpts = opts;
    render(canvas, opts);
    if (!canvas.__wbHoverBound) {
      bindHover(canvas);
      canvas.__wbHoverBound = true;
    }
  }

  window.WBChart = { mount, render };
})();
