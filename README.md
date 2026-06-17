# win-boost

Windows 笔记本电源策略**自动切换**工具。两个核心机制由一个统一状态机驱动，互不打架：

1. **空闲降档**：用户 N 分钟无操作 → 自动切到「节能」；检测到操作 → 立刻切回（平衡/更高，由状态机决定）。
2. **卡顿升档**：检测到系统高负载 / 处理器睿频 / 卡顿 → 切到「高性能 / 卓越性能」；负载恢复 → 回「平衡」；空闲 → 再降到「节能」。

支持四档：节能 / 平衡 / 高性能 / 卓越性能（Ultimate Performance，本机未启用时自动降级到高性能）。

> **升档判据（三路，任一触发即升）**：
> - **CPU 占用率**（主判据）：`os.cpus()` 双采样 + EMA。
> - **处理器性能比**（PDH，主流工业级副判据）：`\Processor Information\% Processor Performance`，>100% 表示正在睿频——即频率已贴天花板、当前档位不够用，是最对症的升档信号。
> - **卡顿**（心跳探针，全场景有效副判据）：进程内高频心跳测事件循环抖动，gap >60ms（≈丢 3 帧@60fps，用户可感知）计一次卡顿。代理系统调度竞争（本质是系统级调度卡顿，非仅 UI 卡顿；为表述简明统一称"卡顿"），**RDP / 锁屏 / 全屏独占 / 重定向显示下都不失效**。
> 三路互为补充：CPU 看占用率，PDH 直接看频率是否贴天花板，卡顿代理系统调度紧张。

## 技术栈

- **Node.js**
- 电源切换：`powercfg` 命令（内置方案无需管理员）
- 空闲检测：**koffi** FFI 调 `user32!GetLastInputInfo`
- CPU：Node 原生 `os.cpus()` 双采样
- 处理器性能比：**koffi** 调 `pdh!Pdh*` 读 `\Processor Information\% Processor Performance`（>100% 睿频 → 升档副判据；RDP/锁屏下仍有效）
- 卡顿：进程内高频心跳定时器测事件循环抖动（gap>60ms 计卡顿，代理系统调度竞争；零 native、免管理员、全场景有效）
- 托盘：`systray2`
- 历史趋势：纯手绘 canvas（零依赖），多级降采样（秒/分/时）+ 原子写落盘
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
npm run status             # 打印当前档位/CPU/空闲/方案映射后退出
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

## 可视化配置网页

守护进程启动时内嵌一个**仅监听 127.0.0.1** 的轻量 HTTP 服务（Node 内置 `http`，无外部依赖），随机选取可用端口。两种打开方式：

- **托盘 → 🌐 打开配置网页**：用系统默认浏览器打开（URL 内含一次性令牌，免登录）。
- 端口/令牌/PID 记录在 `%APPDATA%\win-boost\web-server.json`，供外部工具发现。

功能：
- **实时状态**：当前档位、CPU 占用（EMA）、空闲计时、CPU 性能比（% Processor Performance）、卡顿/分、负载态（通过 SSE 每秒推送）。
- **历史趋势曲线**：CPU 占用、处理器性能比（% Processor Performance，100=标称/>100=睿频）、卡顿/分随时间的变化以曲线图可视化，背景按档位（节能/平衡/高性能/卓越性能）着色带，直观展示"哪个时段系统处于什么档、是否在睿频"。支持 **1 小时 / 1 天 / 30 天** 维度切换（默认 1 小时），鼠标悬停查看任一时刻的精确数值。历史数据多级降采样落盘（`metrics.json`），进程重启后历史不丢。
- **全配置编辑**：模式（自动/手动 + 锁定档位）、空闲阈值、CPU 滞回阈值、处理器性能（PDH）、卡顿、状态机驻留、日志级别，按字段动态渲染。保存即**热重载**，无需重启进程。
- 安全：变更类接口（POST）须携带随机令牌；读取类（GET）不校验，便于观察。

前端为柔和暖色 Tailwind 卡片风格（亮色），趋势图由纯手绘 canvas（零依赖）渲染，与暖色主题统一；Tailwind 经本地构建（`npm run web:build`）产出离线可用的 CSS，不依赖 CDN。

| 指令 | 说明 |
|---|---|
| `npm run web:build` | 由 `web/src.css` 构建 `src/web/static/tailwind.css`（已提交，改样式后重跑） |
| `npm run web:watch` | 监听模式，开发期实时重建 CSS |

## 配置（`%APPDATA%\win-boost\config.json`）
| 字段 | 默认 | 含义 |
|---|---|---|
| mode | `auto` | `auto`（状态机自动） / `manual`（锁定） |
| idleThresholdMin | 5 | 空闲几分钟切节能 |
| cpuHighPct / cpuCooldownPct | 70 / 45 | CPU 升/降阈值(%)，25pp 滞回死区 |
| cpuHighHoldSec / cpuCooldownHoldSec | 8 / 10 | 连续持续秒数 |
| pdhEnabled | true | 是否启用处理器性能副判据（PDH） |
| pdhHighPct | 130 | 处理器性能比升档阈值(%)，100=标称、>100=睿频 |
| pdhHoldSec | 8 | 持续秒数 |
| jankEnabled | true | 是否启用卡顿副判据（心跳探针） |
| jankPerMin | 20 | 每分钟卡顿升档阈值（gap>60ms 计一次） |
| jankHoldSec | 8 | 持续秒数 |
| uiBoostEnabled | false | 启用 UI 提速（见下） |
| preferUltimate | true | 升档优先卓越性能 |
| minDwellSec | 15 | 最小驻留秒数（防抖） |
| autoStart | false | 开机自启镜像 |

