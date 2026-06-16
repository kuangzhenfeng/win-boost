# win-boost

Windows 笔记本电源策略**自动切换**工具。两个核心机制由一个统一状态机驱动，互不打架：

1. **空闲降档**：用户 N 分钟无操作 → 自动切到「节能」；检测到操作 → 立刻切回（平衡/更高，由状态机决定）。
2. **卡顿升档**：检测到系统高负载 / UI 丢帧 → 切到「高性能 / 卓越性能」；负载恢复 → 回「平衡」；空闲 → 再降到「节能」。

支持四档：节能 / 平衡 / 高性能 / 卓越性能（Ultimate Performance，本机未启用时自动降级到高性能）。

## 技术栈

- **Node.js**
- 电源切换：`powercfg` 命令（内置方案无需管理员）
- 空闲检测：**koffi** FFI 调 `user32!GetLastInputInfo`
- CPU：Node 原生 `os.cpus()` 双采样
- UI 卡顿：**koffi** 调 `dwmapi!DwmGetCompositionTimingInfo`，主看丢帧（CPU 为主判据，DWM 为副）
- 托盘：`systray2`
- 配置：`%APPDATA%\win-boost\config.json`，原子写
- 自启：注册表 `HKCU\...\Run`（用户级，无需管理员）

> ⚠️ 必须以**普通用户进程**运行（登录自启）。不可做成 Windows Service——Service 跑在 Session 0，`GetLastInputInfo` 拿不到用户输入会失效。

## 安装

```bash
npm install
npm run icon        # 由 assets/icon.ico 生成 res/tray-icon.b64
```

## 使用

```bash
npm start                  # 前台启动托盘 + 状态机（默认）
npm run status             # 打印当前档位/CPU/空闲/DWM/方案映射后退出
npm run schemes            # 打印 powercfg /l 解析结果
npm run once               # 跑一次状态机评估并施效后退出
npm run debug              # 控制台日志 + 逐事件打印
```

子命令（直接跑 exe 或 node src/main.js）：

| 命令 | 说明 |
|---|---|
| `--status` | 一次性打印状态后退出 |
| `--schemes` | 打印电源方案映射 |
| `--once` | 评估一次并施效后退出 |
| `--install` | 写入开机自启注册表项 |
| `--uninstall` | 删除开机自启注册表项 |
| `--debug` | 控制台日志 |
| `--version` | 版本 |

## 配置（`%APPDATA%\win-boost\config.json`）

| 字段 | 默认 | 含义 |
|---|---|---|
| mode | `auto` | `auto`（状态机自动） / `manual`（锁定） |
| idleThresholdMin | 5 | 空闲几分钟切节能 |
| cpuHighPct / cpuCooldownPct | 70 / 45 | CPU 升/降阈值(%)，25pp 滞回死区 |
| cpuHighHoldSec / cpuCooldownHoldSec | 8 / 10 | 连续持续秒数 |
| dwmEnabled | true | 是否启用 DWM 副判据 |
| dwmDropFramesPerMin | 60 | 每分钟丢帧阈值 |
| preferUltimate | true | 升档优先卓越性能 |
| minDwellSec | 15 | 最小驻留秒数（防抖） |
| autoStart | false | 开机自启镜像 |

非法字段会自动回退默认并记录到日志。

## 状态机

```
              active      idle        load_high      load_normal
SAVER       →BALANCED    —           →UP            →BALANCED
BALANCED    —            →SAVER      →UP            —
PERFORMANCE —            →SAVER      —             →BALANCED
ULTIMATE    —            →SAVER      —             →BALANCED

UP = preferUltimate && ULTIMATE 可用 ? ULTIMATE : PERFORMANCE
```

防抖：阈值滞回（70/45）+ 保持计时 + 最小驻留 + 降档单向（PERFORMANCE→normal 只回 BALANCED）+ manual 暂停。

## 测试

```bash
npm test          # node --test（状态机、滞回、powercfg 正则、CPU 汇总纯逻辑）
```

## 打包

```bash
npm run pkg:win   # 产出 dist/win-boost.exe（需 @yao-pkg/pkg）
```

> koffi 的 .node 在 pkg 下运行时解包到 `%TEMP%`，Node ABI 必须与 target 一致；systray2 的 `tray_windows.exe` 已包含在 assets。

## 风险与注意点

- **DWM 失效是常态**：锁屏 / 安全桌面 / DWM 关闭 / 全屏独占游戏下 `DwmGetCompositionTimingInfo` 返回非 0，自动回退纯 CPU。
- **powercfg 多语言输出**：用 GUID 正则（语言无关）+ 友好名关键字双判，不依赖系统语言。
- **卓越性能未启用**：`powercfg /l` 不含则该档不可用，托盘禁用并降级映射。如需启用：
  ```bash
  powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61
  ```
- **GetTickCount 49.7 天回绕**：`(now - dwTime) >>> 0` 自洽。

## 目录结构

```
src/
├─ main.js              入口 + 单例锁 + 生命周期
├─ cli.js               --status/--schemes/--once/--install/--uninstall
├─ autostart.js         HKCU\...\Run reg 操作
├─ constants.js         档位枚举/GUID参考/默认值/校验
├─ orchestrator.js      monitors → stateMachine → power 串联
├─ util/{env,paths,atomic-write}.js
├─ logging/logger.js    winston 按日轮转
├─ config/config-store.js
├─ power/{scheme-registry,power-controller}.js
├─ native/{koffi-loader,idle-native,dwm-native}.js
├─ monitors/{idle,cpu,load}-monitor.js
├─ state/{state-machine,hysteresis}.js
└─ ui/tray-ui.js
```
