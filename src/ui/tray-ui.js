'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { Scheme, SCHEME_ORDER, SCHEME_LABEL } = require('../constants');

let SysTray = null;
function tryRequireSysTray() {
  if (SysTray !== null) return SysTray;
  try {
    // systray2 默认导出类；node-systray 同
    // eslint-disable-next-line global-require
    const mod = require('systray2');
    SysTray = (mod && (mod.default || mod.SysTray || mod)) || false;
  } catch {
    SysTray = false;
  }
  return SysTray;
}

/**
 * TrayUI：systray2 托盘封装。
 * 菜单项顺序固定，seq_id 即索引。refresh() 按 snapshot 重建勾选状态。
 *
 * 命令（emit 'command'）：
 *   { kind:'mode_auto' }
 *   { kind:'manual', scheme }
 *   { kind:'pause', value:true|false }
 *   { kind:'autostart', value:true|false }
 *   { kind:'settings' }
 *   { kind:'quit' }
 */
class TrayUI extends EventEmitter {
  constructor({ tooltip = 'Win-Boost', logger } = {}) {
    super();
    this._logger = logger;
    this._tooltip = tooltip;
    this._tray = null;
    this._icon = this._loadIcon();
    // seq_id → 菜单项元数据
    this._items = [];
    this._snapshot = { state: Scheme.BALANCED, manual: false, paused: false, available: [] };
    this._autostart = false;
  }

  _log(level, msg) {
    if (this._logger && this._logger[level]) this._logger[level](`[tray] ${msg}`);
  }

