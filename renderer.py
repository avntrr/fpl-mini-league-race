"""Render bar chart race ke MP4 vertikal (9:16) @ 30fps.

Renderer priority:
1. Playwright (screenshotter.py) — pixel-perfect, pakai React app langsung
2. Matplotlib fallback — kalau playwright tidak terinstall

Visual matplotlib mengacu pada Figma design (App.tsx):
- Dark navy background
- Header: "Season Race" + league name + GW progress bar
- Per-row: rank badge | manager name (coloured) + team (dim) | gradient bar | pts + +GW
- Accent hijau #00ff87, rank top-3 gold/silver/bronze
"""
from __future__ import annotations

import pandas as pd
from pathlib import Path


# ── Public API ────────────────────────────────────────────────────────────────

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
    """Render bar chart race to MP4. Uses Playwright if available, falls back to matplotlib."""
    try:
        import playwright  # noqa: F401
        from screenshotter import render_race as _pw_render
        _pw_render(
            df, output_path,
            top_n=top_n,
            league_name=league_name,
            managers_map=managers_map,
            regions_map=regions_map,
            progress_cb=progress_cb,
            speed=speed,
            theme=theme,
            fps=fps,
        )
        return
    except ImportError:
        pass  # playwright belum terinstall, gunakan matplotlib

    _render_matplotlib(
        df, output_path,
        top_n=top_n,
        league_name=league_name,
        managers_map=managers_map,
        progress_cb=progress_cb,
        speed=speed,
    )


# ── Matplotlib fallback ───────────────────────────────────────────────────────

