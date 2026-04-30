@echo off
REM Build a timestamped ClaudeCodeUI_test_YYYYMMDD-HHMMSS.exe into dist\test-builds\.
REM Lets you keep a running exe open while producing new ones for comparison.
REM All outputs in dist\test-builds\ are disposable — wipe the folder before pushing.
setlocal
cd /d "%~dp0"

where pyinstaller >nul 2>&1
if errorlevel 1 (
  echo [!] pyinstaller not found — installing for current user...
  python -m pip install --user pyinstaller pywebview || exit /b 1
)

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set STAMP=%%I
set OUTDIR=dist\test-builds
set OUTNAME=ClaudeCodeUI_test_%STAMP%.exe

if not exist "%OUTDIR%" mkdir "%OUTDIR%"

pyinstaller build\ClaudeCodeUI.spec --noconfirm --clean ^
  --distpath "%OUTDIR%" ^
  --workpath "build-workpath\test-%STAMP%"
if errorlevel 1 (
  echo [x] Build failed.
  exit /b 1
)

move /y "%OUTDIR%\ClaudeCodeUI.exe" "%OUTDIR%\%OUTNAME%" >nul
if errorlevel 1 (
  echo [x] Rename failed.
  exit /b 1
)

echo.
echo [ok] Built %OUTDIR%\%OUTNAME%
endlocal
