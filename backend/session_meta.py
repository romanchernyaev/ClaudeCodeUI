"""Per-session metadata (rename, pin) stored alongside Claude's JSONL files.

We never modify Claude's own files. Overrides live in:
    ~/.claude/projects/<project_id>/.claudecodeui-meta.json
"""
from __future__ import annotations
import json
from pathlib import Path

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
META_NAME = ".claudecodeui-meta.json"


def _meta_path(project_id: str) -> Path:
    return CLAUDE_PROJECTS / project_id / META_NAME


def _load(project_id: str) -> dict:
    p = _meta_path(project_id)
    if not p.exists():
        return {}
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def _save(project_id: str, data: dict) -> None:
    p = _meta_path(project_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except Exception:
        pass


def get_meta(project_id: str, session_id: str) -> dict:
    return _load(project_id).get(session_id, {})


def all_meta(project_id: str) -> dict:
    return _load(project_id)


def set_title(project_id: str, session_id: str, title: str) -> dict:
    data = _load(project_id)
    entry = data.setdefault(session_id, {})
    if title:
        entry["title"] = title.strip()[:200]
    else:
        entry.pop("title", None)
    _save(project_id, data)
    return entry


def set_pinned(project_id: str, session_id: str, pinned: bool) -> dict:
    data = _load(project_id)
    entry = data.setdefault(session_id, {})
    if pinned:
        entry["pinned"] = True
    else:
        entry.pop("pinned", None)
    if not entry:
        data.pop(session_id, None)
    _save(project_id, data)
    return entry


def remove(project_id: str, session_id: str) -> None:
    data = _load(project_id)
    if session_id in data:
        data.pop(session_id, None)
        _save(project_id, data)
