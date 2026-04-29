"""ClaudeCodeUI — portable Claude Code desktop UI (pywebview)."""
from __future__ import annotations
import base64
import json
import os
import sys
import tempfile
import threading
import traceback
from pathlib import Path

# Always redirect stdio to a log file when running without a console.
# pythonw and wscript-launched processes have broken stdout/stderr (objects
# exist but .write() raises or pywebview's .fileno() checks fail).
def _install_logging():
    logpath = Path.home() / ".claudecodeui.log"
    try:
        fh = open(logpath, "a", encoding="utf-8", buffering=1)
    except Exception:
        return
    # Detect whether stdout is usable. If we have a real console, keep it.
    try:
        if sys.stdout and sys.stdout.fileno() >= 0:
            return
    except Exception:
        pass
    sys.stdout = fh
    sys.stderr = fh
    print(f"--- ClaudeCodeUI start {__import__('datetime').datetime.now().isoformat()} ---", flush=True)

_install_logging()

# WebView2 needs a writable user-data folder. When launched from wscript the
# default location sometimes fails silently — set it explicitly.
os.environ.setdefault(
    "WEBVIEW2_USER_DATA_FOLDER",
    str(Path.home() / ".claudecodeui-webview2"),
)

try:
    import webview
except Exception:
    import traceback
    traceback.print_exc()
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, f"ClaudeCodeUI: webview import failed.\nSee {Path.home() / '.claudecodeui.log'}", "ClaudeCodeUI", 0x10)
    except Exception:
        pass
    sys.exit(1)

# Make backend imports work whether frozen or run from source.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from session_reader import list_projects, list_sessions, load_session, session_usage, delete_session, CLAUDE_PROJECTS
from session_meta import set_title as _set_title, set_pinned as _set_pinned
from claude_runner import ClaudeSession, find_claude_cli
from slash_commands import list_slash_commands
from version import __version__ as APP_VERSION

GITHUB_OWNER = "romanchernyaev"
GITHUB_REPO = "ClaudeCodeUI"
RELEASES_PAGE_URL = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
RELEASES_API_URL = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"


def _is_newer(remote: str, local: str) -> bool:
    """Semver-ish comparison. Accepts '0.1.0' or '0.1.0-rc.1'. Returns True if remote > local."""
    def parts(v: str) -> tuple[int, ...]:
        core = v.split("-", 1)[0]
        out: list[int] = []
        for p in core.split("."):
            try:
                out.append(int(p))
            except ValueError:
                out.append(0)
        return tuple(out)
    try:
        return parts(remote) > parts(local)
    except Exception:
        return False


def _frontend_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "frontend"  # type: ignore[attr-defined]
    return HERE.parent / "frontend"


# Module-level state. Kept OFF the Api class because pywebview v6 serializes
# every public attribute on the api object, and a Window reference triggers
# infinite recursion through .NET's Rectangle.Empty.Empty.Empty...
_window: webview.Window | None = None
_runners: dict[str, ClaudeSession] = {}   # tab_id -> runner
_images_tmpdir = Path(tempfile.gettempdir()) / "claudecodeui_images"
_images_tmpdir.mkdir(exist_ok=True)


def _cleanup_old_images(max_age_hours: int = 24):
    """Delete images older than max_age_hours from the temp dir.

    Runs once at startup. Best-effort — any file in use / permission-denied is
    simply skipped. Worst case the folder grows for a run; next startup will
    clear it.
    """
    import time
    try:
        if not _images_tmpdir.exists():
            return
        cutoff = time.time() - (max_age_hours * 3600)
        removed = 0
        for f in _images_tmpdir.iterdir():
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink()
                    removed += 1
            except OSError:
                pass
        if removed:
            print(f"cleaned {removed} stale image(s) from {_images_tmpdir}", flush=True)
    except Exception:
        pass


_cleanup_old_images()


def _push_event(tab_id: str, ev: dict):
    if _window is None:
        return
    try:
        ev2 = dict(ev); ev2["tab_id"] = tab_id
        payload = json.dumps(ev2, ensure_ascii=False)
        _window.evaluate_js(f"window.__onClaudeEvent({payload})")
    except Exception:
        pass


