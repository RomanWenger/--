const { app, BrowserWindow, shell, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')

let flaskProcess = null
let mainWindow = null

const isPackaged = app.isPackaged
const FLASK_PORT = 5000

// 等待 Flask 就绪
function waitForFlask(maxRetries = 180) {
  return new Promise((resolve, reject) => {
    let retries = 0
    const check = () => {
      const req = http.get(`http://127.0.0.1:${FLASK_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else {
          retry()
        }
        res.resume()
      })
      req.on('error', () => retry())
      req.setTimeout(2000, () => { req.destroy(); retry() })
    }
    const retry = () => {
      retries++
      if (retries >= maxRetries) {
        reject(new Error('Flask 启动超时（20 秒）'))
      } else {
        setTimeout(check, 500)
      }
    }
    check()
  })
}

// 启动 Flask 后端
function startFlask() {
  if (isPackaged) {
    const launcherPath = path.join(process.resourcesPath, 'launcher', 'launcher.exe')
    if (fs.existsSync(launcherPath)) {
      flaskProcess = spawn(launcherPath, [], {
        cwd: path.dirname(launcherPath),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true
      })
    } else {
      console.error('找不到 launcher.exe:', launcherPath)
    }
  } else {
    const backendDir = path.join(__dirname, '..', 'backend')
    const scriptPath = path.join(backendDir, 'app.py')
    flaskProcess = spawn('python', [scriptPath], {
      cwd: backendDir,
      env: {
        ...process.env,
        PYTHONPATH: backendDir,
        PYTHONUNBUFFERED: '1'
      },
      windowsHide: true
    })
  }

  if (flaskProcess) {
    flaskProcess.stdout.on('data', (data) => {
      console.log(`[Flask] ${data.toString().trim()}`)
    })
    flaskProcess.stderr.on('data', (data) => {
      console.error(`[Flask] ${data.toString().trim()}`)
    })
    flaskProcess.on('error', (error) => {
      console.error('Flask 进程启动失败:', error)
    })
    flaskProcess.on('exit', (code) => {
      console.log(`Flask 进程退出，代码: ${code}`)
    })
  }
}

// 创建 Electron 窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: '吉隆口岸泥石流救援仿真系统',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true
    }
  })

  if (isPackaged) {
    const frontendDir = path.join(process.resourcesPath, 'frontend-dist')
    mainWindow.loadFile(path.join(frontendDir, 'index.html'))
    // 打包后也打开 DevTools 便于调试，稳定后可注释掉
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    const distPath = path.join(__dirname, '..', 'frontend', 'dist', 'index.html')
    if (fs.existsSync(distPath)) {
      mainWindow.loadFile(distPath)
    } else {
      mainWindow.loadURL('http://localhost:3000/')
    }
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  startFlask()

  try {
    await waitForFlask()
    console.log('Flask 就绪，启动窗口')
    createWindow()
  } catch (error) {
    console.error('Flask 启动失败:', error.message)
    dialog.showErrorBox(
      '系统启动失败',
      '后端服务未能启动。请检查 launcher.exe 和端口 5000。\n\n' + error.message
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (flaskProcess) {
    flaskProcess.kill()
    flaskProcess = null
  }
  app.quit()
})

app.on('before-quit', () => {
  if (flaskProcess) {
    flaskProcess.kill()
    flaskProcess = null
  }
})
