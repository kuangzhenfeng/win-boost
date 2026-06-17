'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _buildTaskXml, TASK_NAME } = require('../src/ui-boost/elevated-runner');

test('TASK_NAME: 带反斜杠前缀（schtasks 根任务约定）', () => {
  assert.ok(TASK_NAME.startsWith('\\'));
});

test('_buildTaskXml: Command 与 Arguments 分离，规避 /tr 引号嵌套', () => {
  const xml = _buildTaskXml('C:\\Program Files\\node.exe', ['C:\\Users\\a b\\main.js', '--ui-boost-op']);
  // Command 是独立元素（仅 exe 路径，不含参数）
  assert.match(xml, /<Command>C:\\Program Files\\node\.exe<\/Command>/);
  // Arguments 是独立元素（参数数组 join，含空格的脚本路径无需引号）
  assert.match(xml, /<Arguments>C:\\Users\\a b\\main\.js --ui-boost-op<\/Arguments>/);
  // 最高权限运行级别
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
});

test('_buildTaskXml: XML 特殊字符转义', () => {
  const xml = _buildTaskXml('C:\\a&b<c>d.exe', ['--x<y>z']);
  assert.ok(xml.includes('C:\\a&amp;b&lt;c&gt;d.exe'));
  assert.ok(xml.includes('--x&lt;y&gt;z'));
});

test('_buildTaskXml: 占位触发器禁用（仅靠 /run 手动触发）', () => {
  const xml = _buildTaskXml('wb.exe', ['--ui-boost-op']);
  assert.match(xml, /<BootTrigger><Enabled>false<\/Enabled><\/BootTrigger>/);
});
