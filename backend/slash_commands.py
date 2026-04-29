"""Collect available slash commands (built-in + user/project skills & commands)."""
from __future__ import annotations
from pathlib import Path

BUILTINS: list[dict] = [
    {"name": "/help", "description": "Show Claude Code help"},
    {"name": "/clear", "description": "Clear the current conversation"},
    {"name": "/compact", "description": "Compact conversation context"},
    {"name": "/model", "description": "Switch the Claude model"},
    {"name": "/init", "description": "Initialize a CLAUDE.md for this project"},
    {"name": "/review", "description": "Review pending changes"},
    {"name": "/login", "description": "Log in / switch account"},
    {"name": "/logout", "description": "Log out"},
    {"name": "/status", "description": "Show status information"},
    {"name": "/cost", "description": "Show session cost so far"},
    {"name": "/resume", "description": "Resume a previous conversation"},
    {"name": "/fast", "description": "Toggle Fast mode (Opus 4.6)"},
]


def _scan_dir(base: Path, kind: str) -> list[dict]:
    out = []
    if not base.exists():
        return out
    for f in base.rglob("*.md"):
        try:
            rel = f.relative_to(base).with_suffix("")
        except Exception:
            continue
        name = "/" + str(rel).replace("\\", ":")
        desc = _extract_description(f)
        out.append({"name": name, "description": desc or f"({kind})", "source": kind})
    return out


def _extract_description(path: Path) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(2000)
    except Exception:
        return None
    if head.startswith("---"):
        end = head.find("\n---", 3)
        if end != -1:
            fm = head[3:end]
            for line in fm.splitlines():
                line = line.strip()
                if line.lower().startswith("description:"):
                    return line.split(":", 1)[1].strip().strip('"').strip("'")
    for line in head.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("---"):
            return line[:120]
    return None


def list_slash_commands(cwd: str | None = None) -> list[dict]:
    items = list(BUILTINS)
    user_cmds = Path.home() / ".claude" / "commands"
    items += _scan_dir(user_cmds, "user")
    user_skills = Path.home() / ".claude" / "skills"
    if user_skills.exists():
        for sk in user_skills.iterdir():
            if sk.is_dir() and (sk / "SKILL.md").exists():
                desc = _extract_description(sk / "SKILL.md")
                items.append({"name": f"/{sk.name}", "description": desc or "(skill)", "source": "skill"})
    if cwd:
        proj_cmds = Path(cwd) / ".claude" / "commands"
        items += _scan_dir(proj_cmds, "project")
    seen = set()
    dedup = []
    for it in items:
        if it["name"] in seen:
            continue
        seen.add(it["name"])
        dedup.append(it)
    dedup.sort(key=lambda x: x["name"])
    return dedup
