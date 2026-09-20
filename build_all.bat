@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   吉隆口岸泥石流救援仿真系统 · 一键打包
echo   （前端构建 -^> 后端 PyInstaller -^> Electron 安装包）
echo ============================================================
echo.

set "STEP=0"
set "PY=%~dp0.venv-cpu\Scripts\python.exe"

rem ---------- 环境检查 ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node，请先安装 Node.js 并加入 PATH。
  goto :fail
)
if not exist "%PY%" (
  echo [错误] 找不到打包用 Python 环境：
  echo        %PY%
  echo        请确认项目根目录存在 .venv-cpu（内含 PyInstaller 与 torch）。
  goto :fail
)
if not exist "%~dp0frontend\node_modules" (
  echo [错误] 缺少 frontend\node_modules，请先在 frontend 目录执行 npm install。
  goto :fail
)
if not exist "%~dp0electron\node_modules" (
  echo [错误] 缺少 electron\node_modules，请先在 electron 目录执行 npm install。
  goto :fail
)

tasklist /FI "IMAGENAME eq 吉隆口岸泥石流救援仿真系统.exe" 2>nul | findstr /i /c:"吉隆口岸" >nul
if not errorlevel 1 (
  echo [错误] 检测到已安装的版本正在运行，请先退出该程序，
  echo        否则 release-final 里的文件被占用会导致打包失败。
  goto :fail
)

rem ---------- 1/3 前端构建 ----------
set /a STEP+=1
echo [%STEP%/3] 构建前端（vite build）...
pushd "%~dp0frontend"
call npm run build
if errorlevel 1 (
  popd
  echo [错误] 前端构建失败。
  goto :fail
)
popd
echo        完成 -^> frontend\dist
echo.

rem ---------- 2/3 后端打包 ----------
set /a STEP+=1
echo [%STEP%/3] 打包后端（PyInstaller，约 5~15 分钟，请耐心等待）...
pushd "%~dp0backend"
"%PY%" -m PyInstaller launcher.spec --noconfirm
if errorlevel 1 (
  popd
  echo [错误] 后端打包失败。
  goto :fail
)
popd
echo        完成 -^> backend\dist\launcher
echo.

rem ---------- 3/3 安装包 ----------
set /a STEP+=1
echo [%STEP%/3] 制作安装包（electron-builder）...
pushd "%~dp0electron"
call npm run dist
if errorlevel 1 (
  popd
  echo [错误] 安装包制作失败。
  goto :fail
)
popd

echo.
echo ============================================================
echo   全部完成！
echo   安装包：%~dp0release-final\吉隆口岸泥石流救援仿真系统-Setup-1.0.0.exe
echo ============================================================
echo 提示：
echo   - 语音走小米 MiMo 云端接口，安装后需要联网。
echo   - 首次启动后端要等约 40 秒，窗口会自动等待。
echo   - 运行本脚本前建议先停掉开发用的前后端（避免端口 5000 被占用）。
pause
exit /b 0

:fail
echo.
echo 打包中断（第 %STEP% 步失败）。修复上面的报错后可重新运行本脚本。
pause
exit /b 1
