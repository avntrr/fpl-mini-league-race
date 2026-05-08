# FPL Mini League Bar Chart Race Generator

Generate animasi bar chart race (MP4 vertikal 9:16) dari standings mini league Fantasy Premier League. Output siap upload ke TikTok / YouTube Shorts / X.

## Prasyarat

- Python 3.10+
- `ffmpeg` (system dependency, harus terinstall di PATH)

### Install ffmpeg

| OS | Command |
|----|---------|
| macOS | `brew install ffmpeg` |
| Ubuntu/Debian | `sudo apt install ffmpeg` |
| Windows | `choco install ffmpeg` atau `winget install ffmpeg` |

Verifikasi: `ffmpeg -version`.

## Setup

```bash
git clone <repo>
cd fpl-race
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                # edit LEAGUE_ID kalau mau default
```

## Cara Cari LEAGUE_ID

1. Login ke <https://fantasy.premierleague.com>
2. Klik tab **Leagues** → pilih league yang dituju
3. Lihat URL: `.../leagues/123456/standings/c` → angka `123456` itulah `LEAGUE_ID`

## Penggunaan

```bash
# Pakai default LEAGUE_ID dari .env
python main.py

# Pass argument langsung
python main.py --league-id 123456 --output race.mp4 --top-n 10

# Force refetch data (skip cache)
python main.py --league-id 123456 --no-cache
```

Output ada di folder `output/`:
- `race.mp4` — animasi final
- `cache_<league_id>.csv` — cache data per-GW (skip refetch)

### Argumen CLI

| Flag | Default | Keterangan |
|------|---------|------------|
| `--league-id` | dari `.env` | ID mini league |
| `--output` | `race.mp4` | Nama file output |
| `--top-n` | `10` | Jumlah bar yang ditampilkan |
| `--no-cache` | off | Force refetch, abaikan cache |

## Catatan API

Endpoint FPL (`fantasy.premierleague.com/api/...`) bersifat **unofficial** tapi cukup stable dan tidak butuh autentikasi. Kalau suatu saat berubah, tinggal patch `fetcher.py`.

## Troubleshooting

**`ffmpeg not found`** — Install ffmpeg dan pastikan ada di `PATH`. Test: `ffmpeg -version`.

**`Belum ada data gameweek`** — Season belum mulai atau GW1 belum selesai. Tunggu deadline GW1 lewat dan match dimainkan.

**Render lambat** — Wajar untuk league besar. Coba `--top-n 8` atau kurangi `steps_per_period` di `renderer.py`.

**League ID invalid** — Cek ulang URL league di FPL website. Pastikan league bersifat **classic** (bukan H2H — H2H pakai endpoint berbeda).

**CORS error** — Tidak relevan, ini script server-side (Python `requests`), bukan browser.

## Struktur

```
fpl-race/
├── main.py              # CLI entry point
├── fetcher.py           # API calls + caching
├── renderer.py          # bar_chart_race rendering
├── config.py            # .env loader
├── requirements.txt
├── .env.example
└── output/              # MP4 + CSV cache (gitignored)
```

Modular: kalau `bar_chart_race` bermasalah, ganti `renderer.py` saja (mis. pakai `matplotlib.animation` raw atau `plotly`).
