"""CLI entry point untuk FPL Mini League Bar Chart Race generator."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from config import Config
from fetcher import load_or_build
from renderer import render_race

OUTPUT_DIR = Path(__file__).parent / "output"


def parse_args() -> argparse.Namespace:
    cfg = Config.from_env()
    parser = argparse.ArgumentParser(
        description="Generate bar chart race MP4 dari FPL mini league."
    )
    parser.add_argument(
        "--league-id",
        type=int,
        default=cfg.league_id,
        help="ID mini league FPL (default: dari .env)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="race.mp4",
        help="Nama file output (relatif ke folder output/)",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Jumlah bar yang ditampilkan (default: 10)",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Force refetch data, abaikan cache CSV",
    )
    args = parser.parse_args()

    if args.league_id is None:
        parser.error("--league-id wajib di-pass atau set LEAGUE_ID di .env")
    return args


def main() -> int:
    args = parse_args()
    output_path = OUTPUT_DIR / args.output

    df, league_name, managers_map = load_or_build(
        league_id=args.league_id,
        cache_dir=OUTPUT_DIR,
        force_refresh=args.no_cache,
    )

    if df.empty or len(df) < 1:
        print("❌ DataFrame kosong, tidak bisa render.", file=sys.stderr)
        return 1

    print(f"🎬 Rendering ke {output_path} (top {args.top_n})...")
    render_race(df, output_path, top_n=args.top_n, league_name=league_name,
                managers_map=managers_map)
    print(f"✅ Done: {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
