'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { CONFIG_SCHEMA, SCHEMA_GROUPS, defaultValue, FIELD_CONSTRAINTS } = require('./schema');

const STATIC_DIR = path.join(__dirname, 'static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(body);
}

function sendStatic(res, relPath) {
  const full = path.join(STATIC_DIR, relPath);
  // 防目录穿越：必须落在 static 目录内
  if (!full.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > 1 << 20) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * 创建内嵌 web 服务。仅绑 127.0.0.1，随机端口。
 *
 * @param {{configStore:object, orchestrator:object, historyRecorder?:object, token:string, logger?:object, onAutostart:(v:boolean)=>void}} opts
 * @returns {Promise<{server:http.Server, port:number, token:string, url:string, close:()=>Promise<void>}>}
 */
function createWebServer({ configStore, orchestrator, historyRecorder, token, logger, onAutostart, onUiBoost }) {
  const clients = new Set();
  const log = (lvl, m) => {
    if (logger && logger[lvl]) logger[lvl](`[web] ${m}`);
  };

  function broadcast(obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        // ignore 单连接异常
      }
    }
  }

  // orchestrator runtime 事件 → 立即推送
  if (orchestrator && orchestrator.on) {
    orchestrator.on('runtime', (r) => broadcast({ type: 'runtime', runtime: r }));
  }

  // 周期推送（每秒），保证前端持续看到实时 CPU/空闲，并顺带推曲线最新点
  const beat = setInterval(() => {
    if (clients.size > 0 && orchestrator && orchestrator.getRuntime) {
      const frame = { type: 'runtime', runtime: orchestrator.getRuntime() };
      // 附带曲线最新采样点：前端在 1h 维度增量追加，秒级平滑推进；
      // 1d/30d 维度数据源是分钟/小时桶（与该秒级点粒度不同），前端忽略它。
      if (historyRecorder && historyRecorder.latest) {
        const lp = historyRecorder.latest();
        if (lp) frame.trendPoint = lp;
      }
      broadcast(frame);
    }
  }, 1000);
  if (beat.unref) beat.unref();

  function checkToken(req, u) {
    const t = u.searchParams.get('t') || req.headers['x-wb-token'];
    return t === token;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    // ---- SSE 状态流 ----
    if (req.method === 'GET' && p === '/api/status/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      if (orchestrator && orchestrator.getRuntime) {
        res.write(`data: ${JSON.stringify({ type: 'runtime', runtime: orchestrator.getRuntime() })}\n\n`);
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ---- 读类 API ----
    if (req.method === 'GET' && p === '/api/config') return sendJson(res, 200, configStore.getAll());
    if (req.method === 'GET' && p === '/api/schema') {
      const defaults = {};
      for (const f of CONFIG_SCHEMA) defaults[f.key] = defaultValue(f.key);
      return sendJson(res, 200, { groups: SCHEMA_GROUPS, fields: CONFIG_SCHEMA, defaults, constraints: FIELD_CONSTRAINTS });
    }
    // 历史趋势：按维度切片返回秒/分/时级时间序列（只读，无需令牌）
    if (req.method === 'GET' && p === '/api/metrics') {
      if (!historyRecorder || !historyRecorder.queryByRange) return sendJson(res, 200, { range: null, points: [] });
      const range = u.searchParams.get('range');
      const points = historyRecorder.queryByRange(range);
      if (points === null) return sendJson(res, 400, { error: 'invalid range' });
      return sendJson(res, 200, { range, points });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendStatic(res, 'index.html');
    if (req.method === 'GET' && (p === '/styles.css' || p === '/app.js' || p === '/chart.js' || p === '/tailwind.css')) return sendStatic(res, p.slice(1));
    if (req.method === 'GET' && p.startsWith('/fonts/')) return sendStatic(res, p);

    // ---- 写类 API（需令牌）----
    if (['POST', 'PUT'].includes(req.method)) {
      if (!checkToken(req, u)) return sendJson(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      if (body === null) return sendJson(res, 400, { error: 'bad json' });

      if (p === '/api/config') {
        const prevAll = configStore.getAll();
        const prevUiBoost = !!prevAll.uiBoostEnabled;
        const next = configStore.set(body || {});
        // UI 提速联动：两类变更需触发提权流程——
        //  (1) 开关翻转：uiBoostEnabled 变化 → 整体启用/禁用
        //  (2) 子参数变更（提速态下）：前台优先级/后台预留/网络节流变化 → 重写注册表
        // 提权流程异步、可能弹 UAC，结果经 onUiBoost 回调异步处理（SSE 推送刷新）。
        const enableToggled = typeof body.uiBoostEnabled === 'boolean' && !!body.uiBoostEnabled !== prevUiBoost;
        const SUB_KEYS = ['uiBoostPriorityLevel', 'uiBoostSystemResponsiveness', 'uiBoostEnableNetworkThrottle'];
        const subChanged = prevUiBoost && SUB_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body, k));
        if (onUiBoost && (enableToggled || subChanged)) {
          onUiBoost({ enableToggled, cfg: next }, (ok, reason) => {
            broadcast({ type: 'ui-boost', ok, reason: reason || null });
          });
        }
        return sendJson(res, 200, next);
      }
      if (p === '/api/mode') {
        if (body && typeof body.pause === 'boolean') orchestrator.command({ kind: 'pause', value: body.pause });
        else if (body && body.mode === 'manual') orchestrator.command({ kind: 'manual', scheme: body.scheme });
        else if (body && body.mode === 'auto') orchestrator.command({ kind: 'mode_auto' });
        else return sendJson(res, 400, { error: 'invalid mode body' });
        return sendJson(res, 200, { ok: true, runtime: orchestrator.getRuntime() });
      }
      if (p === '/api/autostart') {
        if (onAutostart) onAutostart(!!body.value);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      log('info', `web 服务监听 127.0.0.1:${port}`);
      resolve({
        server,
        port,
        token,
        url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`,
        close: () =>
          new Promise((r) => {
            clearInterval(beat);
            server.close(() => r());
          }),
      });
    });
  });
}

module.exports = { createWebServer };
