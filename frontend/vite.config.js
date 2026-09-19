import { defineConfig } from 'vite'

export default defineConfig({
  // 打包后使用相对路径，支持 file:// 协议加载（Electron/直接打开）
  base: './',
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
})
