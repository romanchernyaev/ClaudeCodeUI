"""Region screenshot capture via a Tk overlay.

The user drags a rectangle over the desktop; we grab that region with
ImageGrab and return a base64 data URL. No admin rights, no extra deps
beyond Pillow (already a runtime requirement for icon handling).
"""
from __future__ import annotations
import base64
import io
import tkinter as tk
from typing import Optional


def capture_region() -> Optional[str]:
    """Block until the user drags a selection. Return a data: URL (PNG) or None if cancelled."""
    from PIL import ImageGrab  # local import to keep module load cheap

    result: dict = {"bbox": None}

    root = tk.Tk()
    root.withdraw()  # hide the implicit root; we only want the overlay Toplevel

    overlay = tk.Toplevel(root)
    overlay.attributes("-fullscreen", True)
    overlay.attributes("-topmost", True)
    overlay.attributes("-alpha", 0.25)
    overlay.configure(bg="black", cursor="crosshair")
    overlay.overrideredirect(True)  # no chrome
    overlay.focus_force()

    canvas = tk.Canvas(overlay, bg="black", highlightthickness=0, cursor="crosshair")
    canvas.pack(fill="both", expand=True)

    state = {"start": None, "rect": None}

    def on_press(e):
        state["start"] = (e.x_root, e.y_root)
        if state["rect"] is not None:
            canvas.delete(state["rect"])
        state["rect"] = canvas.create_rectangle(
            e.x, e.y, e.x, e.y, outline="#d97757", width=2, fill=""
        )

    def on_drag(e):
        if state["start"] is None or state["rect"] is None:
            return
        sx = state["start"][0] - overlay.winfo_rootx()
        sy = state["start"][1] - overlay.winfo_rooty()
        canvas.coords(state["rect"], sx, sy, e.x, e.y)

    def on_release(e):
        if state["start"] is None:
            _finish(None)
            return
        x1, y1 = state["start"]
        x2, y2 = e.x_root, e.y_root
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        if (right - left) < 3 or (bottom - top) < 3:
            _finish(None)
            return
        _finish((left, top, right, bottom))

    def on_escape(_e):
        _finish(None)

    def _finish(bbox):
        result["bbox"] = bbox
        try:
            overlay.destroy()
            root.destroy()
        except Exception:
            pass

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", on_release)
    overlay.bind("<Escape>", on_escape)

    root.mainloop()

    bbox = result["bbox"]
    if not bbox:
        return None
    try:
        img = ImageGrab.grab(bbox=bbox, all_screens=True)
    except TypeError:
        # Older Pillow without all_screens kwarg
        img = ImageGrab.grab(bbox=bbox)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return "data:image/png;base64," + b64
