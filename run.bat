@echo off
REM Dev launcher — runs from source without building an exe.
setlocal
cd /d "%~dp0"
python backend\app.py
endlocal
