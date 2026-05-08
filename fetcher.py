"""Data fetching dari FPL public API.

Endpoint bersifat unofficial tapi stable dan tidak butuh auth.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Optional, TypedDict

import pandas as pd
import requests

BASE = "https://fantasy.premierleague.com/api"
STANDINGS_URL = BASE + "/leagues-classic/{league_id}/standings/"
HISTORY_URL = BASE + "/entry/{entry_id}/history/"

REQUEST_DELAY = 0.3
MAX_RETRIES = 3
TIMEOUT = 15


class Manager(TypedDict):
    entry_id: int
    team_name: str
    manager_name: str


class GwPoint(TypedDict):
    gw: int
    total_points: int


def _get_with_retry(url: str, params: Optional[dict] = None) -> dict:
    """GET dengan exponential backoff retry."""
    last_err: Optional[Exception] = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, params=params, timeout=TIMEOUT)
            if resp.status_code == 404:
                raise ValueError(f"Resource tidak ditemukan: {url}")
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as e:
            last_err = e
            if isinstance(e, ValueError):
                raise
            if attempt < MAX_RETRIES - 1:
                time.sleep(2**attempt)
    raise RuntimeError(f"Gagal fetch {url} setelah {MAX_RETRIES} percobaan: {last_err}")


MAX_DISPLAY = 20   # maximum managers ever shown in the UI

def fetch_standings(league_id: int, limit: int = MAX_DISPLAY) -> tuple[str, list[Manager]]:
    """Ambil nama league + top-{limit} manager (sudah terurut by rank dari API).

    Standings FPL sudah diurutkan by total points descending, jadi cukup
    ambil halaman pertama untuk mendapatkan top-N. Tidak perlu fetch semua
    halaman kalau liga punya ratusan member.

    Returns:
        (league_name, managers)  — len(managers) <= limit
    """
    managers: list[Manager] = []
    league_name = f"FPL League {league_id}"
    page = 1

    while len(managers) < limit:
        try:
            data = _get_with_retry(
                STANDINGS_URL.format(league_id=league_id),
                params={"page_standings": page},
            )
        except ValueError:
            print(f"❌ League ID {league_id} tidak ditemukan.", file=sys.stderr)
            sys.exit(1)

        if page == 1:
            league_name = data.get("league", {}).get("name", league_name)

        results = data.get("standings", {}).get("results", [])
        for row in results:
            managers.append(
                {
                    "entry_id": row["entry"],
                    "team_name": row.get("entry_name", f"Team {row['entry']}"),
                    "manager_name": row.get("player_name", ""),
                }
            )
            if len(managers) >= limit:
                break

        if not data.get("standings", {}).get("has_next") or len(managers) >= limit:
            break
        page += 1
        time.sleep(REQUEST_DELAY)

    # Dedup nama tim duplikat dengan append entry_id
    seen: dict[str, int] = {}
    for m in managers:
        seen[m["team_name"]] = seen.get(m["team_name"], 0) + 1
    dup_names = {n for n, c in seen.items() if c > 1}
    for m in managers:
        if m["team_name"] in dup_names:
            m["team_name"] = f"{m['team_name']} ({m['entry_id']})"

    return league_name, managers


def fetch_manager_history(entry_id: int) -> list[GwPoint]:
    """Ambil history per-GW untuk satu manager."""
    data = _get_with_retry(HISTORY_URL.format(entry_id=entry_id))
    current = data.get("current", [])
    return [{"gw": row["event"], "total_points": row["total_points"]} for row in current]


def build_dataframe(managers: list[Manager]) -> pd.DataFrame:
    """Bangun wide-format DataFrame: index=GW, cols=team_name, values=cumulative total_points."""
    series_map: dict[str, pd.Series] = {}
    for i, m in enumerate(managers):
        try:
            history = fetch_manager_history(m["entry_id"])
        except Exception as e:
            print(f"⚠️  Skip {m['team_name']} (entry {m['entry_id']}): {e}", file=sys.stderr)
            continue

        if not history:
            print(f"⚠️  {m['team_name']} belum punya history, skip.", file=sys.stderr)
            continue

        s = pd.Series(
            {row["gw"]: row["total_points"] for row in history},
            name=m["team_name"],
        )
        series_map[m["team_name"]] = s

        if (i + 1) % 10 == 0:
            print(f"  ...fetched {i + 1}/{len(managers)} managers")
        time.sleep(REQUEST_DELAY)

    if not series_map:
        print(
            "❌ Belum ada data gameweek. Tunggu setelah GW1 selesai.",
            file=sys.stderr,
        )
        sys.exit(1)

    df = pd.DataFrame(series_map)
    df.index.name = "GW"
    df = df.sort_index().ffill().fillna(0)
    return df


def load_or_build(
    league_id: int, cache_dir: Path, force_refresh: bool = False
) -> tuple[pd.DataFrame, str, dict[str, str]]:
    """Load DataFrame dari cache atau build baru.

    Returns:
        (df, league_name, managers_map) — managers_map: {team_name: manager_name}
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"cache_{league_id}.csv"
    name_path = cache_dir / f"name_{league_id}.txt"
    managers_path = cache_dir / f"managers_{league_id}.json"

    if cache_path.exists() and not force_refresh:
        print(f"📂 Loading cache: {cache_path}")
        df = pd.read_csv(cache_path, index_col=0)
        league_name = name_path.read_text().strip() if name_path.exists() else f"FPL League {league_id}"
        managers_map = json.loads(managers_path.read_text()) if managers_path.exists() else {}
        return df, league_name, managers_map

    print(f"🌐 Fetching standings untuk league {league_id}...")
    league_name, managers = fetch_standings(league_id)
    print(f"✅ {len(managers)} manager ditemukan di \"{league_name}\". Fetching history...")
    df = build_dataframe(managers)
    managers_map = {m["team_name"]: m["manager_name"] for m in managers}
    df.to_csv(cache_path)
    name_path.write_text(league_name)
    managers_path.write_text(json.dumps(managers_map, ensure_ascii=False))
    print(f"💾 Cached ke {cache_path}")
    return df, league_name, managers_map
