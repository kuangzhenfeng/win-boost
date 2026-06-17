/* ============================================================
   Win-Boost 控制台前端逻辑
   - 从 location.search 取 token，所有写请求注入 X-WB-Token
   - GET /api/config + /api/schema → 渲染配置卡
   - EventSource(/api/status/stream) → 实时刷新英雄卡/工况卡
   - POST /api/config | /api/mode | /api/autostart
   ============================================================ */

(() => {
  'use strict';

  const TOKEN = new URLSearchParams(location.search).get('t') || '';
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers['x-wb-token'] = TOKEN;

  const SCHEME_LABEL = { SAVER: '节能', BALANCED: '平衡', PERFORMANCE: '高性能', ULTIMATE: '卓越性能' };
  const SCHEME_GLYPH = { SAVER: '🌿', BALANCED: '⚖️', PERFORMANCE: '🚀', ULTIMATE: '⚡' };

  let cfg = {};
  let schema = { groups: [], fields: [] };
  let defaults = {}; // 字段默认值镜像（来自 /api/schema 的 defaults）
  let constraints = []; // 跨字段约束（来自 /api/schema 的 constraints）
  const fieldInputs = {}; // key→控件，供跨字段约束联动寻址
  let runtime = null;

  // ---------- 工具 ----------
  const $ = (id) => document.getElementById(id);

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  async function api(path, method, body) {
    const opt = { method, headers: { ...headers } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(path, opt);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json;
  }

  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------- 配置卡渲染 ----------
  function renderConfigCards() {
    const wrap = $('configCards');
    wrap.innerHTML = '';
    for (const group of schema.groups) {
      const fields = schema.fields.filter((f) => f.group === group);
      if (!fields.length) continue;

      const card = document.createElement('div');
      card.className = 'config-card animate-rise';
      const inputs = {};

      const title = document.createElement('div');
      title.className = 'font-display text-2xl mb-4';
      title.textContent = group;
      card.appendChild(title);

      for (const f of fields) {
        card.appendChild(renderField(f, inputs));
      }

      const save = document.createElement('button');
      save.className = 'save-btn';
      save.textContent = '保存本组';
      save.onclick = () => saveGroup(group, fields, inputs, save);

      const reset = document.createElement('button');
      reset.className = 'reset-btn';
      reset.textContent = '重置为默认';
      reset.onclick = () => resetGroup(fields, inputs, reset);

      const btnRow = document.createElement('div');
      btnRow.className = 'card-actions';
      btnRow.appendChild(save);
      btnRow.appendChild(reset);
      card.appendChild(btnRow);

      wrap.appendChild(card);
    }
    // 跨字段约束联动（升/降档死区）
    applyDepends();
    applyAllConstraints();
  }

  function renderField(f, inputs) {
    const row = document.createElement('div');
    row.className = 'field';
    row.dataset.key = f.key;
    if (f.depends) row.dataset.depends = f.depends;

    const label = document.createElement('div');
    label.className = 'field-label';
    const labText = document.createElement('span');
    labText.textContent = f.label;
    const valSpan = document.createElement('span');
    valSpan.className = 'val';
    label.appendChild(labText);
    label.appendChild(valSpan);
    row.appendChild(label);

    let input;
    if (f.control === 'switch') {
      const wrap = document.createElement('label');
      wrap.className = 'switch';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!cfg[f.key];
      const track = document.createElement('span');
      track.className = 'track';
      wrap.appendChild(input);
      wrap.appendChild(track);
      input.addEventListener('change', () => applyDepends());
      row.appendChild(wrap);
    } else if (f.control === 'select') {
      input = document.createElement('select');
      let opts = f.options || [];
      if (f.schemeOptions) {
        const avail = (runtime && runtime.available) || ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE'];
        opts = avail.map((s) => ({ v: s, t: SCHEME_LABEL[s] || s }));
      }
      for (const o of opts) {
        const op = document.createElement('option');
        op.value = o.v; op.textContent = o.t;
        input.appendChild(op);
      }
      input.value = cfg[f.key];
      row.appendChild(input);
    } else if (f.control === 'slider') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = f.min; input.max = f.max; input.step = f.step;
      input.value = cfg[f.key];
      valSpan.textContent = formatVal(cfg[f.key], f);
      input.addEventListener('input', () => {
        valSpan.textContent = formatVal(input.value, f);
        applyConstraintsFor(f.key);
      });
      row.appendChild(input);
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.min = f.min; input.max = f.max; input.step = f.step;
      input.value = cfg[f.key];
      valSpan.textContent = formatVal(cfg[f.key], f);
      input.addEventListener('input', () => {
        valSpan.textContent = formatVal(input.value, f);
        const n = Number(input.value);
        const ok = isFinite(n) && (f.min == null || n >= f.min) && (f.max == null || n <= f.max);
        input.classList.toggle('invalid', !ok);
      });
      row.appendChild(input);
    }
    input.dataset.key = f.key;
    inputs[f.key] = input;
    fieldInputs[f.key] = input;

    if (f.help) {
      const help = document.createElement('div');
      help.className = 'field-help';
      help.textContent = f.help;
      row.appendChild(help);
    }
    return row;
  }

  function formatVal(v, f) {
    if (v == null || v === '') return '—';
    return `${v}${f.unit || ''}`;
  }

  function applyDepends() {
    document.querySelectorAll('[data-depends]').forEach((row) => {
      const depKey = row.dataset.depends;
      const depEl = document.querySelector(`[data-key="${depKey}"] input`);
      const on = depEl ? depEl.checked : true;
      row.classList.toggle('dim', !on);
    });
  }

  /**
   * 跨字段约束联动：把约束两端字段的可用范围相互夹紧，实现"物理强制"——
   * 任一滑块都无法拖到使约束失效的值。
   *
   * 对 `a > b + gap`（op 'gt'）这类关系，同时施加两条物理边界：
   *   - a 的下界 = b + gap（a 拖不过 b+gap）
   *   - b 的上界 = a − gap（b 拖不过 a−gap）
   * 例：升档(a) > 降档(b)，gap=1：
   *   - 降档=45 → 升档 min 被设成 46，升档无法低于 46
   *   - 升档=70 → 降档 max 被设成 69，降档无法高于 69
   * 两端互锁，死区永远存在。
   *
   * @param {string} key 刚发生变动的字段 key（用以决定重算的对端）
   */
  function applyConstraintsFor(key) {
    for (const c of constraints) {
      if (c.a !== key && c.b !== key) continue;
      const aInput = fieldInputs[c.a];
      const bInput = fieldInputs[c.b];
      if (!aInput || !bInput) continue;
      const aField = schema.fields.find((f) => f.key === c.a);
      const bField = schema.fields.find((f) => f.key === c.b);
      if (!aField || !bField) continue;
      clampPair(aField, aInput, bField, bInput, c);
    }
  }

  /**
   * 对一对受约字段施加双向物理边界（不改值，仅夹 min/max）。
   * op 'gt'：a > b + gap → a 下界 = b+gap，b 上界 = a−gap。
   * op 'lt'：a < b − gap → a 上界 = b−gap，b 下界 = a+gap。
   */
  function clampPair(aField, aInput, bField, bInput, c) {
    const av = Number(aInput.value);
    const bv = Number(bInput.value);
    if (!isFinite(av) || !isFinite(bv)) return;
    if (c.op === 'gt') {
      aInput.min = Math.max(aField.min, bv + c.gap);
      bInput.max = Math.min(bField.max, av - c.gap);
    } else if (c.op === 'lt') {
      aInput.max = Math.min(aField.max, bv - c.gap);
      bInput.min = Math.max(bField.min, av + c.gap);
    }
  }

  /**
   * 依据全部约束，把所有受约字段的可用范围重算一遍（不做值纠正）。
   * 用于保存后/重置后/首次渲染，让滑块边界与最新值对齐。
   */
  function applyAllConstraints() {
    // 先恢复每字段的静态边界（清除上次动态夹紧），再按当前值重算
    for (const f of schema.fields) {
      const input = fieldInputs[f.key];
      if (!input || (input.type !== 'range' && input.type !== 'number')) continue;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
    }
    for (const c of constraints) {
      const aInput = fieldInputs[c.a];
      const bInput = fieldInputs[c.b];
      if (!aInput || !bInput) continue;
      const aField = schema.fields.find((f) => f.key === c.a);
      const bField = schema.fields.find((f) => f.key === c.b);
      if (!aField || !bField) continue;
      clampPair(aField, aInput, bField, bInput, c);
    }
  }

  // ---------- 保存 ----------
  function collectField(f, input) {
    if (f.control === 'switch') return input.checked;
    if (f.control === 'select') return f.schemeOptions ? input.value : input.value;
    const n = Number(input.value);
    if (!isFinite(n)) throw new Error(`${f.label} 不是数字`);
    if (f.min != null && n < f.min) throw new Error(`${f.label} 不能小于 ${f.min}`);
    if (f.max != null && n > f.max) throw new Error(`${f.label} 不能大于 ${f.max}`);
    return n;
  }

  async function saveGroup(group, fields, inputs, btn) {
    const partial = {};
    try {
      for (const f of fields) {
        partial[f.key] = collectField(f, inputs[f.key]);
      }
    } catch (e) {
      toast(e.message, true);
      return;
    }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '保存中…';
    try {
      const next = await api('/api/config', 'POST', partial);
      cfg = next;
      // 把后端兜底后的值（可能与用户输入不同）回填控件，保持 UI 与存储一致
      for (const f of fields) {
        if (next[f.key] !== undefined) setControlValue(inputs[f.key], f, next[f.key]);
      }
      applyDepends();
      applyAllConstraints();
      toast(`${group} 已保存（已热生效）`);
    } catch (e) {
      toast(`保存失败：${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  /**
   * 把本组字段重置为默认值并**立即落盘热生效**。
   * 默认值来自后端 /api/schema 的 defaults（镜像自 DEFAULT_CONFIG，代码内单一事实来源）。
   */
  async function resetGroup(fields, inputs, btn) {
    const partial = {};
    for (const f of fields) {
      const def = defaults[f.key];
      if (def === undefined) continue;
      partial[f.key] = def;
    }
    if (!Object.keys(partial).length) return;

    // 先把控件视觉更新到默认，再落盘
    for (const f of fields) {
      if (partial[f.key] !== undefined) setControlValue(inputs[f.key], f, partial[f.key]);
    }
    applyDepends();
    applyAllConstraints();

    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '重置中…';
    try {
      const next = await api('/api/config', 'POST', partial);
      cfg = next;
      for (const f of fields) {
        if (next[f.key] !== undefined) setControlValue(inputs[f.key], f, next[f.key]);
      }
      applyAllConstraints();
      toast('已恢复默认值并热生效');
    } catch (e) {
      toast(`重置失败：${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  /** 按 control 类型把值写回控件并触发其显示更新。 */
  function setControlValue(input, f, value) {
    if (f.control === 'switch') {
      input.checked = !!value;
      return;
    }
    input.value = value;
    if (f.control === 'slider' || f.control === 'number') {
      const valSpan = document.querySelector(`.field[data-key="${f.key}"] .val`);
      if (valSpan) valSpan.textContent = formatVal(value, f);
      input.classList.remove('invalid');
    }
  }

  // ---------- 模式快捷 ----------
  function renderModeBar() {
    const manualWrap = $('manualBtns');
    manualWrap.innerHTML = '';
    const order = ['SAVER', 'BALANCED', 'PERFORMANCE', 'ULTIMATE'];
    const avail = (runtime && runtime.available) || order;
    for (const s of order) {
      const b = document.createElement('button');
      b.className = 'scheme-btn';
      b.textContent = SCHEME_LABEL[s];
      b.dataset.scheme = s;
      b.disabled = !avail.includes(s);
      b.onclick = () => api('/api/mode', 'POST', { mode: 'manual', scheme: s })
        .then((r) => { runtime = r.runtime || runtime; paintRuntime(); toast(`已锁定 ${SCHEME_LABEL[s]}`); })
        .catch((e) => toast(e.message, true));
      manualWrap.appendChild(b);
    }

    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => api('/api/mode', 'POST', { mode: 'auto' })
        .then((r) => { runtime = r.runtime || runtime; paintRuntime(); toast('已切到自动'); })
        .catch((e) => toast(e.message, true));
    });
    document.querySelectorAll('[data-pause]').forEach((b) => {
      b.onclick = () => api('/api/mode', 'POST', { pause: true })
        .then((r) => { runtime = r.runtime || runtime; paintRuntime(); toast('已暂停自动切换'); })
        .catch((e) => toast(e.message, true));
    });
  }

  // ---------- 实时绘制 ----------
  function paintRuntime() {
    if (!runtime) return;
    const { state, paused, manual, available, cpuEma, idleMs, idleThresholdMs, pdhPerfPct, janksPerMin, isHigh } = runtime;

    // 档位
    $('schemeName').textContent = SCHEME_LABEL[state] || state || '—';
    const glyph = $('schemeIcon');
    glyph.textContent = SCHEME_GLYPH[state] || '⚡';
    glyph.className = 'scheme-glyph' + (state ? ' s-' + state : '');
    $('schemeSub').textContent = (available || []).map((s) => SCHEME_LABEL[s] || s).join(' · ');

    // 顶栏药丸
    const pill = $('runPill');
    pill.classList.toggle('paused', !!paused);
    $('runText').textContent = paused ? '已暂停' : '运行中';
    $('modePill').textContent = manual ? '手动' : (paused ? '暂停' : '自动');

    // 模式条高亮
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', !manual && !paused));
    document.querySelectorAll('[data-pause]').forEach((b) => b.classList.toggle('active', !!paused));
    document.querySelectorAll('.scheme-btn').forEach((b) => {
      b.classList.toggle('active', manual && b.dataset.scheme === state);
    });

    // CPU
    const pct = Math.max(0, Math.min(100, cpuEma || 0));
    $('cpuVal').textContent = `${pct.toFixed(0)}%`;
    const bar = $('cpuBar');
    bar.style.width = `${pct}%`;
    bar.classList.toggle('high', isHigh);
    const highPct = cfg.cpuHighPct || 70;
    const lowPct = cfg.cpuCooldownPct || 45;
    $('cpuHighMark').style.left = `${highPct}%`;
    $('cpuLowMark').style.left = `${lowPct}%`;

    // 空闲
    $('idleVal').textContent = fmtMs(idleMs);
    const thr = idleThresholdMs || 300000;
    const ratio = Math.max(0, Math.min(1, (idleMs || 0) / thr));
    let idleBar = $('idleBar');
    if (!idleBar.classList.contains('bar')) {
      idleBar.className = 'stat-sub bar';
      idleBar.innerHTML = '<i></i>';
    }
    const inner = idleBar.querySelector('i') || (() => { const i = document.createElement('i'); idleBar.appendChild(i); return i; })();
    inner.style.width = `${ratio * 100}%`;
    inner.style.background = ratio >= 1 ? 'var(--grass)' : 'var(--slate2)';

    // 处理器性能比
    $('pdhVal').textContent = `${Math.round(pdhPerfPct || 0)}%`;

    // 卡顿
    $('jankVal').textContent = (janksPerMin || 0).toFixed(0);

    // 负载
    $('loadVal').textContent = isHigh ? '高负载' : '正常';
    $('loadVal').style.color = isHigh ? 'var(--amber)' : 'var(--grass)';
    $('loadDetail').textContent = `CPU${runtime.manual ? '·手动' : ''}`;
  }

  // ---------- SSE ----------
  function connectSSE() {
    const es = new EventSource('/api/status/stream');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'runtime') {
          runtime = msg.runtime;
          paintRuntime();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* 浏览器自动重连 */ };
  }

  // ---------- 历史趋势 ----------
  let currentRange = '1h';
  const trendCanvas = $('trendCanvas');
  const chartTip = $('chartTip');
  let trendFadeTimer = null;

  /** 拉取指定维度数据并重绘。 */
  async function loadTrend(range) {
    currentRange = range;
    document.querySelectorAll('#rangeSwitcher button').forEach((b) => {
      b.classList.toggle('active', b.dataset.range === range);
    });
    try {
      const data = await api(`/api/metrics?range=${encodeURIComponent(range)}`, 'GET');
      const pts = (data && data.points) || [];
      trendCanvas.style.opacity = '0';
      clearTimeout(trendFadeTimer);
      trendFadeTimer = setTimeout(() => {
        WBChart.mount(trendCanvas, { points: pts, range, tooltip: chartTip });
        trendCanvas.style.transition = 'opacity 0.35s ease';
        trendCanvas.style.opacity = '1';
      }, 120);
    } catch (e) {
      toast(`趋势数据加载失败：${e.message}`, true);
    }
  }

  function bindRangeSwitcher() {
    document.querySelectorAll('#rangeSwitcher button').forEach((b) => {
      b.onclick = () => loadTrend(b.dataset.range);
    });
  }

  // resize 重绘（防抖）
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!trendCanvas.__wb) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (trendCanvas.__wb._lastOpts) WBChart.mount(trendCanvas, trendCanvas.__wb._lastOpts);
    }, 150);
  });

  // 周期刷新趋势（每 30s 拉一次当前维度，保持曲线跟进）
  setInterval(() => {
    if (document.visibilityState === 'visible') loadTrend(currentRange);
  }, 30000);

  // ---------- 启动 ----------
  async function boot() {
    try {
      [cfg, schema] = await Promise.all([api('/api/config', 'GET'), api('/api/schema', 'GET')]);
      defaults = schema.defaults || {};
      constraints = schema.constraints || [];
      renderConfigCards();
      renderModeBar();
      paintRuntime();
      bindRangeSwitcher();
      loadTrend(currentRange);
      connectSSE();
    } catch (e) {
      toast(`初始化失败：${e.message}`, true);
    }
  }

  boot();
})();