def _push_window_event(name: str):
    """Broadcast a tab-less event to the frontend (e.g. sessions list changed)."""
    if _window is None:
        return
    try:
        _window.evaluate_js(f"window.__onAppEvent && window.__onAppEvent({json.dumps(name)})")
    except Exception:
        pass


def _sessions_watcher(poll_seconds: float = 3.0):
    """Poll ~/.claude/projects/ for any mtime change; notify the UI when it sees one."""
    import time
    last_fingerprint: tuple | None = None
    while True:
        try:
            time.sleep(poll_seconds)
            if not CLAUDE_PROJECTS.exists():
                continue
            # Fingerprint = (project_dir mtime, count of .jsonl files per project, their mtimes)
            parts: list[tuple] = []
            for d in CLAUDE_PROJECTS.iterdir():
                if not d.is_dir():
                    continue
                try:
                    files = []
                    for f in d.iterdir():
                        if f.is_file() and f.suffix == ".jsonl":
                            try:
                                files.append((f.name, int(f.stat().st_mtime)))
                            except OSError:
                                pass
                    files.sort()
                    parts.append((d.name, tuple(files)))
                except OSError:
                    continue
            fp = tuple(parts)
            if last_fingerprint is not None and fp != last_fingerprint:
                _push_window_event("sessions_changed")
            last_fingerprint = fp
        except Exception:
            # Keep the thread alive across transient errors (disk churn, Dropbox lock, etc).
            pass


def _make_callback(tab_id: str):
    def _cb(ev: dict):
        _push_event(tab_id, ev)
    return _cb


