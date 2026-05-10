"""Flask backend untuk FPL Race Generator.

Serve React app (dist/) sebagai frontend + API endpoints untuk data FPL.
"""
from __future__ import annotations

import os
import subprocess
import threading
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from fetcher import (
    load_or_build, load_or_build_timed, discover_league_id, COUNTRY_LIST,
    fetch_entry_regions,
)
from renderer import render_race

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "output"
REACT_DIR  = BASE_DIR / "Create Bar Race Visualization"
REACT_DIST = REACT_DIR / "dist"

OUTPUT_DIR.mkdir(exist_ok=True)

# Warna per tim — sama persis dengan App.tsx
PALETTE = [
    "#00d4aa", "#ff6b6b", "#ffd93d", "#a855f7", "#f97316",
    "#c084fc", "#38bdf8", "#4ade80", "#fb7185", "#94a3b8",
    "#06b6d4", "#ec4899", "#14b8a6", "#f43f5e", "#84cc16",
    "#6366f1", "#0ea5e9", "#d946ef", "#10b981", "#fb923c",
]

app  = Flask(__name__, static_folder=None)
jobs: dict[str, dict] = {}


# ── Serve React SPA ───────────────────────────────────────────────────────────

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_react(path: str):
    """Serve React app dari dist/. Semua path unknown → index.html (SPA routing)."""
    if not REACT_DIST.exists():
        return (
            "<pre>React app belum di-build.\n"
            "Jalankan:\n"
            "  cd 'Create Bar Race Visualization'\n"
            "  npm install --legacy-peer-deps\n"
            "  npm run build</pre>",
            503,
        )
    target = REACT_DIST / path
    if path and target.exists() and target.is_file():
        return send_from_directory(REACT_DIST, path)
    return send_file(REACT_DIST / "index.html")


# ── API: daftar negara ────────────────────────────────────────────────────────

@app.route("/api/countries")
def api_countries():
    return jsonify({"countries": COUNTRY_LIST})


# ── Helpers: resolve mode → (df, league_name, managers_map) ──────────────────

def _resolve_data(
    mode: str,
    league_id: int | None,
    country: str | None,
    top_n: int,
    force_refresh: bool = False,
) -> tuple:
    """Return (df, league_name, managers_map, regions_map) for any mode.

    regions_map is {team_name: iso_code_short} for Global mode, {} otherwise.
    Raises ValueError for invalid inputs.
    """
    if mode == "global":
        lid = discover_league_id("Overall")
        if lid is None:
            raise ValueError("FPL global overall league not found. Try again later.")
        label = f"FPL Global Top {top_n}"
        return load_or_build_timed(lid, label, f"global_{lid}", include_regions=True)

    if mode == "nation":
        if not country:
            raise ValueError("Country is required for Nation mode.")
        lid = discover_league_id(country)
        if lid is None:
            raise ValueError(f"FPL league for '{country}' not found. Try again later.")
        label = f"FPL {country} Top {top_n}"
        df, lname, mm, _ = load_or_build_timed(lid, label, f"nation_{lid}")
        return df, lname, mm, {}

    # default: mini league
    if not league_id:
        raise ValueError("League ID is required.")
    df, lname, mm = load_or_build(league_id, OUTPUT_DIR, force_refresh)
    return df, lname, mm, {}


# ── API: ambil data FPL ───────────────────────────────────────────────────────

