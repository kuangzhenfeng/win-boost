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

  start() {
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

    this._tray.onClick((action) => {
      const idx = typeof action.seq_id === 'number' ? action.seq_id : parseInt(action.seq_id, 10);
      const meta = this._items[idx] && this._items[idx].meta;
      if (!meta) return;
      this._handleClick(meta, action);
    });
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
    if (!this._tray) return;
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
