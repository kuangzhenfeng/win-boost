'use strict';

/**
 * @yao-pkg/pkg 打包配置。
 * 单独文件便于维护（package.json 内 pkg 字段与此等价）。
 *
 * 要点：
 *  - scripts: pkg 静态分析 require 链；显式列出 src 下所有 js。
 *  - assets: systray2 的 traybin 预编译二进制 + 图标 + web 静态资源必须打进 exe。
 *  - nativeModule.koffi='copydir': koffi 的 .node 原生模块随 exe 携带，运行时解包。
 *  - target: node18-win-x64（koffi prebuild 需匹配 Node ABI）。
 *
 * 已知坑：
 *  1. koffi .node 解包到 %TEMP%，Node ABI 必须与 target 一致；换大版本需同步换 target。
 *  2. systray2 spawn 的 tray_windows.exe 在 pkg 虚拟 fs 下需能被定位；assets 已含 traybin/**。
 *  3. child_process 调用 reg/powercfg 依赖系统 exe，pkg 下不受影响。
 */
module.exports = {
  scripts: ['src/**/*.js', 'test/**/*.js'],
  assets: [
    'res/tray-icon.b64',
    'assets/icon.ico',
    'node_modules/systray2/traybin/**/*',
    'src/web/static/**/*',
    'src/config/defaults.json',
  ],
  targets: ['node18-win-x64'],
  outputPath: 'dist',
  output: 'win-boost',
  nativeModule: {
    koffi: 'copydir',
  },
};
