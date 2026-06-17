'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { APP_NAME } = require('../constants');

/**
 * 提权计划任务管理（schtasks，XML 定义 + /RL HIGHEST）。
 *
 * 为什么用计划任务：写 HKLM 需管理员，win-boost 是普通用户进程。计划任务的
 * RunLevel=HighestAvailable 让任务以本用户的最高权限运行，且 schtasks /run 启动它
 * **不弹 UAC**——任务在创建时已授权最高权限，运行时复用该授权。代价是创建任务本身
 * 仍需提权（一次 UAC），之后所有启用/禁用/退出还原都通过 /run 触发，零 UAC。
 *
 * 为什么用 XML 而非 /tr 命令行：/tr 的值若含空格路径需引号包裹，与外层 /tr 引号嵌套
 * 形成 `""path" "path""`，schtasks 解析必错（node.exe 常在 `C:\Program Files\`，
 * 打包 exe 也可能含空格）。XML 的 <Command> 与 <Arguments> 各为独立元素，
 * 彻底规避命令行转义地狱。这是创建含空格路径任务的工业级正确做法。
 *
 * 非提权创建 HIGHEST 任务会失败（计划任务是受保护资源），故创建用 ShellExecute runas
 * 触发 UAC（见 shell-native）；运行用非提权 schtasks /run 即可（自己创建的任务普通用户可触发）。
 *
 * 单一职责：只管"创建/运行/卸载这个提权任务"，不关心任务体做什么（任务体由调用方
 * 以 { exe, args } 结构化传入，固定为 win-boost 自身的 --ui-boost-op 执行流）。
 *
 * 依赖注入：shell 调用经注入的 exec/runas 函数，便于单元测试（桩替换）。
 */

const SCHTASKS = 'schtasks.exe';
// 任务名带反斜杠前缀（schtasks 根任务以 \ 开头），避免与系统任务重名
const TASK_NAME = `\\${APP_NAME}UiBoost`;

/**
 * 生成任务定义 XML（UTF-16，RunLevel=HighestAvailable）。
 * <Command> 与 <Arguments> 分离，各自独立元素，规避 /tr 引号嵌套。
 * BootTrigger 置 disabled：仅占位触发器，实际靠 /run 手动触发（我们不设开机自动提速）。
 * @param {string} exe 可执行镜像全路径
 * @param {string[]} args 参数数组
 */
function _buildTaskXml(exe, args) {
  // XML 转义（路径与参数里可能含 & < >）
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const argsStr = (args || []).map(esc).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Triggers><BootTrigger><Enabled>false</Enabled></BootTrigger></Triggers>
  <Settings>
    <Enabled>true</Enabled>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(exe)}</Command>
      <Arguments>${argsStr}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * 创建（提权，一次性 UAC）：写 XML → 用 ShellExecuteW runas 跑 schtasks /create /xml /RL。
 * 经 shell-native 触发 UAC，系统弹 consent 提示框，用户确认后任务以最高权限创建。
 * @param {object} opts
 * @param {string} opts.exe 可执行镜像全路径
 * @param {string[]} opts.args 参数数组（如 ['--ui-boost-op'] 或 ['main.js', '--ui-boost-op']）
 * @param {(file:string,params:string)=>boolean} [opts.runas] runas 执行器（默认 shell-native）
 * @param {string} [opts.xmlPath] XML 临时文件路径（测试注入；默认系统 temp）
 * @returns {boolean} 是否成功发出 runas（UAC 由用户确认；实际成功事后校验）
 */
function installTask({ exe, args, runas, xmlPath }) {
  if (!exe) throw new Error('installTask 需要 exe');
  const runner = runas || require('../native/shell-native').runas;
  const xml = _buildTaskXml(exe, args);
  // schtasks /xml 的 XML 解析器要求 UTF-16LE 且**带 BOM**：无 BOM 时报
  // "任务 XML 格式错误 (1,2) 一个根元素"（首字符 <? 被当成多字节乱码）。
  // Node 的 'utf16le' 编码只写码元、不写 BOM，故手动补 0xFF 0xFE 前缀。
  const file = xmlPath || path.join(os.tmpdir(), `${APP_NAME}-ui-boost-task.xml`);
  const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]);
  fs.writeFileSync(file, buf);
  // /create /tn ... /xml <file> /f：/rl 由 XML 内 RunLevel 决定（HighestAvailable）
  const params = `/create /tn "${TASK_NAME}" /xml "${file}" /f`;
  return runner(SCHTASKS, params);
}

/**
 * 触发任务执行（非提权，零 UAC）：schtasks /run /tn。
 * 任务体读 op 指令文件决定 apply 还是 revert。
 * @param {object} [opts]
 * @param {(file:string,args:string[])=>void} [opts.exec] 执行器（默认 execFileSync schtasks）
 * @returns {boolean} schtasks /run 是否成功（退出码 0）
 */
function runTask(opts = {}) {
  const exec = opts.exec || ((file, args) => execFileSync(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }));
  try {
    exec(SCHTASKS, ['/run', '/tn', TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 卸载任务（提权，需 UAC）：schtasks /delete。经 runas 触发 UAC。
 * 彻底关闭 UI 提速时清理提权任务；非提权 delete 会失败（受保护资源）。
 * @param {object} [opts]
 * @param {(file:string,params:string)=>boolean} [opts.runas] runas 执行器
 * @returns {boolean} 是否成功发出 runas
 */
function deleteTask({ runas } = {}) {
  const runner = runas || require('../native/shell-native').runas;
  return runner(SCHTASKS, `/delete /tn "${TASK_NAME}" /f`);
}

/** 查询任务是否存在（非提权可查自己创建的任务）。返回 true/false。 */
function taskExists(opts = {}) {
  const exec = opts.exec || ((file, args) => execFileSync(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  try {
    exec(SCHTASKS, ['/query', '/tn', TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  TASK_NAME,
  installTask,
  runTask,
  deleteTask,
  taskExists,
  _buildTaskXml,
};
