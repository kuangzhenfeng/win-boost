# Win-Boost 历史趋势曲线 — 设计文档

日期：2026-06-17
状态：已定稿
范围：在现有 web 控制台新增"历史趋势"卡，用 canvas 曲线图可视化 CPU 占用、处理器性能比、卡顿随时间的变化，并以档位色带表示档位分布；支持 1 小时 / 1 天 / 30 天 维度切换，默认 1 天。

---

## 1. 目标与非目标

**目标**
- 把"过去一段时间的趋势"可视化：CPU 占用率曲线、处理器性能比曲线、卡顿次数曲线，背景按档位着色带。
- 维度切换 1 小时 / 1 天 / 30 天，默认 1 天。
- 历史数据落盘，进程重启后历史不丢（≤60s 损失可接受）。
- 零新增依赖（沿用内置 http + 手绘 canvas + 项目已有 atomicWriteJson）。

**非目标**
- 不做实时滚动（实时秒级跳动仍由上方既有"实时工况卡"承担，职责不重叠）。
- 不重构既有 monitor / orchestrator 采样链。
- 不采集 CPU/处理器性能比/卡顿/档位以外的指标（无内存/温度/GPU 数据源）。

---

## 2. 数据模型

每个采样点（秒级时间戳）：
```
{ t: number(秒), cpu: number(0..100), perf: number(处理器性能比%), jank: number(卡顿次/分), scheme: string(SAVER|BALANCED|PERFORMANCE|ULTIMATE) }
```

三档桶（多级降采样滚降）：

| 桶 | 粒度 | 保留 | 点数上限 | 持久化 | 服务维度 |
|---|---|---|---|---|---|
| 原始 raw | 1 秒 | 2 小时 | 7200 | 否（内存） | 1 小时 |
| minute | 60 秒 | 2 天 | 2880 | 是 | 1 天 |
| hour | 3600 秒 | 30 天 | 720 | 是 | 30 天 |

折叠（rollup）规则：对"已结束的完整分钟/小时"的子点，cpu/perf/jank 取平均、scheme 取众数，归并为一个上级点。raw→minute→hour 逐级滚降。

---

## 3. 后端

### 3.1 HistoryRecorder（`src/metrics/history-recorder.js`）

- 复用 `orchestrator.getRuntime()` 的现成快照（`cpuEma`/`pdhPerfPct`/`janksPerMin`/`state`），**不新增 native 调用、不重复算 CPU**。
- 每 1 秒采样 push 进 raw，触发按时间边界对齐的 rollup（折叠已结束的完整分钟→minute，完整小时→hour），并裁剪各桶容量。
- 持久化：minute/hour 写 `metrics.json`；每 60 秒若有变更（dirty）写一次；start() 加载、stop() 最后写一次。
- 不进 orchestrator：职责归属——orchestrator 管"电源决策"，recorder 管"数据记录"，互不侵入。

### 3.2 端点

| 方法 | 路径 | 令牌 | 作用 |
|---|---|---|---|
| GET | `/api/metrics?range=1h\|1d\|30d` | 否 | 返回该维度时间序列 |

- `1h` → raw 最近 1 小时；`1d` → minute 最近 1 天（1440）；`30d` → hour 全部（720）。
- 查询期零降采样（桶粒度即查询粒度），后端只切片返回。
- range 非法 → 400 `{ error: 'invalid range' }`。
- 数据不足（刚启动）→ 返回已有部分点，前端照画。

返回体：`{ range, points: [...] }`。

### 3.3 接线（`main.js`）

web server 启动前 `new HistoryRecorder({ orchestrator, logger }).start()`，把实例注入 `createWebServer({ historyRecorder })`；shutdown 时 `.stop()`。

`src/util/paths.js` 新增 `getMetricsPath()` → 根目录 `metrics.json`。

---

## 4. 前端

### 4.1 卡片

在"实时工况卡"与"模式快捷卡"之间插入全宽"历史趋势"卡（hero-card 同款暖色质感）。含：标题 + 维度切换器（分段按钮，默认 1d active）+ 图例 + canvas 画布。

### 4.2 canvas 渲染（`src/web/static/chart.js`，零依赖）

分层（z 从底到顶）：
1. 档位色带：按连续相同 scheme 的区间画竖矩形，淡透明色（SAVER→slate、BALANCED→grass、PERFORMANCE→amber、ULTIMATE→rust）。
2. 网格 + 左轴刻度：左轴 0..axisMax（CPU 0-100，扩展区承载处理器性能比睿频峰值，刻度步进 25）。
3. CPU 曲线：草绿 + 下方淡填充，左轴。
4. 卡顿次数曲线：柔紫细线，右轴（次/分，独立量纲）。
5. 处理器性能比曲线：静灰虚线，复用左轴（100=标称基线，>100=睿频）。
6. 悬停：竖虚线 + 高亮点 + DOM tooltip（该时刻 CPU/性能比/卡顿/档位）。

技术细节：devicePixelRatio 高清适配；点数过多用 LTTB 降采样（上限 ~1200）；时间标签按 range 自适应（1h/1d → HH:MM，30d → MM-DD）。

### 4.3 交互（`app.js`）

- 默认拉 `/api/metrics?range=1d` → drawChart。
- 切维度重拉 + 淡入重绘。
- 窗口 resize 重绘。
- hover 显示 tooltip。
- 不做实时滚动。

---

## 5. 测试（node:test）

- `test/history-recorder.test.js`：采样累积；跨分钟边界 fold 出 minute 点（cpu 平均/scheme 众数）；跨小时 fold 出 hour 点；queryByRange 切片正确；load/persist 往返；容量裁剪。
- `test/web-server.test.js` 增：`/api/metrics?range=1d` 返回 points；非法 range → 400。

---

## 6. 风险与取舍

- **采样复用 getRuntime**：零侵入、零新增 native 调用。
- **raw 不落盘**：重启丢失最近 2h 的秒级细节，但 minute/hour 有历史；趋势图可接受。
- **崩溃损失**：最多丢 60s（自上次 persist 的 minute 折叠）。
- **零依赖**：手绘 canvas，与现有暖色主题/离线哲学统一。
