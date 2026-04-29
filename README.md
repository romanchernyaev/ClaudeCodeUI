# ClaudeCodeUI

Portable Claude Code desktop UI for Windows — no admin, no Electron.

## Download

Latest build: **[ClaudeCodeUI.zip](https://github.com/romanchernyaev/ClaudeCodeUI/releases/latest/download/ClaudeCodeUI.zip)**

Unzip, double-click `ClaudeCodeUI.exe`. Prerequisites:
- Windows 10/11 (WebView2 Runtime is already installed)
- `claude` CLI on PATH (or at `~/.local/bin/claude.exe`)
- Logged in once with `claude auth login`

## What it is

A lightweight (~36 MB) desktop app that talks to the existing `claude` CLI so you get:
- Chat with streaming output (no more VS Code "Unhandled case: [object Object]" interruptions)
- Sidebar with every past session from `~/.claude/projects/`, click to resume
- Context-used meter (tokens / 200k)
- Paste or drag-drop images into the composer
- Slash-command autocomplete (built-ins + your `~/.claude/commands/` + `~/.claude/skills/`)
- Model picker, working-directory picker, interrupt button

Runs as a single Windows webview window (Edge WebView2, already on Win 11).

## Run from source

```
run.bat
```

Dependencies: Python 3.12, `pywebview` (`pip install --user pywebview`).

## Build portable .exe locally

```
build.bat
```

Output: `dist\ClaudeCodeUI.exe` — single self-contained file.

## Release (maintainer)

Push a tag to publish a new release automatically:

```
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions runs `build.bat` on a Windows runner and uploads `ClaudeCodeUI.exe` + `ClaudeCodeUI.zip` to the release.

## How it works

- `backend/app.py` — pywebview host + JS↔Python API bridge
- `backend/claude_runner.py` — spawns `claude --print --output-format stream-json --include-partial-messages`, chains turns with `--resume <sid>` so conversations persist
- `backend/session_reader.py` — parses `~/.claude/projects/*/*.jsonl` for the sidebar + meter
- `backend/slash_commands.py` — discovers slash commands from built-ins, `~/.claude/commands/`, `~/.claude/skills/`, and `<cwd>/.claude/commands/`
- `frontend/` — HTML/CSS/JS; Claude Desktop-ish dark theme

## Known scope (MVP v1)

Included: chat/streaming/history/context-meter/images/slash-autocomplete/interrupt/model-picker/cwd-picker.
Not included yet (ask if you want any of these): MCP config UI, hook editor, slash-command argument preview, token cost breakdown, multiple windows, settings pane.
