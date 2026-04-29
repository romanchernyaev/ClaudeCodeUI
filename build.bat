@echo off
REM Build portable ClaudeCodeUI.exe — no admin required.
REM Output: .\dist\ClaudeCodeUI.exe (single self-contained file).
setlocal
cd /d "%~dp0"

where pyinstaller >nul 2>&1
if errorlevel 1 (
  echo [!] pyinstaller not found — installing for current user...
  python -m pip install --user pyinstaller pywebview || exit /b 1
)

pyinstaller build\ClaudeCodeUI.spec --noconfirm --clean
if errorlevel 1 (
  echo [x] Build failed.
  exit /b 1
)

echo.
echo [ok] Built dist\ClaudeCodeUI.exe  (single file, ~36 MB)
echo     Send just this one .exe to anyone with the Claude CLI installed — no other files needed.
endlocal
