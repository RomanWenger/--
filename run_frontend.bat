@echo off
rem Start frontend (Vite, port 3000). Logs -> logs\frontend.log
cd /d "%~dp0frontend"
"D:\npm.cmd" run dev -- --host 0.0.0.0 --port 3000 > "%~dp0logs\frontend.log" 2>&1