@app.route("/api/data")
def api_data():
    """Fetch + cache data FPL, return JSON untuk React app."""
    mode      = request.args.get("mode", "mini")
    league_id = request.args.get("league_id", type=int)
    country   = request.args.get("country", "").strip() or None
    top_n     = request.args.get("top_n", 10, type=int)

    try:
        df, league_name, managers_map, regions_map = _resolve_data(
            mode, league_id, country, top_n
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except SystemExit:
        return jsonify({"error": "Invalid League ID or no gameweek data available."}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if df.empty:
        return jsonify({"error": "No gameweek data yet. Wait until after GW1 is complete."}), 400

    import pandas as pd
    df_gw = df.diff().fillna(df.iloc[[0]])
    gws   = df.index.tolist()
    teams = list(df.columns)

    managers = [
        {
            "id":    str(i),
            "name":  managers_map.get(t, t),
            "team":  t,
            "color": PALETTE[i % len(PALETTE)],
        }
        for i, t in enumerate(teams)
    ]

    scores    = [[int(df.loc[gw, t])    for gw in gws] for t in teams]
    gw_scores = [[int(df_gw.loc[gw, t]) for gw in gws] for t in teams]

    payload: dict = {
        "leagueName": league_name,
        "totalGws":   len(gws),
        "managers":   managers,
        "scores":     scores,
        "gwScores":   gw_scores,
    }
    if regions_map:
        payload["regionsMap"] = regions_map
    return jsonify(payload)


# ── API: global rank journey untuk satu manager ──────────────────────────────

_total_managers_cache: "int | None" = None

@app.route("/api/rank")
def api_rank():
    """Fetch per-GW overall_rank untuk satu FPL manager (entry_id)."""
    import requests as req

    entry_id = request.args.get("entry_id", type=int)
    if not entry_id:
        return jsonify({"error": "Entry ID is required."}), 400

    try:
        # Manager info
        entry_resp = req.get(
            f"https://fantasy.premierleague.com/api/entry/{entry_id}/",
            timeout=15,
        )
        if entry_resp.status_code == 404:
            return jsonify({"error": "Manager ID not found."}), 404
        entry_resp.raise_for_status()
        entry_data = entry_resp.json()

        # Per-GW history
        hist_resp = req.get(
            f"https://fantasy.premierleague.com/api/entry/{entry_id}/history/",
            timeout=15,
        )
        hist_resp.raise_for_status()
        current = hist_resp.json().get("current", [])

        if not current:
            return jsonify({"error": "No gameweek data found for this manager."}), 400

        # Total managers — cache sekali per server lifetime
        global _total_managers_cache
        if _total_managers_cache is None:
            bs = req.get(
                "https://fantasy.premierleague.com/api/bootstrap-static/",
                timeout=15,
            ).json()
            _total_managers_cache = bs["total_players"]

        manager_name = (
            f"{entry_data.get('player_first_name', '')} "
            f"{entry_data.get('player_last_name', '')}"
        ).strip()

        return jsonify({
            "managerName":   manager_name,
            "teamName":      entry_data.get("name", ""),
            "region":        entry_data.get("player_region_name", ""),
            "totalManagers": _total_managers_cache,
            "gwData": [
                {
                    "gw":            row["event"],
                    "overallRank":   row["overall_rank"],
                    "percentileRank": row["percentile_rank"],
                    "totalPoints":   row["total_points"],
                    "gwPoints":      row["points"],
                }
                for row in current
            ],
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Generate MP4 (background render) ─────────────────────────────────────────

@app.route("/generate", methods=["POST"])
def generate():
    """Trigger background render MP4."""
    data    = request.get_json() or {}
    mode    = data.get("mode", "mini")
    raw_id  = data.get("league_id", "")
    country = (data.get("country", "") or "").strip() or None
    top_n   = int(data.get("top_n", 10))
    force   = bool(data.get("force_refresh", False))
    speed   = int(data.get("speed", 0))
    theme   = data.get("theme", "dark")
    fps     = int(data.get("fps", 30))
    if theme not in ("dark", "light"):
        theme = "dark"
    if fps not in (30, 60):
        fps = 30

    league_id: int | None = None
    if mode == "mini":
        try:
            league_id = int(str(raw_id).strip())
        except (ValueError, TypeError):
            return jsonify({"error": "League ID must be a number."}), 400

    job_id = uuid.uuid4().hex[:8]
    jobs[job_id] = {"status": "pending", "message": "Starting..."}

    threading.Thread(
        target=_run_job,
        args=(job_id, mode, league_id, country, top_n, force, speed, theme, fps),
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        abort(404)
    return jsonify(job)


@app.route("/download/<filename>")
def download(filename: str):
    if not filename.endswith(".mp4") or "/" in filename or "\\" in filename:
        abort(400)
    filepath = OUTPUT_DIR / filename
    if not filepath.exists():
        abort(404)
    return send_file(filepath, as_attachment=True, download_name=filename)


def _run_job(
    job_id: str,
    mode: str,
    league_id: int | None,
    country: str | None,
    top_n: int,
    force_refresh: bool,
    speed: int = 0,
    theme: str = "dark",
    fps: int = 30,
) -> None:
    """Worker render MP4 in a separate thread."""
    speed_labels = ["1x", "2x", "4x"]
    spd_label    = speed_labels[max(0, min(speed, 2))]

    try:
        jobs[job_id] = {"status": "running", "message": "Fetching data from FPL..."}

        df, league_name, managers_map, regions_map = _resolve_data(
            mode, league_id, country, top_n, force_refresh
        )

        jobs[job_id]["message"] = f"Rendering {len(df)} GW, top {top_n}, speed {spd_label}, {fps}fps..."

        # Unique filename per mode
        if mode == "global":
            slug = f"global_top{top_n}"
        elif mode == "nation":
            slug = f"nation_{(country or 'unknown').lower().replace(' ', '_')}_top{top_n}"
        else:
            slug = f"mini_{league_id}_top{top_n}"
        output_filename = f"race_{slug}_spd{spd_label}_{fps}fps_{theme}.mp4"
        output_path     = OUTPUT_DIR / output_filename

        def progress(current: int, total: int) -> None:
            if current % 50 == 0 or current == total:
                pct = int(current / total * 100)
                jobs[job_id]["message"] = f"Rendering... {pct}% ({current}/{total} frames)"

        render_race(
            df, output_path,
            top_n=top_n,
            league_name=league_name,
            managers_map=managers_map,
            regions_map=regions_map,
            progress_cb=progress,
            speed=speed,
            theme=theme,
            fps=fps,
        )

        jobs[job_id] = {
            "status":      "done",
            "message":     "Video is ready to download!",
            "filename":    output_filename,
            "league_name": league_name,
        }

    except (SystemExit, ValueError) as e:
        msg = str(e) if str(e) else "Invalid League ID or no gameweek data available."
        jobs[job_id] = {"status": "error", "message": msg}
    except Exception as e:
        jobs[job_id] = {"status": "error", "message": str(e)}


# ── Startup ───────────────────────────────────────────────────────────────────

def _build_react_if_needed() -> None:
    """Build React app if dist/ does not exist yet."""
    if REACT_DIST.exists():
        return
    print("⚙️  Building React app (pertama kali)...")
    subprocess.run(
        ["npm", "install", "--legacy-peer-deps"],
        cwd=REACT_DIR, check=True
    )
    # react & react-dom ada di peerDependencies (optional) → install eksplisit
    subprocess.run(
        ["npm", "install", "--save", "react@18.3.1", "react-dom@18.3.1"],
        cwd=REACT_DIR, check=True
    )
    subprocess.run(
        ["npm", "run", "build"],
        cwd=REACT_DIR, check=True
    )
    print("✅ React app built!")


if __name__ == "__main__":
    _build_react_if_needed()
    port = int(os.environ.get("PORT", 8080))
    app.run(debug=False, host="0.0.0.0", port=port, threaded=True)
