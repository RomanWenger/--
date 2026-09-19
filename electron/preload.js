const { contextBridge } = require('electron')

// 预加载脚本：向渲染进程暴露最小接口
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true
})