class Api:
    """Exposed to JS. Only methods — no instance attributes (see module state above)."""

    def get_projects(self):
        return list_projects()

    def get_sessions(self, project_id: str):
        return list_sessions(project_id)

    def get_session(self, project_id: str, session_id: str):
        return {
            "messages": load_session(project_id, session_id),
            "usage": session_usage(project_id, session_id),
        }

    def get_slash_commands(self, cwd: str | None = None):
        return list_slash_commands(cwd)

    def get_status(self):
        return {
            "cli": find_claude_cli(),
            "home": str(Path.home()),
        }

    def start_conversation(self, tab_id: str, cwd: str | None = None, model: str | None = None,
                           effort: str | None = None, permission_mode: str | None = None):
        old = _runners.pop(tab_id, None)
        if old:
            old.interrupt()
        _runners[tab_id] = ClaudeSession(on_event=_make_callback(tab_id), cwd=cwd, model=model,
                                         effort=effort, permission_mode=permission_mode)
        return {"ok": True}

    def resume_conversation(self, tab_id: str, cwd: str, session_id: str, model: str | None = None,
                            effort: str | None = None, permission_mode: str | None = None):
        old = _runners.pop(tab_id, None)
        if old:
            old.interrupt()
        r = ClaudeSession(on_event=_make_callback(tab_id), cwd=cwd, model=model,
                          effort=effort, permission_mode=permission_mode)
        r.session_id = session_id
        _runners[tab_id] = r
        return {"ok": True, "session_id": session_id}

    def update_runner_settings(self, tab_id: str, model: str | None = None, effort: str | None = None,
                               permission_mode: str | None = None):
        r = _runners.get(tab_id)
        if r:
            if model is not None:
                r.model = model or None
            if effort is not None:
                r.effort = effort or None
            if permission_mode:
                r.permission_mode = permission_mode
        return {"ok": True}

    def send_message(self, tab_id: str, text: str, images_b64: list[str] | None = None):
        r = _runners.get(tab_id)
        if not r:
            r = ClaudeSession(on_event=_make_callback(tab_id))
            _runners[tab_id] = r
        image_paths = []
        for i, b in enumerate(images_b64 or []):
            try:
                header, data = b.split(",", 1) if "," in b else ("", b)
                ext = "png"
                if "image/jpeg" in header:
                    ext = "jpg"
                elif "image/gif" in header:
                    ext = "gif"
                elif "image/webp" in header:
                    ext = "webp"
                p = _images_tmpdir / f"paste_{os.getpid()}_{i}_{threading.get_ident()}.{ext}"
                p.write_bytes(base64.b64decode(data))
                image_paths.append(str(p))
            except Exception as e:
                _push_event(tab_id, {"type": "error", "message": f"image decode failed: {e}"})
        r.send(text, image_paths)
        return {"ok": True}

    def interrupt(self, tab_id: str):
        r = _runners.get(tab_id)
        if r:
            r.interrupt()
        return {"ok": True}

    def close_tab(self, tab_id: str):
        r = _runners.pop(tab_id, None)
        if r:
            r.interrupt()
        return {"ok": True}

    def delete_session(self, project_id: str, session_id: str):
        return delete_session(project_id, session_id)

    def rename_session(self, project_id: str, session_id: str, title: str):
        return _set_title(project_id, session_id, title)

    def pin_session(self, project_id: str, session_id: str, pinned: bool):
        return _set_pinned(project_id, session_id, pinned)

    def pick_directory(self):
        if _window is None:
            return None
        res = _window.create_file_dialog(webview.FOLDER_DIALOG)
        if res:
            return res[0] if isinstance(res, (list, tuple)) else res
        return None

    def save_markdown(self, default_filename: str, content: str):
        """Open a save dialog and write `content` as UTF-8 to the chosen file.

        Returns {'ok': bool, 'path': str|None, 'error': str|None}.
        """
        if _window is None:
            return {"ok": False, "path": None, "error": "window not ready"}
        try:
            safe_name = default_filename or "conversation.md"
            # Windows save_filename expects just the filename; directory handled by dialog
            res = _window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=safe_name,
                file_types=("Markdown (*.md)", "All files (*.*)"),
            )
            if not res:
                return {"ok": False, "path": None, "error": None}  # user cancelled
            path = res if isinstance(res, str) else res[0]
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
            return {"ok": True, "path": path, "error": None}
        except Exception as e:
            return {"ok": False, "path": None, "error": str(e)}

    def check_auth(self):
        """Return {'authenticated': bool, 'user': str|None, 'error': str|None}.

        `claude auth status` outputs JSON like {"loggedIn": true, "authMethod": "...", "apiProvider": "..."}.
        """
        cli = find_claude_cli()
        if not cli:
            return {"authenticated": False, "user": None, "error": "Claude CLI not found"}
        import subprocess, json as _json
        try:
            res = subprocess.run(
                [cli, "auth", "status"],
                capture_output=True, text=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            output = (res.stdout or "").strip() + ("\n" + res.stderr.strip() if res.stderr else "")
            authed = False
            user = None
            info = None
            try:
                parsed = _json.loads(res.stdout or "{}")
                authed = bool(parsed.get("loggedIn") or parsed.get("authenticated"))
                user = parsed.get("user") or parsed.get("account") or parsed.get("email")
                if authed:
                    method = parsed.get("authMethod") or ""
                    provider = parsed.get("apiProvider") or ""
                    info = " / ".join(x for x in (provider, method) if x)
            except Exception:
                # Fallback to text-search on older CLI
                low = output.lower()
                authed = res.returncode == 0 and any(s in low for s in ("logged in", "loggedin", "authenticated", "account"))
            return {
                "authenticated": authed,
                "user": user or info,
                "raw": output[:400],
                "error": None if authed else (output[:400] or "Not authenticated"),
            }
        except Exception as e:
            return {"authenticated": False, "user": None, "error": str(e)}

    def take_screenshot(self):
        """Hide the main window, let the user drag a selection, return {ok, data_url|error}.

        Runs on a worker thread so the webview loop isn't blocked. The Tk overlay
        itself runs on that worker thread (Tk supports being on a non-main thread
        as long as nothing else touches it).
        """
        import threading as _threading
        from screenshot import capture_region

        out: dict = {}
        done = _threading.Event()

        def _worker():
            try:
                # Give the window manager a moment to actually hide the pywebview window.
                import time as _time
                _time.sleep(0.25)
                data_url = capture_region()
                out["data_url"] = data_url
            except Exception as e:
                out["error"] = str(e)
            finally:
                done.set()

        try:
            if _window is not None:
                try:
                    _window.minimize()
                except Exception:
                    pass
            th = _threading.Thread(target=_worker, daemon=True)
            th.start()
            done.wait(timeout=120)  # user has 2 minutes max
            if _window is not None:
                try:
                    _window.restore()
                except Exception:
                    pass
            if "error" in out:
                return {"ok": False, "error": out["error"]}
            data_url = out.get("data_url")
            if not data_url:
                return {"ok": False, "cancelled": True}
            return {"ok": True, "data_url": data_url}
        except Exception as e:
            if _window is not None:
                try:
                    _window.restore()
                except Exception:
                    pass
            return {"ok": False, "error": str(e)}

    def launch_auth_login(self):
        """Open a visible terminal running `claude auth login` so the browser flow can happen."""
        cli = find_claude_cli()
        if not cli:
            return {"ok": False, "error": "Claude CLI not found"}
        import subprocess
        try:
            # `start "title" cmd /k ...` keeps the window open after auth completes so the user sees the result.
            subprocess.Popen(
                ["cmd", "/c", "start", "Claude Code — Login", "cmd", "/k", f'"{cli}" auth login'],
                shell=False,
                creationflags=subprocess.CREATE_NEW_CONSOLE if hasattr(subprocess, "CREATE_NEW_CONSOLE") else 0,
            )
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_version(self):
        return {"version": APP_VERSION}

    def check_updates(self):
        """Query GitHub for the latest release and compare with the baked-in version.

        Returns {current, latest, update_available, release_url, error}. Safe on network failure.
        """
        current = APP_VERSION
        result = {
            "current": current,
            "latest": None,
            "update_available": False,
            "release_url": RELEASES_PAGE_URL,
            "error": None,
        }
        if current == "dev":
            result["error"] = "Dev build — skip update check"
            return result
        try:
            import urllib.request
            req = urllib.request.Request(
                RELEASES_API_URL,
                headers={"Accept": "application/vnd.github+json", "User-Agent": f"ClaudeCodeUI/{current}"},
            )
            with urllib.request.urlopen(req, timeout=4) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            result["error"] = str(e)
            return result
        tag = (data.get("tag_name") or "").lstrip("v")
        result["latest"] = tag or None
        if tag and _is_newer(tag, current):
            result["update_available"] = True
            result["release_url"] = data.get("html_url") or RELEASES_PAGE_URL
        return result

    def open_external_url(self, url: str):
        """Open a URL in the user's default browser. Only http(s) allowed."""
        if not isinstance(url, str) or not (url.startswith("http://") or url.startswith("https://")):
            return {"ok": False, "error": "Invalid URL"}
        try:
            import webbrowser
            webbrowser.open(url, new=2)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


def main():
    global _window
    print("main() entered", flush=True)
    api = Api()
    idx = _frontend_dir() / "index.html"
    print(f"frontend index = {idx} (exists={idx.exists()})", flush=True)
    _window = webview.create_window(
        "Claude Code",
        url=str(idx),
        js_api=api,
        width=1280,
        height=820,
        min_size=(900, 600),
        background_color="#1a1a1a",
    )
    print("window created, calling webview.start(gui='edgechromium')", flush=True)
    threading.Thread(target=_sessions_watcher, daemon=True, name="SessionsWatcher").start()
    webview.start(gui="edgechromium", debug=False)
    print("webview.start returned", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        # Also show a popup so the user knows what happened when launched from the taskbar.
        try:
            import ctypes
            err = traceback.format_exc()[-800:]
            ctypes.windll.user32.MessageBoxW(0, f"ClaudeCodeUI crashed:\n\n{err}", "ClaudeCodeUI", 0x10)
        except Exception:
            pass
        sys.exit(1)
