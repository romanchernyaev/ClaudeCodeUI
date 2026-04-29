"""Reads Claude Code session history from ~/.claude/projects/*.jsonl."""
from __future__ import annotations
import json
import os
from pathlib import Path
from datetime import datetime

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def _project_dir_to_cwd(name: str) -> str:
    # Claude encodes cwd by replacing separators with '-'. Windows: 'C--Users-foo' -> 'C:\\Users\\foo'
    if len(name) >= 2 and name[1] == "-" and name[0].isalpha():
        return name[0] + ":\\" + name[2:].replace("-", "\\").lstrip("\\")
    return name.replace("-", "/")


def list_projects() -> list[dict]:
    if not CLAUDE_PROJECTS.exists():
        return []
    out = []
    for d in CLAUDE_PROJECTS.iterdir():
        if not d.is_dir():
            continue
        sessions = list(d.glob("*.jsonl"))
        if not sessions:
            continue
        latest = max(sessions, key=lambda p: p.stat().st_mtime)
        out.append({
            "id": d.name,
            "cwd": _project_dir_to_cwd(d.name),
            "session_count": len(sessions),
            "last_modified": latest.stat().st_mtime,
        })
    out.sort(key=lambda x: x["last_modified"], reverse=True)
    return out


def list_sessions(project_id: str, limit: int = 100) -> list[dict]:
    pdir = CLAUDE_PROJECTS / project_id
    if not pdir.exists():
        return []
    from session_meta import all_meta
    overrides = all_meta(project_id)
    files = sorted(pdir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    out = []
    for f in files:
        meta = _peek_session(f)
        ov = overrides.get(f.stem, {})
        title = ov.get("title") or meta.get("title") or "(untitled)"
        out.append({
            "id": f.stem,
            "project_id": project_id,
            "path": str(f),
            "title": title,
            "first_message": meta.get("first_user"),
            "last_modified": f.stat().st_mtime,
            "size": f.stat().st_size,
            "pinned": bool(ov.get("pinned")),
            "custom_title": bool(ov.get("title")),
        })
    # Pinned first, preserving last-modified order within each group.
    out.sort(key=lambda x: (not x["pinned"], -x["last_modified"]))
    return out


def _peek_session(path: Path) -> dict:
    title = None
    first_user = None
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            for i, line in enumerate(fh):
                if i > 80:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("type") == "ai-title" and not title:
                    title = obj.get("title") or obj.get("content")
                if obj.get("type") == "user" and not first_user:
                    content = obj.get("message", {}).get("content")
                    txt = _extract_text(content)
                    if txt and not txt.startswith("<") and not txt.startswith("Caveat"):
                        first_user = txt[:140]
                if title and first_user:
                    break
    except Exception:
        pass
    if not title and first_user:
        title = first_user[:80]
    return {"title": title, "first_user": first_user}


def _extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    parts.append(b.get("text", ""))
                elif b.get("type") == "image":
                    parts.append("[image]")
        return "\n".join(parts)
    return ""


def load_session(project_id: str, session_id: str) -> list[dict]:
    """Return a cleaned list of renderable messages from a session JSONL."""
    path = CLAUDE_PROJECTS / project_id / f"{session_id}.jsonl"
    if not path.exists():
        return []
    msgs = []
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            t = obj.get("type")
            if t == "user":
                content = obj.get("message", {}).get("content")
                text = _extract_text(content)
                if not text:
                    continue
                if text.startswith("<local-command-") or text.startswith("<command-") or "Caveat:" in text[:40]:
                    continue
                msgs.append({
                    "role": "user",
                    "text": text,
                    "ts": obj.get("timestamp"),
                    "has_image": _has_image(content),
                })
            elif t == "assistant":
                content = obj.get("message", {}).get("content")
                text_parts = []
                tool_calls = []
                if isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        bt = b.get("type")
                        if bt == "text":
                            text_parts.append(b.get("text", ""))
                        elif bt == "tool_use":
                            tool_calls.append({"name": b.get("name"), "input": b.get("input")})
                        elif bt == "thinking":
                            pass
                text = "\n".join(p for p in text_parts if p)
                if text or tool_calls:
                    msgs.append({
                        "role": "assistant",
                        "text": text,
                        "tools": tool_calls,
                        "ts": obj.get("timestamp"),
                        "usage": obj.get("message", {}).get("usage"),
                    })
    return msgs


def delete_session(project_id: str, session_id: str) -> dict:
    """Delete a session's JSONL file and its associated tool-results directory."""
    pdir = CLAUDE_PROJECTS / project_id
    jsonl = pdir / f"{session_id}.jsonl"
    sdir = pdir / session_id  # some sessions have a sibling directory for tool-results
    errors = []
    removed = []
    if jsonl.exists():
        try:
            jsonl.unlink()
            removed.append(str(jsonl))
        except Exception as e:
            errors.append(f"jsonl: {e}")
    if sdir.exists() and sdir.is_dir():
        import shutil
        try:
            shutil.rmtree(sdir)
            removed.append(str(sdir))
        except Exception as e:
            errors.append(f"dir: {e}")
    # Also purge any overrides for this session.
    try:
        from session_meta import remove as _remove_meta
        _remove_meta(project_id, session_id)
    except Exception:
        pass
    return {"removed": removed, "errors": errors}


def _has_image(content) -> bool:
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "image":
                return True
    return False


def session_usage(project_id: str, session_id: str) -> dict:
    """Estimate context tokens used from the last assistant usage block."""
    path = CLAUDE_PROJECTS / project_id / f"{session_id}.jsonl"
    if not path.exists():
        return {"input_tokens": 0, "output_tokens": 0, "total": 0}
    last_usage = None
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") == "assistant":
                u = obj.get("message", {}).get("usage")
                if u:
                    last_usage = u
    if not last_usage:
        return {"input_tokens": 0, "output_tokens": 0, "total": 0}
    it = last_usage.get("input_tokens", 0) or 0
    cc = last_usage.get("cache_creation_input_tokens", 0) or 0
    cr = last_usage.get("cache_read_input_tokens", 0) or 0
    ot = last_usage.get("output_tokens", 0) or 0
    return {
        "input_tokens": it + cc + cr,
        "output_tokens": ot,
        "total": it + cc + cr + ot,
    }
