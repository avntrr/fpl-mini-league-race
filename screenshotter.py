"""Render bar chart race ke MP4 menggunakan Playwright + React.

Pixel-perfect karena renderer = React app itu sendiri.
Playwright kendalikan headless Chromium, capture screenshot per frame,
ffmpeg rakit PNG → MP4 9:16 @ 30fps.
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

FPS = 30

# Frames per GW untuk setiap speed index (0=1x, 1=2x, 2=4x)
# Harus sama persis dengan SPEEDS[i].stepsPerGw di App.tsx!
STEPS_BY_SPEED = [26, 13, 5]

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
    subprocess.run(
        ["npm", "install", "--save", "react@18.3.1", "react-dom@18.3.1"],
        cwd=REACT_DIR, check=True,
    )
    subprocess.run(["npm", "run", "build"], cwd=REACT_DIR, check=True)


def _gw_float_for_frame(fi: int, total_gws: int, steps: int) -> float:
    """Konversi frame index ke gw float.

    Layout sama dengan renderer.py matplotlib:
      - fi = 0 .. steps-1            → hold GW1 (gw=1.0)
      - fi = steps .. 2*steps-1      → transisi GW1→GW2
      - fi = k*steps .. (k+1)*steps-1 → transisi GWk→GW(k+1)
      - fi = total_gws*steps          → frame terakhir (gw=totalGws)
    Total frames = total_gws * steps + 1
    """
    total_frames = total_gws * steps  # last frame is fi == total_frames

    if fi <= 0:
        return 1.0
    if fi >= total_frames:
        return float(total_gws)

    if fi < steps:
        return 1.0  # hold GW1

    adjusted = fi - steps          # frame index setelah hold
    seg      = adjusted // steps   # transisi ke-N (0 = GW1→GW2)
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
) -> None:
    """Render animasi bar chart race ke MP4 menggunakan Playwright + React.

    Args:
        df:           DataFrame wide (index=GW, cols=team_name, values=cumul pts)
        output_path:  Path file .mp4 output
        top_n:        Jumlah tim yang ditampilkan
        league_name:  Nama liga
        managers_map: {team_name: manager_name}
        progress_cb:  Callback(frame, total) untuk progress reporting
        speed:        0=1x, 1=2x, 2=4x
    """
    from playwright.sync_api import sync_playwright

    steps_per_gw = STEPS_BY_SPEED[max(0, min(speed, len(STEPS_BY_SPEED) - 1))]
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 1. Build/rebuild React kalau perlu
    _build_react_if_needed()

    # 2. Tulis fpl-data.json ke dist/
    _write_fpl_data(df, league_name, managers_map or {}, top_n, REACT_DIST / "fpl-data.json", regions_map or {})

    # 3. Start static HTTP server
    port   = _free_port()
    server = _start_server(REACT_DIST, port)

    # 4. Siapkan frame dir
    frames_dir = output_path.parent / f"_frames_{output_path.stem}"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)

    total_gws    = len(df)
    total_frames = total_gws * steps_per_gw + 1  # inclusive last frame

    # Frame tambahan di akhir: tunggu FM settle lalu hold di posisi final
    HOLD_FRAMES     = 45                          # 1.5 detik hold di akhir video
    total_with_hold = total_frames + HOLD_FRAMES

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            # 540×960 logical px × device_scale_factor 2 = 1080×1920 screenshot (Full HD 9:16)
            page    = browser.new_page(viewport={"width": 540, "height": 960}, device_scale_factor=2)

            page.goto(f"http://127.0.0.1:{port}?capture=1&theme={theme}")
            # Tunggu React mount + data loaded + first render selesai
            page.wait_for_function("() => window.__FPL_READY === true", timeout=20_000)

            # Install fake clock SETELAH halaman load.
            # Dengan fake clock: requestAnimationFrame (dipakai Framer Motion) HANYA
            # maju saat kita panggil page.clock.run_for(). Real-time I/O screenshot tidak
            # mempengaruhi kecepatan animasi. React tetap jalan normal via MessageChannel.
            page.clock.install(time=0)

            # Scale content to 85% — identical visual to the website, centered in 1080×1920.
            # Gives ~144px top/bottom margin (content = 85% × 1920 = 1632px, centered).
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
                background: {_BG.get(theme, '#0a0e1a')};
              }}
              #root {{
                transform: scale(0.85);
                transform-origin: center center;
                width: 100vw;
                height: 100vh;
                flex-shrink: 0;
                overflow: hidden;
              }}
            """)

            MS_PER_FRAME = round(1000 / FPS)  # 33ms at 30fps

            for fi in range(total_frames):
                gw_val = _gw_float_for_frame(fi, total_gws, steps_per_gw)

                # Set frame, tandai belum ready, tunggu React re-render selesai.
                # React menggunakan MessageChannel (bukan setTimeout/rAF) sehingga
                # tidak terpengaruh fake clock — wait_for_function tetap berjalan normal.
                page.evaluate(
                    f"() => {{ window.__FPL_READY = false; window.__FPL_SEEK({gw_val:.6f}); }}"
                )
                page.wait_for_function("() => window.__FPL_READY === true", timeout=5_000)

                # Maju tepat satu video frame (33ms) dalam fake time.
                # Framer Motion rAF maju persis 33ms → animasi sama persis dengan web,
                # tidak peduli berapa lama screenshot I/O memakan waktu nyata.
                page.clock.run_for(MS_PER_FRAME)

                page.screenshot(path=str(frames_dir / f"frame_{fi:06d}.png"))

                if progress_cb:
                    progress_cb(fi + 1, total_with_hold)

            # Hold frames: advance clock agar animasi settle (>550ms duration FM),
            # lalu capture posisi final selama 1.5 detik.
            page.clock.run_for(600)  # Pastikan animasi FM selesai (duration 550ms + margin)
            for i in range(HOLD_FRAMES):
                page.screenshot(path=str(frames_dir / f"frame_{total_frames + i:06d}.png"))
                if progress_cb:
                    progress_cb(total_frames + i + 1, total_with_hold)

            browser.close()

    finally:
        server.shutdown()

    # 5. ffmpeg: PNG sequence → MP4 (1080×1920)
    # Memory-efficient flags for constrained environments (Railway 512MB):
    # - ultrafast preset  : minimal lookahead buffer (~0 frames vs ~250 for "fast")
    # - ref=1 bframes=0   : only 1 reference frame kept in RAM (vs 4-16)
    # - threads=2         : limit worker threads to cap peak memory
    # - crf=23            : quality-based encoding (no bitrate buffer overhead)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-framerate", str(FPS),
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

    # 6. Cleanup
    shutil.rmtree(frames_dir)
