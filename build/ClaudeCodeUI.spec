# PyInstaller spec — builds a single portable ClaudeCodeUI.exe (onefile mode).
# Run from project root with:
#   pyinstaller build\ClaudeCodeUI.spec --noconfirm
from pathlib import Path

block_cipher = None

root = Path.cwd()
backend = root / "backend"
frontend = root / "frontend"

a = Analysis(
    [str(backend / "app.py")],
    pathex=[str(backend)],
    binaries=[],
    datas=[(str(frontend), "frontend")],
    hiddenimports=[
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "clr_loader",
        "session_reader",
        "session_meta",
        "claude_runner",
        "slash_commands",
        "screenshot",
        "version",
        "file_attachments",
        "PIL.ImageGrab",
        "tkinter",
        # Office / PDF attachment converters. openpyxl and python-docx use
        # lazy imports so PyInstaller's static analyzer misses pieces in onefile mode.
        "openpyxl",
        "openpyxl.workbook",
        "openpyxl.reader.excel",
        "docx",
        "docx.oxml",
        "pypdf",
        "odf",
        "odf.opendocument",
        "odf.text",
        "odf.table",
        "odf.teletype",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="ClaudeCodeUI",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,            # windowed app
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(frontend / "icon.ico"),
)