  _loadIcon() {
    // 优先打包进 exe 的 base64；开发期直接读 assets/icon.ico
    const candidates = [
      path.join(__dirname, '..', '..', 'res', 'tray-icon.b64'),
      path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p);
        if (p.endsWith('.b64')) {
          return raw.toString('utf8').trim();
        }
        // .ico → base64
        return raw.toString('base64');
      } catch {
        // continue
      }
    }
    // 占位：1x1 透明 PNG 的 base64，保证托盘能创建
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  }

  /** 根据当前 snapshot 构建菜单项数组 */
  _buildItems() {
    const s = this._snapshot;
    const items = [];

    // [0] 当前档位（只读）
    items.push({
      meta: { kind: 'noop' },
      item: {
        title: `当前档位: ${SCHEME_LABEL[s.state] || s.state}`,
        tooltip: '当前电源档位',
        checked: false,
        enabled: false,
      },
    });

    // [1] 分隔
    items.push({ meta: { kind: 'sep' }, item: { title: '─', tooltip: '', checked: false, enabled: false } });

    // [2] 自动
    items.push({
      meta: { kind: 'mode_auto' },
      item: {
        title: '自动切换',
        tooltip: '恢复空闲/负载自动切换',
        checked: !s.manual && !s.paused,
        enabled: true,
      },
    });

    // [3..6] 各档手动
    for (const scheme of SCHEME_ORDER) {
      const avail = s.available.includes(scheme);
      items.push({
        meta: { kind: 'manual', scheme },
        item: {
          title: SCHEME_LABEL[scheme],
          tooltip: avail ? `手动锁定到${SCHEME_LABEL[scheme]}` : `${SCHEME_LABEL[scheme]}（本机不可用）`,
          checked: s.manual && s.state === scheme,
          enabled: avail,
        },
      });
    }

    // [7] 分隔
    items.push({ meta: { kind: 'sep' }, item: { title: '─', tooltip: '', checked: false, enabled: false } });

    // 开机自启
    items.push({
      meta: { kind: 'autostart' },
      item: {
        title: '开机自启',
        tooltip: '登录时自动启动',
        checked: this._autostart,
        enabled: true,
      },
    });

    // 暂停自动切换
    items.push({
      meta: { kind: 'pause' },
      item: {
        title: '暂停自动切换',
        tooltip: '锁定在当前档位',
        checked: s.paused,
        enabled: true,
      },
    });

    // 设置
    items.push({
      meta: { kind: 'settings' },
      item: { title: '打开配置目录', tooltip: '打开 %APPDATA%\\win-boost', checked: false, enabled: true },
    });

    // 退出
    items.push({
      meta: { kind: 'quit' },
      item: { title: '退出', tooltip: '退出 Win-Boost', checked: false, enabled: true },
    });

    return items;
  }

  /**
   * 启动托盘。返回 Promise：在托盘子进程真正 ready（菜单已注册、可接受 update-item）后 resolve。
   *
   * 关键时序约束：getlantern/systray 在 onReady 里才把菜单项注册成带 internalId 的列表。
   * 在此之前若发 update-item，exe 端用 seq_id 索引空/半满的内部数组 →
   * "index out of range" panic → 子进程崩溃 → 托盘消失。
   * 因此本类所有 refresh（即 sendAction update-item）必须等 ready 之后。
   *
   * @returns {Promise<void>}
   */
  async start() {
    const SysTrayCtor = tryRequireSysTray();
    if (!SysTrayCtor) {
      this._log('error', 'systray2 未安装，托盘不可用（无头模式）');
      return;
    }
    const built = this._buildItems();
    this._items = built;
    this._tray = new SysTrayCtor({
      menu: {
        icon: this._icon,
        title: 'Win-Boost',
        tooltip: this._tooltip,
        items: built.map((b) => b.item),
      },
      debug: false,
      copyDir: false,
    });

    // 关键：托盘子进程默认不阻止 Node 退出（无 IPC 通道，child_process 不会让
    // 事件循环保持引用）。而本程序其余定时器（idle/cpu/beat/dwm）全部 unref()，
    // 于是 orch.start() 一返回主循环就空了 → Node 退出 → 托盘刚建好就被带走，
    // 表现为"托盘不显示 / 进程秒退"。
    // 用一个 unref=false 的 setInterval 持有一个长期引用，确保只要托盘在运行，
    // 事件循环就不会空。这是守护进程式的 GUI 应用的常规做法。
    this._keepAlive = setInterval(() => {}, 60 * 60 * 1000);

    // 托盘子进程的 stdio 是 pipe（getlantern/systray 用 stdin/stdout JSON 通信，
    // stderr 输出它自己的 Go 错误日志）。监听它的退出与 stderr：
    //  - exit：记录并清掉 keep-alive（托盘已死，程序没理由再挂着）。
    //  - stderr：getlantern/systray 在 SetIcon 失败等情况下会把详细错误打到 stderr，
    //    透传到日志，方便排查"图标不显示"这类静默问题。
    const attachWatchers = () => {
      const proc = this._tray._process || (this._tray.process && this._tray.process);
      if (!proc || typeof proc.once !== 'function') return;
      proc.once('exit', (code) => {
        this._log('warn', `托盘子进程退出 (code=${code})`);
        this._ready = false;
        this._clearKeepAlive();
      });
      if (proc.stderr) {
        let buf = '';
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this._log('warn', `[tray-native] ${line}`);
          }
        });
      }
    };

    // systray2 的 init()（spawn 子进程 + 等其 onReady）是异步的；_ready 是其 Promise。
    // 必须等它 resolve 后，exe 端菜单才算注册完成，此时发 update-item 才安全。
    try {
      await this._tray._ready;
      this._ready = true;
      attachWatchers();
    } catch (e) {
      this._log('error', `托盘初始化失败: ${e && e.message}`);
      this._clearKeepAlive();
      return;
    }

    this._tray.onClick((action) => {
      const idx = typeof action.seq_id === 'number' ? action.seq_id : parseInt(action.seq_id, 10);
      const meta = this._items[idx] && this._items[idx].meta;
      if (!meta) return;
      this._handleClick(meta, action);
    });
  }

  /** 托盘是否已就绪（可安全 refresh）。未就绪时 refresh 调用会被静默跳过。 */
  get ready() {
    return !!this._ready;
  }

  _clearKeepAlive() {
    if (this._keepAlive) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }

  _handleClick(meta, action) {
    switch (meta.kind) {
      case 'mode_auto':
        this.emit('command', { kind: 'mode_auto' });
        break;
      case 'manual':
        this.emit('command', { kind: 'manual', scheme: meta.scheme });
        break;
      case 'pause': {
        const value = !this._snapshot.paused;
        this.emit('command', { kind: 'pause', value });
        break;
      }
      case 'autostart': {
        const value = !this._autostart;
        this.emit('command', { kind: 'autostart', value });
        // 立即反馈勾选（实际注册由 orchestrator/上层处理）
        this._autostart = value;
        this._refreshAll();
        break;
      }
      case 'settings':
        this.emit('command', { kind: 'settings' });
        break;
      case 'quit':
        this.emit('command', { kind: 'quit' });
        break;
      default:
        break;
    }
  }

  /**
   * @param {{state:string, manual:boolean, paused:boolean, available:string[], autostart?:boolean}} snapshot
   */
  refresh(snapshot) {
    if (snapshot) {
      this._snapshot.state = snapshot.state || this._snapshot.state;
      this._snapshot.manual = !!snapshot.manual;
      this._snapshot.paused = !!snapshot.paused;
      this._snapshot.available = snapshot.available || this._snapshot.available;
      if (typeof snapshot.autostart === 'boolean') this._autostart = snapshot.autostart;
    }
    this._refreshAll();
  }

  _refreshAll() {
    if (!this._tray || !this._ready) return; // 未就绪时跳过：ready 前发 update-item 会让 exe panic
    const built = this._buildItems();
    // 逐项 update-item（只更新 title/checked/enabled）
    for (let i = 0; i < built.length; i++) {
      try {
        this._tray.sendAction({
          type: 'update-item',
          item: built[i].item,
          seq_id: i,
        });
      } catch (e) {
        this._log('debug', `update-item ${i} 失败: ${e.message}`);
      }
    }
    this._items = built;
  }

  setAutostart(value) {
    this._autostart = !!value;
    this._refreshAll();
  }

  stop() {
    this._clearKeepAlive();
    if (this._tray) {
      try {
        this._tray.kill();
      } catch {
        // ignore
      }
      this._tray = null;
    }
  }
}

module.exports = { TrayUI };
