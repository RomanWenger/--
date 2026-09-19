@echo off
rem Start backend (Flask, port 5000). Logs -> logs\backend.log
cd /d "%~dp0backend"
"C:\Users\33558\AppData\Local\Python\pythoncore-3.12-64\python.exe" app.py > "%~dp0logs\backend.log" 2>&1