非法字段会自动回退默认并记录到日志。

## 历史趋势数据（`%APPDATA%\win-boost\metrics.json`）

守护进程每秒采样一次运行态（复用状态机的 CPU/性能比/卡顿/档位快照，不新增采集开销），做多级降采样滚降并落盘，供网页趋势图查询：

| 维度 | 数据来源 | 粒度 | 保留 |
|---|---|---|---|
| 1 小时 | 原始桶（内存） | 1 秒 | 2 小时 |
| 1 天 | 分钟桶（落盘） | 60 秒 | 2 天 |
| 30 天 | 小时桶（落盘） | 1 小时 | 30 天 |

折叠时 cpu/perf/jank 取平均、档位取众数。查询接口 `GET /api/metrics?range=1h|1d|30d`（只读，无需令牌）。秒级原始桶仅在内存（重启可丢最近 2 小时秒级细节，分钟/小时历史保留）。

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

- **卡顿探针**：进程内 20ms 心跳测事件循环抖动，gap − 20ms > 40ms（即实际 gap>60ms）计一次卡顿。它是系统调度竞争程度的代理量——CPU 被编译/打包/索引等任务占满、调度紧张时心跳被推迟。心跳/阈值/窗口硬编码（实现旋钮不参数化），用户侧只调每分钟卡顿阈值。本机空闲基线实测 janksPerMin≈0，阈值 20 不会被时钟抖动误触发。
- **处理器性能（PDH）计数器**：读 `\Processor Information(_Total)\% Processor Performance`，绝大多数现代 Windows 均支持；极个别精简系统无此计数器时自动降级，不影响其余判据。
- **powercfg 多语言输出**：用 GUID 正则（语言无关）+ 友好名关键字双判，不依赖系统语言。
- **卓越性能未启用**：`powercfg /l` 不含则该档不可用，托盘禁用并降级映射。如需启用：
  ```bash
  powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61
  ```
- **GetTickCount 49.7 天回绕**：`(now - dwTime) >>> 0` 自洽。
- **web 端口随机**：每次启动端口可能变化；托盘打开用进程内存端口，`web-server.json` 供外部发现。
- **web 令牌**：每次启动生成随机令牌，变更类接口必带；仅绑 127.0.0.1，不对外。
- **UI 提速**：改 HKLM 系统调度参数需管理员。实现走「计划任务免 UAC」——首次开启弹一次 UAC 创建最高权限计划任务（`schtasks` XML 定义 `RunLevel=HighestAvailable`，任务体结构化 `{exe,args}` 经 XML 装载，规避 `/tr` 对含空格路径的引号嵌套解析），之后所有切换经 `schtasks /run` 零 UAC 触发。改三个参数：`Win32PrioritySeparation=38`（短量子+前台最大提升，即时生效）、`SystemResponsiveness=10`、`NetworkThrottlingIndex=0xFFFFFFFF`。启用时原子备份原值到 `ui-boost-backup.json`（部分写入失败自动回滚，不落盘备份），禁用/退出时还原；`backup.json` 存在即「当前已提速」（提速态唯一可信事实来源，优于开关意图）。进程退出必还原，下次启动 `reconcile` 按配置重新启用——避免崩溃后系统长期处于改动态。

## 目录结构

```
src/
├─ main.js              入口 + 单例锁 + 生命周期 + web 服务接线
├─ cli.js               --status/--schemes/--once/--install/--uninstall
├─ autostart.js         HKCU\...\Run reg 操作
├─ constants.js         档位枚举/GUID参考/默认值/校验
├─ orchestrator.js      monitors → stateMachine → power 串联 + applyConfig 热重载
├─ util/{env,paths,atomic-write}.js
├─ logging/logger.js    winston 按日轮转
├─ config/config-store.js
├─ metrics/history-recorder.js  运行态多级降采样采样器 + 落盘
├─ power/{scheme-registry,power-controller}.js
├─ native/{koffi-loader,idle-native,pdh-native,shell-native}.js
├─ monitors/{idle,cpu,jank,load}-monitor.js
├─ state/{state-machine,hysteresis}.js
├─ ui-boost/            UI 提速（系统调度参数提权管理）
│  ├─ ui-boost-registry.js    3 个 HKLM 参数定义（纯数据）
│  ├─ ui-boost-ops.js         注册表读/写/备份/还原（提权实例执行体）
│  ├─ elevated-runner.js      schtasks 计划任务（XML + /RL HIGHEST）
│  └─ ui-boost-controller.js  启用/禁用/启动恢复/退出还原编排
├─ ui/tray-ui.js        托盘菜单（含"打开配置网页"）
└─ web/
   ├─ server.js         内嵌 HTTP + SSE + 令牌 + 静态服务
   ├─ schema.js         配置字段元数据（前后端共享）
   └─ static/           index.html / styles.css / app.js / chart.js / tailwind.css
web/                    Tailwind 源与配置（构建期用，不进运行时）
```
