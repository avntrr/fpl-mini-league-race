"""Render bar chart race ke MP4 menggunakan Remotion.

Pipeline baru (menggantikan Playwright + screenshot per frame):
  1. Tulis fpl-data.json ke dist/
  2. Panggil `node render.mjs` → Remotion bundle + render + encode MP4
  3. render.mjs mengelola bundling, Chrome headless, ffmpeg secara internal

Keuntungan vs Playwright:
  - Animasi deterministik: frame N selalu identik (tidak bergantung timing)
  - Rank transition smooth: dihitung eksplisit via Easing, bukan menunggu FM
  - Tidak perlu fake clock, HTTP server, atau screenshot loop manual
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pandas as pd

BASE_DIR   = Path(__file__).parent
REACT_DIR  = BASE_DIR / "Create Bar Race Visualization"
REACT_DIST = REACT_DIR / "dist"

PALETTE = [
    "#00d4aa", "#ff6b6b", "#ffd93d", "#a855f7", "#f97316",
    "#c084fc", "#38bdf8", "#4ade80", "#fb7185", "#94a3b8",
    "#06b6d4", "#ec4899", "#14b8a6", "#f43f5e", "#84cc16",
    "#6366f1", "#0ea5e9", "#d946ef", "#10b981", "#fb923c",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _truncate(name: str, n: int = 13) -> str:
    return name if len(name) <= n else name[:n] + "..."


def _write_fpl_data(
    df: pd.DataFrame,
    league_name: str,
    managers_map: dict[str, str],
    top_n: int,
    dest: Path,
    regions_map: "dict[str, str] | None" = None,
) -> None:
    df_gw  = df.diff().fillna(df.iloc[[0]])
    gws    = df.index.tolist()
    rename = {c: _truncate(c) for c in df.columns}
    df_r   = df.rename(columns=rename)
    dg_r   = df_gw.rename(columns=rename)
    mgr    = {_truncate(k): v for k, v in managers_map.items()}
    teams  = list(df_r.columns)

    managers = [
        {"id": str(i), "name": mgr.get(t, t), "team": t, "color": PALETTE[i % len(PALETTE)]}
        for i, t in enumerate(teams)
    ]
    scores    = [[int(df_r.loc[gw, t]) for gw in gws] for t in teams]
    gw_scores = [[int(dg_r.loc[gw, t]) for gw in gws] for t in teams]

    payload = {
        "leagueName": league_name,
        "totalGws":   len(gws),
        "topN":       top_n,
        "managers":   managers,
        "scores":     scores,
        "gwScores":   gw_scores,
    }
    if regions_map:
        payload["regionsMap"] = regions_map
    dest.write_text(json.dumps(payload))


def _ensure_npm_deps() -> None:
    """Install npm deps kalau node_modules belum ada."""
    if not (REACT_DIR / "node_modules" / "remotion").exists():
        subprocess.run(["npm", "install", "--legacy-peer-deps"], cwd=REACT_DIR, check=True)
        subprocess.run(
            ["npm", "install", "--save", "react@18.3.1", "react-dom@18.3.1"],
            cwd=REACT_DIR, check=True,
        )


def _get_chromium_path() -> str | None:
    """Dapatkan path Playwright Chromium agar Remotion tidak perlu download sendiri."""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            return p.chromium.executable_path
    except Exception:
        return None


# ── Main renderer ─────────────────────────────────────────────────────────────

def render_race(
    df: pd.DataFrame,
    output_path: Path,
    top_n: int = 10,
    league_name: str = "FPL League",
    managers_map: "dict[str, str] | None" = None,
    regions_map: "dict[str, str] | None" = None,
    progress_cb: "callable[[int, int], None] | None" = None,
    speed: int = 0,
    theme: str = "dark",
    fps: int = 30,
) -> None:
    """Render animasi bar chart race ke MP4 menggunakan Remotion.

    Args:
        df:           DataFrame wide (index=GW, cols=team_name, values=cumul pts)
        output_path:  Path file .mp4 output
        top_n:        Jumlah tim yang ditampilkan
        league_name:  Nama liga
        managers_map: {team_name: manager_name}
        progress_cb:  Callback(frame, total) untuk progress reporting
        speed:        0=1x, 1=2x, 2=4x
        fps:          30 (standard) atau 60 (smoother, ~2x render time)
    """
    fps = fps if fps in (30, 60) else 30
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 1. Pastikan npm deps terinstall (termasuk remotion)
    _ensure_npm_deps()

    # 2. Tulis fpl-data.json — dibaca oleh render.mjs sebagai inputProps
    REACT_DIST.mkdir(parents=True, exist_ok=True)
    _write_fpl_data(
        df, league_name, managers_map or {}, top_n,
        REACT_DIST / "fpl-data.json",
        regions_map or {},
    )

    # 3. Hitung total frames untuk progress reporting
    steps_table  = {30: [26, 13, 5], 60: [52, 26, 10]}
    steps_per_gw = steps_table[fps][max(0, min(speed, 2))]
    total_gws    = len(df)
    total_frames = total_gws * steps_per_gw + 45  # +45 hold frames

    # 4. Dapatkan Playwright Chromium (supaya Remotion tidak perlu download sendiri)
    chromium_path = _get_chromium_path()

    # 5. Panggil render.mjs via Node.js
    render_script = REACT_DIR / "render.mjs"
    cmd = [
        "node", str(render_script),
        "--data",   str(REACT_DIST / "fpl-data.json"),
        "--output", str(output_path),
        "--fps",    str(fps),
        "--theme",  theme,
        "--speed",  str(speed),
        "--top-n",  str(top_n),
    ]
    if chromium_path:
        cmd += ["--chromium", chromium_path]

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=REACT_DIR,
    )

    # Baca stdout baris per baris untuk progress reporting
    for line in process.stdout:                      # type: ignore[union-attr]
        line = line.strip()
        if line.startswith("PROGRESS:") and progress_cb:
            parts = line.split(":")
            try:
                rendered = int(parts[2]) if len(parts) > 2 else 0
                progress_cb(rendered, total_frames)
            except (ValueError, IndexError):
                pass

    process.wait()

    if process.returncode != 0:
        stderr = process.stderr.read() if process.stderr else ""  # type: ignore[union-attr]
        raise RuntimeError(f"Remotion render failed (exit {process.returncode}):\n{stderr}")
