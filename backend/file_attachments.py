"""Decode composer attachments to temp files and, for Office/ODF formats,
convert them to plain-text companions so Claude's Read tool can parse them.

Two-tier strategy:
  1. Text-like (.txt, .md, .csv, .json, .log, .sql, source) → write bytes as-is.
  2. Office / ODF / PDF → write original + write sibling .md/.txt with extracted content.

The runner references the *converted* path so Read picks it up without
binary-garbage output. The original stays alongside so the user can still
refer to it if they pull it up themselves.
"""
from __future__ import annotations
import base64
import os
import tempfile
import threading
from pathlib import Path


_tmpdir = Path(tempfile.gettempdir()) / "claudecodeui_files"
_tmpdir.mkdir(exist_ok=True)


def tmpdir() -> Path:
    return _tmpdir


def cleanup_old_files(max_age_hours: int = 24):
    import time
    try:
        if not _tmpdir.exists():
            return
        cutoff = time.time() - (max_age_hours * 3600)
        for f in _tmpdir.iterdir():
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass
    except Exception:
        pass


# Extensions we treat as "already plain text" — Claude's Read tool reads them fine.
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".rst", ".log",
    ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".html", ".htm", ".css", ".scss",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
    ".java", ".kt", ".scala", ".go", ".rs", ".rb", ".php", ".lua",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
    ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
    ".sql", ".graphql", ".proto",
    ".env", ".gitignore", ".dockerfile",
}

# Extensions we try to convert to text.
OFFICE_EXTS = {".xlsx", ".xlsm", ".xls", ".docx", ".odt", ".ods", ".pdf"}


def _safe_name(name: str) -> str:
    """Drop directory separators and collapse whitespace."""
    n = os.path.basename(name or "attachment")
    return "".join(c if c.isalnum() or c in "-_.() " else "_" for c in n).strip() or "attachment"


def _unique_path(name: str) -> Path:
    """Produce a unique path under _tmpdir, preserving the original extension."""
    safe = _safe_name(name)
    stem, ext = os.path.splitext(safe)
    pid = os.getpid()
    tid = threading.get_ident()
    base = f"{stem}_{pid}_{tid}"
    p = _tmpdir / f"{base}{ext}"
    i = 0
    while p.exists():
        i += 1
        p = _tmpdir / f"{base}_{i}{ext}"
    return p


def _decode_dataurl(b: str) -> bytes:
    """Accept 'data:<mime>;base64,<payload>' or raw base64."""
    if "," in b:
        _, data = b.split(",", 1)
    else:
        data = b
    return base64.b64decode(data)


def _xlsx_to_markdown(path: Path) -> str:
    """All sheets → one markdown doc with per-sheet headings + pipe tables.

    Caps at 100 rows × 50 cols per sheet to keep the prompt bounded; a note
    is appended when we truncate.
    """
    from openpyxl import load_workbook
    wb = load_workbook(str(path), data_only=True, read_only=True)
    out: list[str] = []
    MAX_ROWS, MAX_COLS = 100, 50
    for sheet in wb.sheetnames:
        ws = wb[sheet]
        out.append(f"## Sheet: {sheet}")
        rows_out: list[list[str]] = []
        truncated = False
        for r, row in enumerate(ws.iter_rows(values_only=True)):
            if r >= MAX_ROWS:
                truncated = True
                break
            cells = [("" if v is None else str(v)).replace("|", "\\|").replace("\n", " ") for v in row[:MAX_COLS]]
            if len(row) > MAX_COLS:
                cells.append("…")
                truncated = True
            rows_out.append(cells)
        if not rows_out:
            out.append("_(empty)_\n")
            continue
        width = max(len(r) for r in rows_out)
        for r in rows_out:
            while len(r) < width:
                r.append("")
        header = rows_out[0]
        out.append("| " + " | ".join(header) + " |")
        out.append("| " + " | ".join(["---"] * width) + " |")
        for r in rows_out[1:]:
            out.append("| " + " | ".join(r) + " |")
        if truncated:
            out.append(f"\n_(truncated — full file: {path.name}, max {MAX_ROWS} rows × {MAX_COLS} cols shown)_")
        out.append("")
    wb.close()
    return "\n".join(out)