def _render_matplotlib(
    df: pd.DataFrame,
    output_path: Path,
    top_n: int = 10,
    league_name: str = "FPL League",
    managers_map: "dict[str, str] | None" = None,
    progress_cb: "callable[[int, int], None] | None" = None,
    speed: int = 0,
) -> None:
    """Matplotlib fallback renderer."""
    import matplotlib
    matplotlib.use("Agg")

    import matplotlib.animation as anim
    import matplotlib.colors as mcolors
    import matplotlib.pyplot as plt
    import numpy as np

    FPS = 30
    _STEPS_BY_SPEED = [26, 13, 5]
    STEPS_PER_GW    = _STEPS_BY_SPEED[max(0, min(speed, 2))]
    BAR_H        = 0.32

    BG      = "#080c18"
    FG      = "#e2e8f0"
    DIM     = "#64748b"
    ACCENT  = "#00ff87"
    TRACK   = "#1a2236"
    MONO    = "monospace"

    RANK_COLORS  = ["#00ff87", "#ffd700", "#cd853f"]
    RANK_SYMBOLS = ["①", "②", "③"]

    PALETTE = [
        "#00d4aa", "#ff6b6b", "#ffd93d", "#a855f7", "#f97316",
        "#c084fc", "#38bdf8", "#4ade80", "#fb7185", "#94a3b8",
        "#06b6d4", "#ec4899", "#14b8a6", "#f43f5e", "#84cc16",
        "#6366f1", "#0ea5e9", "#d946ef", "#10b981", "#fb923c",
    ]

    def truncate(name: str, n: int = 13) -> str:
        return name if len(name) <= n else name[:n] + "..."

    def gradient_img(hex_color: str, alpha_start: float = 0.30) -> "np.ndarray":
        r, g, b = mcolors.to_rgb(hex_color)
        img = np.zeros((1, 256, 4))
        for i in range(256):
            t = i / 255
            img[0, i] = [r, g, b, alpha_start + t * (0.82 - alpha_start)]
        return img.clip(0, 1)

    def build_frames(df_: pd.DataFrame):
        gws     = df_.index.tolist()
        rank_df = df_.rank(axis=1, method="first", ascending=False)
        vals_l, rnks_l, gw_l = [], [], []

        def lerp(a, b, t):
            return a * (1 - t) + b * t

        for _ in range(STEPS_PER_GW):
            vals_l.append(df_.iloc[0]); rnks_l.append(rank_df.iloc[0]); gw_l.append(gws[0])
        for i in range(1, len(gws)):
            for s in range(STEPS_PER_GW):
                t = s / STEPS_PER_GW
                vals_l.append(lerp(df_.iloc[i - 1], df_.iloc[i], t))
                rnks_l.append(lerp(rank_df.iloc[i - 1], rank_df.iloc[i], t))
                gw_l.append(gws[i])
        vals_l.append(df_.iloc[-1]); rnks_l.append(rank_df.iloc[-1]); gw_l.append(gws[-1])
        return vals_l, rnks_l, gw_l

    output_path.parent.mkdir(parents=True, exist_ok=True)

    rename = {c: truncate(c) for c in df.columns}
    df     = df.rename(columns=rename)
    mgr    = {truncate(k): v for k, v in (managers_map or {}).items()}
    df_gw  = df.diff().fillna(df.iloc[[0]])

    team_color = {t: PALETTE[i % len(PALETTE)] for i, t in enumerate(df.columns)}
    grad_imgs  = {t: gradient_img(c) for t, c in team_color.items()}

    vals_list, rnks_list, gw_labels = build_frames(df)
    n_frames  = len(vals_list)
    total_gws = int(df.index.max())

    fig = plt.figure(figsize=(6, 10), dpi=144)
    fig.patch.set_facecolor(BG)

    fig.text(0.06, 0.975, f"Fantasy Premier League  ·  {league_name}",
             ha="left", va="top", fontsize=7.5, color=ACCENT, fontfamily=MONO, fontweight="bold")
    fig.text(0.06, 0.950, "Season", ha="left", va="top", fontsize=22, fontweight="black", color=FG)
    fig.text(0.06, 0.912, "Race",   ha="left", va="top", fontsize=22, fontweight="black", color=FG)
    fig.add_artist(plt.Line2D([0.06, 0.94], [0.895, 0.895],
                               transform=fig.transFigure, color="#1e3a5f", linewidth=0.8))
    fig.text(0.06, 0.877, "GW", ha="left", va="top", fontsize=7, color=DIM,
             fontfamily=MONO, fontweight="bold")
    gw_num_txt = fig.text(0.115, 0.882, "01", ha="left", va="top",
                          fontsize=26, fontweight="black", color=FG, fontfamily=MONO)
    fig.text(0.33, 0.877, f"/ {total_gws:02d}", ha="left", va="top",
             fontsize=14, color=DIM, fontfamily=MONO)

    ax_prog = fig.add_axes([0.06, 0.860, 0.88, 0.008])
    ax_prog.set_facecolor("#1e2a3a"); ax_prog.set_xlim(0, 1); ax_prog.set_ylim(0, 1); ax_prog.axis("off")
    prog_bar = ax_prog.barh(0.5, 0, height=1.0, color=ACCENT, left=0)[0]

    ax = fig.add_axes([0.06, 0.06, 0.88, 0.79])
    ax.set_facecolor(BG)
    fig.canvas.draw()

    def update(fi: int) -> None:
        ax.clear()
        ax.set_facecolor(BG)
        vals = vals_list[fi]
        rnks = rnks_list[fi]
        gw   = int(round(gw_labels[fi]))

        gw_num_txt.set_text(f"{gw:02d}")
        prog_bar.set_width(gw / total_gws)

        top_teams = rnks[rnks <= top_n].sort_values()
        max_val   = float(vals.max()) if not vals.empty else 1.0
        x_min = -max_val * 0.52
        x_max =  max_val * 1.22
        ax.set_xlim(x_min, x_max); ax.set_ylim(-0.8, top_n + 0.3)
        ax.set_yticks([]); ax.set_xticks([])
        for sp in ax.spines.values(): sp.set_visible(False)

        ax.text(x_max * 0.995, top_n + 0.1, "TOTAL POINTS",
                ha="right", va="center", fontsize=5.5, color=ACCENT, fontweight="bold", fontfamily=MONO)

        for team, rank_val in top_teams.items():
            val      = float(vals[team])
            yc       = top_n - rank_val
            yb       = yc - BAR_H / 2
            rank_int = int(round(rank_val))
            color    = team_color.get(team, "#888")
            manager  = mgr.get(team, "")
            is_top   = rank_int == 1

            ax.barh(yc, x_max - x_min, height=0.78, left=x_min,
                    color=TRACK, edgecolor="none", linewidth=0, zorder=1)

            if rank_int <= 3:
                badge_clr, badge_lbl, fsize = RANK_COLORS[rank_int - 1], RANK_SYMBOLS[rank_int - 1], 11
            else:
                badge_clr, badge_lbl, fsize = DIM, str(rank_int), 10
            ax.text(x_min + max_val * 0.02, yc, badge_lbl,
                    ha="left", va="center", fontsize=fsize, fontweight="bold", color=badge_clr, zorder=3)

            div_x = x_min + max_val * 0.095
            ax.plot([div_x, div_x], [yc - 0.32, yc + 0.32], color="#1e3a5f", linewidth=1.0, zorder=3)

            name_x = div_x + max_val * 0.015
            ax.text(name_x, yc + 0.13, manager if manager else team,
                    ha="left", va="center", fontsize=8, fontweight="bold", color=color, zorder=3)
            if manager:
                ax.text(name_x, yc - 0.19, team,
                        ha="left", va="center", fontsize=6.5, color=DIM, zorder=3)

            if val > max_val * 0.01:
                ax.imshow(grad_imgs[team], extent=[0, val, yb, yb + BAR_H], aspect="auto", zorder=2)

            if is_top and val > max_val * 0.15:
                ax.text(val * 0.05, yc, "Leader",
                        ha="left", va="center", fontsize=6.5,
                        fontweight="bold", color=(0, 0, 0, 0.45), zorder=4)

            pts_clr = ACCENT if is_top else FG
            ax.text(max_val * 1.17, yc + 0.12, f"{int(round(val)):,}",
                    ha="right", va="center", fontsize=9, fontweight="bold",
                    color=pts_clr, fontfamily=MONO, zorder=3)

            gw_score = int(round(float(df_gw.loc[gw, team]))) if gw in df_gw.index and team in df_gw.columns else 0
            if gw_score > 0:
                ax.text(max_val * 1.17, yc - 0.20, f"+{gw_score}",
                        ha="right", va="center", fontsize=6, color=DIM, fontfamily=MONO, zorder=3)

        if progress_cb:
            progress_cb(fi + 1, n_frames)

    animation = anim.FuncAnimation(fig, update, frames=n_frames, interval=1000 / FPS, blit=False)
    writer    = anim.FFMpegWriter(fps=FPS, codec="libx264", bitrate=4000,
                                  extra_args=["-pix_fmt", "yuv420p", "-preset", "fast"])
    animation.save(str(output_path), writer=writer, dpi=144)
    plt.close(fig)
