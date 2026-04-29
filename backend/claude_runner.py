"""Spawns the claude CLI and streams JSON events to a callback."""
from __future__ import annotations
import json
import os
import subprocess
import threading
import queue
import shutil
from pathlib import Path


def find_claude_cli() -> str | None:
    # Prefer the known install location.
    for cand in [
        Path.home() / ".local" / "bin" / "claude.exe",
        Path.home() / ".local" / "bin" / "claude.cmd",
        Path.home() / ".local" / "bin" / "claude",
    ]:
        if cand.exists():
            return str(cand)
    return shutil.which("claude") or shutil.which("claude.exe")


class ClaudeSession:
    """One-shot invocation of `claude --print` with streaming JSON output.

    We use `--print` + `--output-format stream-json` for each user turn, and
    chain turns with `--resume <session_id>` so the conversation continues.
    """

    def __init__(self, on_event, cwd: str | None = None, model: str | None = None,
                 effort: str | None = None, permission_mode: str | None = None):
        self.on_event = on_event
        self.cwd = cwd or str(Path.home())
        self.model = model
        self.effort = effort
        self.permission_mode = permission_mode or "bypassPermissions"
        self.session_id: str | None = None
        self.proc: subprocess.Popen | None = None
        self._stop = threading.Event()
        self._q: queue.Queue = queue.Queue()
        self.cli = find_claude_cli()

    def send(self, prompt: str, images: list[str] | None = None):
        """Start a new turn. Kills any currently running turn."""
        self.interrupt()
        self._stop.clear()
        t = threading.Thread(target=self._run_turn, args=(prompt, images or []), daemon=True)
        t.start()

    def interrupt(self):
        self._stop.set()
        p = self.proc
        if p and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self.proc = None

    def _run_turn(self, prompt: str, images: list[str]):
        if not self.cli:
            self.on_event({"type": "error", "message": "claude CLI not found. Expected at ~/.local/bin/claude.exe"})
            self.on_event({"type": "done"})
            return

        # Build the prompt. If images were attached we reference them as file paths on a new line.
        full_prompt = prompt
        if images:
            refs = "\n".join(f"[image: {p}]" for p in images)
            full_prompt = f"{prompt}\n\n{refs}"

        args = [self.cli, "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        if self.session_id:
            args += ["--resume", self.session_id]
        if self.model:
            args += ["--model", self.model]
        if self.effort:
            args += ["--effort", self.effort]
        args += ["--permission-mode", self.permission_mode]
        args += [full_prompt]

        try:
            self.proc = subprocess.Popen(
                args,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as e:
            self.on_event({"type": "error", "message": f"Failed to start claude: {e}"})
            self.on_event({"type": "done"})
            return

        err_buf: list[str] = []
        err_thread = threading.Thread(target=self._drain_stderr, args=(self.proc, err_buf), daemon=True)
        err_thread.start()

        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            if self._stop.is_set():
                break
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            self._handle_event(obj)

        rc = self.proc.wait() if self.proc else -1
        if rc not in (0, None) and not self._stop.is_set():
            msg = "".join(err_buf).strip() or f"claude exited with code {rc}"
            self.on_event({"type": "error", "message": msg})
        self.on_event({"type": "done"})

    def _drain_stderr(self, proc, buf: list[str]):
        try:
            for line in proc.stderr:
                buf.append(line)
        except Exception:
            pass

    def _handle_event(self, obj: dict):
        t = obj.get("type")
        # The stream-json format wraps SDK messages. Normalize to simpler events for the UI.
        if t == "system" and obj.get("subtype") == "init":
            sid = obj.get("session_id")
            if sid:
                self.session_id = sid
            self.on_event({"type": "session", "session_id": self.session_id})
            return
        if t == "assistant":
            msg = obj.get("message", {})
            for b in msg.get("content", []):
                bt = b.get("type")
                if bt == "text":
                    self.on_event({"type": "text", "text": b.get("text", "")})
                elif bt == "tool_use":
                    self.on_event({"type": "tool_use", "name": b.get("name"), "input": b.get("input")})
                elif bt == "thinking":
                    self.on_event({"type": "thinking", "text": b.get("thinking", "")})
            usage = msg.get("usage")
            if usage:
                self.on_event({"type": "usage", "usage": usage})
            return
        if t == "stream_event":
            ev = obj.get("event", {})
            et = ev.get("type")
            if et == "content_block_delta":
                d = ev.get("delta", {})
                if d.get("type") == "text_delta":
                    self.on_event({"type": "text_delta", "text": d.get("text", "")})
                elif d.get("type") == "thinking_delta":
                    self.on_event({"type": "thinking_delta", "text": d.get("thinking", "")})
            elif et == "content_block_start":
                cb = ev.get("content_block", {})
                if cb.get("type") == "thinking":
                    self.on_event({"type": "thinking_start"})
                elif cb.get("type") == "text":
                    self.on_event({"type": "text_start"})
            return
        if t == "user":
            msg = obj.get("message", {})
            for b in msg.get("content", []) if isinstance(msg.get("content"), list) else []:
                if b.get("type") == "tool_result":
                    content = b.get("content")
                    if isinstance(content, list):
                        text = "\n".join(c.get("text", "") for c in content if c.get("type") == "text")
                    else:
                        text = str(content)
                    self.on_event({"type": "tool_result", "text": text})
            return
        if t == "result":
            self.on_event({"type": "result", "usage": obj.get("usage"), "total_cost_usd": obj.get("total_cost_usd")})
            return
