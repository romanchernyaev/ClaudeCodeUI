@echo off
cd /d "%~dp0"
set PY=%USERPROFILE%\AppData\Local\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python.exe
"%PY%" "%~dp0backend\app.py" >> "%USERPROFILE%\.claudecodeui.log" 2>&1