def _docx_to_markdown(path: Path) -> str:
    """Paragraphs + headings + simple tables. Lists become `- ` items."""
    from docx import Document
    doc = Document(str(path))
    out: list[str] = []
    for para in doc.paragraphs:
        text = (para.text or "").strip()
        if not text:
            out.append("")
            continue
        style = (para.style.name or "").lower() if para.style else ""
        if style.startswith("heading"):
            level = 1
            for ch in style:
                if ch.isdigit():
                    level = int(ch)
                    break
            out.append(f"{'#' * min(level, 6)} {text}")
        elif "list" in style or "bullet" in style:
            out.append(f"- {text}")
        else:
            out.append(text)
    for i, table in enumerate(doc.tables):
        out.append("")
        out.append(f"### Table {i + 1}")
        rows = [[(cell.text or "").replace("|", "\\|").replace("\n", " ").strip() for cell in row.cells]
                for row in table.rows]
        if not rows:
            continue
        width = max(len(r) for r in rows)
        for r in rows:
            while len(r) < width:
                r.append("")
        out.append("| " + " | ".join(rows[0]) + " |")
        out.append("| " + " | ".join(["---"] * width) + " |")
        for r in rows[1:]:
            out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def _odt_to_markdown(path: Path) -> str:
    """ODF text / spreadsheet / presentation → plain paragraphs."""
    from odf.opendocument import load
    from odf import text as odf_text, table as odf_table, teletype
    doc = load(str(path))
    out: list[str] = []
    for node in doc.getElementsByType(odf_text.H):
        level = int(node.getAttribute("outlinelevel") or 1)
        out.append(f"{'#' * min(level, 6)} {teletype.extractText(node)}")
    for node in doc.getElementsByType(odf_text.P):
        t = teletype.extractText(node).strip()
        if t:
            out.append(t)
    for tbl in doc.getElementsByType(odf_table.Table):
        out.append("")
        for row in tbl.getElementsByType(odf_table.TableRow):
            cells = [teletype.extractText(c).strip() for c in row.getElementsByType(odf_table.TableCell)]
            if any(cells):
                out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)


def _pdf_to_text(path: Path) -> str:
    from pypdf import PdfReader
    r = PdfReader(str(path))
    out: list[str] = []
    for i, page in enumerate(r.pages):
        try:
            text = page.extract_text() or ""
        except Exception as e:
            text = f"(page {i + 1} extract failed: {e})"
        out.append(f"--- Page {i + 1} ---")
        out.append(text.strip())
        out.append("")
    return "\n".join(out)


def convert_office(path: Path) -> tuple[Path, str] | None:
    """Produce a sibling plain-text file. Returns (txt_path, kind) or None if unsupported."""
    ext = path.suffix.lower()
    try:
        if ext in (".xlsx", ".xlsm", ".ods"):
            content = _xlsx_to_markdown(path) if ext != ".ods" else _odt_to_markdown(path)
            kind = "spreadsheet"
            out_ext = ".md"
        elif ext == ".docx":
            content = _docx_to_markdown(path)
            kind = "document"
            out_ext = ".md"
        elif ext == ".odt":
            content = _odt_to_markdown(path)
            kind = "document"
            out_ext = ".md"
        elif ext == ".pdf":
            content = _pdf_to_text(path)
            kind = "pdf"
            out_ext = ".txt"
        else:
            return None
    except Exception as e:
        # Surface the failure as a text file so the user sees *something* —
        # better than silently skipping the attachment.
        content = f"[Conversion of {path.name} failed: {type(e).__name__}: {e}]"
        kind = "error"
        out_ext = ".txt"
    converted = path.with_suffix(path.suffix + out_ext)
    converted.write_text(content, encoding="utf-8")
    return converted, kind


def materialize(files: list[dict]) -> list[dict]:
    """Decode base64 composer attachments to disk + convert Office formats.

    Input: [{name, data_b64, mime?}]
    Output: [{name, original_path, ref_path, kind}]
      - original_path: where we stashed the raw bytes
      - ref_path: the file path we inject into the prompt (== original for text,
                  == converted sibling for Office/PDF, == original for images)
      - kind: "text" | "image" | "document" | "spreadsheet" | "pdf" | "binary" | "error"
    """
    out: list[dict] = []
    for f in files:
        name = f.get("name") or "attachment"
        data_b64 = f.get("data_b64") or f.get("b64") or ""
        mime = (f.get("mime") or "").lower()
        try:
            raw = _decode_dataurl(data_b64)
        except Exception as e:
            out.append({"name": name, "original_path": None, "ref_path": None, "kind": "error", "error": str(e)})
            continue

        target = _unique_path(name)
        target.write_bytes(raw)

        ext = target.suffix.lower()
        if mime.startswith("image/") or ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
            kind = "image"
            ref = target
        elif ext in OFFICE_EXTS:
            conv = convert_office(target)
            if conv is None:
                kind, ref = "binary", target
            else:
                ref, kind = conv
        elif ext in TEXT_EXTS or _looks_textual(raw):
            kind = "text"
            ref = target
        else:
            kind = "binary"
            ref = target

        out.append({
            "name": name,
            "original_path": str(target),
            "ref_path": str(ref),
            "kind": kind,
        })
    return out


def _looks_textual(b: bytes, sample: int = 4096) -> bool:
    """Heuristic: if the first few KB decode as UTF-8 with few control chars, treat as text."""
    head = b[:sample]
    if not head:
        return True
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError:
        try:
            head.decode("latin-1")
            # Latin-1 always decodes; fall back to control-char heuristic.
            ctrl = sum(1 for ch in head if ch < 9 or (13 < ch < 32))
            return ctrl / max(len(head), 1) < 0.05
        except Exception:
            return False
