"""Render bar chart race ke MP4 menggunakan Playwright + React.

Pixel-perfect karena renderer = React app itu sendiri.
Playwright kendalikan headless Chromium, capture screenshot per frame,
ffmpeg rakit PNG → MP4 9:16 @ 30fps.

Rank transition fix (App.tsx):
  sorted menggunakan target GW (floor+1) bukan nilai interpolasi,
  sehingga rank hanya berubah SEKALI per GW → Framer Motion punya
  waktu penuh untuk animasi slide tanpa diinterupsi.
"""
from __future__ import annotations

import json
import shutil
import socket
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, HTTPServer
from pathlib import Path

import pandas as pd

BASE_DIR   = Path(__file__).parent
REACT_DIR  = BASE_DIR / "Create Bar Race Visualization"
REACT_DIST = REACT_DIR / "dist"

# Frames per GW untuk setiap speed index (0=1x, 1=2x, 2=4x)
STEPS_BY_SPEED = {
    30: [26, 13, 5],
    60: [52, 26, 10],
}

PALETTE = [
    "#00d4aa", "#ff6b6b", "#ffd93d", "#a855f7", "#f97316",
    "#c084fc", "#38bdf8", "#4ade80", "#fb7185", "#94a3b8",
    "#06b6d4", "#ec4899", "#14b8a6", "#f43f5e", "#84cc16",
    "#6366f1", "#0ea5e9", "#d946ef", "#10b981", "#fb923c",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _truncate(name: str, n: int = 13) -> str:
    return name if len(name) <= n else name[:n] + "..."


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def _start_server(directory: Path, port: int) -> HTTPServer:
    class _Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)
        def log_message(self, *_):
            pass
    server = HTTPServer(("127.0.0.1", port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


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


def _build_react_if_needed() -> None:
    """Build React satu kali; rebuild otomatis kalau App.tsx lebih baru dari dist."""
    need_build = not REACT_DIST.exists()
    if not need_build:
        app_tsx    = REACT_DIR / "src" / "app" / "App.tsx"
        index_html = REACT_DIST / "index.html"
        if app_tsx.exists() and index_html.exists():
            need_build = app_tsx.stat().st_mtime > index_html.stat().st_mtime

    if not need_build:
        return

    subprocess.run(["npm", "install", "--legacy-peer-deps"], cwd=REACT_DIR, check=True)
    subprocess.run(["npm", "run", "build"], cwd=REACT_DIR, check=True)


def _gw_float_for_frame(fi: int, total_gws: int, steps: int) -> float:
    """Konversi frame index ke gw float.

      fi = 0 .. steps-1          → hold GW1 (gw=1.0)
      fi = steps .. 2*steps-1    → transisi GW1→GW2  (gw 1.0→2.0)
      fi = k*steps..(k+1)*steps-1 → transisi GWk→GW(k+1)
      fi = total_gws*steps        → frame terakhir (gw=totalGws)
    Total frames = total_gws * steps + 1
    """
    total_frames = total_gws * steps

    if fi <= 0:
        return 1.0
    if fi >= total_frames:
        return float(total_gws)
    if fi < steps:
        return 1.0  # hold GW1

    adjusted = fi - steps
    seg      = adjusted // steps
    frac     = (adjusted % steps) / steps
    return 1.0 + seg + frac


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
    from playwright.sync_api import sync_playwright

    fps          = fps if fps in STEPS_BY_SPEED else 30
    steps_per_gw = STEPS_BY_SPEED[fps][max(0, min(speed, 2))]
    output_path.parent.mkdir(parents=True, exist_ok=True)

    _build_react_if_needed()
    _write_fpl_data(df, league_name, managers_map or {}, top_n, REACT_DIST / "fpl-data.json", regions_map or {})

    port   = _free_port()
    server = _start_server(REACT_DIST, port)

    frames_dir = output_path.parent / f"_frames_{output_path.stem}"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)

    total_gws       = len(df)
    total_frames    = total_gws * steps_per_gw + 1  # inclusive last frame
    HOLD_FRAMES     = 45
    total_with_hold = total_frames + HOLD_FRAMES

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            page    = browser.new_page(viewport={"width": 540, "height": 960}, device_scale_factor=2)

            # Install fake clock SEBELUM goto() agar Framer Motion tidak pernah
            # melihat real performance.now() → animasi sinkron dengan fake clock.
            page.clock.install(time=0)
            page.goto(f"http://127.0.0.1:{port}?capture=1&theme={theme}")

            # Inisialisasi React + Framer Motion dengan fake clock
            for _ in range(100):
                page.clock.run_for(30)

            page.wait_for_function("() => window.__FPL_READY === true", timeout=20_000)

            _BG = {"dark": "#0a0e1a", "light": "#f8fafc"}
            page.add_style_tag(content=f"""
              html, body {{
                zoom: 1 !important;
                width: 100vw; height: 100vh;
                margin: 0; padding: 0;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
              }}
              html {{ background: {_BG.get(theme, '#0a0e1a')}; }}
              body {{ background: transparent; }}
              #root {{
                transform: scale(0.85);
                transform-origin: center center;
                width: 100vw; height: 100vh;
                flex-shrink: 0; overflow: hidden;
                z-index: 1;
              }}
            """)

            MS_PER_FRAME = round(1000 / fps)

            for fi in range(total_frames):
                gw_val = _gw_float_for_frame(fi, total_gws, steps_per_gw)
                page.evaluate(
                    f"() => {{ window.__FPL_READY = false; window.__FPL_SEEK({gw_val:.6f}); }}"
                )
                page.wait_for_function("() => window.__FPL_READY === true", timeout=5_000)
                page.clock.run_for(MS_PER_FRAME)
                page.screenshot(path=str(frames_dir / f"frame_{fi:06d}.png"))
                if progress_cb:
                    progress_cb(fi + 1, total_with_hold)

            # Hold frames
            page.clock.run_for(600)
            for i in range(HOLD_FRAMES):
                page.screenshot(path=str(frames_dir / f"frame_{total_frames + i:06d}.png"))
                if progress_cb:
                    progress_cb(total_frames + i + 1, total_with_hold)

            browser.close()

    finally:
        server.shutdown()

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-i", str(frames_dir / "frame_%06d.png"),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", "ultrafast",
            "-crf", "23",
            "-x264opts", "ref=1:bframes=0:no-cabac=1",
            "-threads", "2",
            str(output_path),
        ],
        check=True,
    )

    shutil.rmtree(frames_dir)
