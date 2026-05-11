/**
 * Remotion video component for FPL Bar Chart Race.
 *
 * Key difference from web app (App.tsx):
 * - Uses useCurrentFrame() instead of Framer Motion / time-based animation
 * - Every frame is deterministic: frame N always looks the same
 * - Rank positions interpolated explicitly with easing → smooth slide guaranteed
 * - No fake clock, no screenshot timing issues
 */
import React, { useRef, useEffect } from "react";
import { useCurrentFrame, useVideoConfig, Easing } from "remotion";

/* ── Types ─────────────────────────────────────────────────────────────────── */
interface Manager {
  id: string;
  name: string;
  team: string;
  color: string;
}

export interface FplData {
  leagueName: string;
  totalGws: number;
  topN?: number;
  managers: Manager[];
  scores: number[][];   // [managerIdx][gwIdx] cumulative
  gwScores: number[][]; // [managerIdx][gwIdx] per-GW
}

export interface RaceProps {
  data: FplData;
  theme: "dark" | "light";
  speed: number;  // 0=1x  1=2x  2=4x
  topN: number;
  fps: number;    // 30 or 60
}

/* ── Constants ──────────────────────────────────────────────────────────────── */
const STEPS_TABLE: Record<number, number[]> = {
  30: [26, 13, 5],
  60: [52, 26, 10],
};

const HOLD_FRAMES = 45; // 1.5s hold at end

/* ── Themes ─────────────────────────────────────────────────────────────────── */
const THEMES = {
  dark: {
    bg:          "#0a0e1a",
    text:        "#e2e8f0",
    dim:         "#64748b",
    accent:      "#00d4aa",
    border:      "rgba(255,255,255,0.08)",
    card:        "rgba(255,255,255,0.04)",
    barOpTop:    0.9,
    barOpOther:  0.6,
  },
  light: {
    bg:          "#f8fafc",
    text:        "#0f172a",
    dim:         "#94a3b8",
    accent:      "#0ea5e9",
    border:      "rgba(0,0,0,0.08)",
    card:        "#ffffff",
    barOpTop:    0.9,
    barOpOther:  0.6,
  },
};

/* ── Dot Wave Background ────────────────────────────────────────────────────── */
// Renders deterministically from frame number — no rAF loop needed.
// Formula ported from tfrere/xPavRR (THREE.js CanvasRenderer).
function DotWave({ frame, fps, theme }: { frame: number; fps: number; theme: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Logical 540×960 — Remotion's scale:2 handles the 2× output
    const W = 540, H = 960;
    canvas.width  = W;
    canvas.height = H;

    const SPACING = 24;
    const R_MIN   = 0.3;
    const R_MAX   = 3.8;
    const cols = Math.ceil(W / SPACING) + 2;
    const rows = Math.ceil(H / SPACING) + 2;
    const dot = theme === "dark" ? "255,255,255" : "0,0,0";

    const t     = frame / fps;
    const count = t * 1.5;

    ctx.clearRect(0, 0, W, H);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * SPACING;
        const y = row * SPACING;

        const wRow = Math.sin((row - count) * 0.3);
        const wCol = Math.sin((col - count * 0.6) * 0.5);
        const norm = ((wRow + 1) * 4 + (wCol + 1) * 4) / 16; // 0..1

        const r     = R_MIN + norm * (R_MAX - R_MIN);
        const alpha = (0.025 + norm * 0.23).toFixed(3);

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${dot},${alpha})`;
        ctx.fill();
      }
    }
  }); // runs every React render (= every Remotion frame)

  return (
    <canvas
      ref={ref}
      style={{
        position: "absolute", top: 0, left: 0,
        width: "100%", height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

/* ── Rank helper ────────────────────────────────────────────────────────────── */
function getRankAt(data: FplData, gw: number, topN: number): Record<string, number> {
  const gwIdx = Math.max(0, Math.min(gw - 1, data.totalGws - 1));
  const sorted = data.managers
    .map((m, i) => ({ id: m.id, score: data.scores[i]?.[gwIdx] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return Object.fromEntries(sorted.map((m, i) => [m.id, i]));
}

/* ── Main Race Component ────────────────────────────────────────────────────── */
export function Race({ data, theme, speed, topN, fps: fpsProp }: RaceProps) {
  const frame             = useCurrentFrame();
  const { fps }           = useVideoConfig();
  const tk                = THEMES[theme] ?? THEMES.dark;
  const stepsPerGw        = (STEPS_TABLE[fps] ?? STEPS_TABLE[30])[Math.max(0, Math.min(speed, 2))];
  const totalGws          = data.totalGws;
  const mainFrames        = totalGws * stepsPerGw; // total frames before hold

  // ── Which GW segment are we in? ─────────────────────────────────────────────
  // Frame 0 .. stepsPerGw-1          : hold at GW1 (no transition)
  // Frame stepsPerGw .. 2*s-1        : transition GW1 → GW2
  // Frame k*s .. (k+1)*s-1           : transition GWk → GW(k+1)
  // Frame mainFrames ..              : hold at final GW
  let gwFrom: number, gwTo: number, t: number;
  if (frame < stepsPerGw) {
    gwFrom = 1; gwTo = 1; t = 0;
  } else if (frame >= mainFrames) {
    gwFrom = totalGws; gwTo = totalGws; t = 1;
  } else {
    const adjusted  = frame - stepsPerGw;
    const seg       = Math.floor(adjusted / stepsPerGw);
    t               = (adjusted % stepsPerGw) / stepsPerGw;
    gwFrom          = seg + 1;
    gwTo            = Math.min(seg + 2, totalGws);
  }

  // ── Eased t for rank position transition ─────────────────────────────────────
  const easedT = Easing.inOut(Easing.ease)(t);

  // ── Interpolated scores (smooth bar growth) ──────────────────────────────────
  const scores = data.managers.map((_, i) => {
    const sF = data.scores[i]?.[gwFrom - 1] ?? 0;
    const sT = data.scores[i]?.[gwTo   - 1] ?? 0;
    return sF + (sT - sF) * t;
  });

  // ── Rank positions at gwFrom and gwTo ────────────────────────────────────────
  const rankFrom = getRankAt(data, gwFrom, topN);
  const rankTo   = getRankAt(data, gwTo,   topN);

  // ── Fixed max score (across all GWs → bars grow continuously) ────────────────
  const finalMaxScore = Math.max(
    ...data.managers.map((_, i) => data.scores[i]?.[totalGws - 1] ?? 0),
    1,
  );

  // ── Layout constants (designed for 540px logical width) ──────────────────────
  const SH = 68, SG = 4;        // row height, gap
  const rBadge  = 36;
  const rIndent = 74;
  const rScore  = 72;
  const fName   = 16;
  const fTeam   = 10;
  const fScore  = 15;
  const mono    = "'JetBrains Mono', monospace";
  const cond    = "'Barlow Condensed', sans-serif";

  const gwDisplay    = gwFrom;
  const progressPct  = `${(gwDisplay / totalGws) * 100}%`;
  const chartH       = topN * (SH + SG) - SG;

  return (
    <div style={{
      width: 540, height: 960,
      position: "relative",
      overflow: "hidden",
      background: "transparent",
    }}>
      {/* ── Dot wave fills full 540×960 ── */}
      <DotWave frame={frame} fps={fps} theme={theme} />

      {/* ── Content at 85% scale (matches web screenshotter) ── */}
      <div style={{
        position:        "absolute",
        inset:           0,
        transform:       "scale(0.85)",
        transformOrigin: "center center",
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
      }}>
        <div style={{ width: "100%", padding: "8px 16px", fontFamily: cond, color: tk.text }}>

          {/* ── Header ── */}
          <div style={{ marginBottom: 14 }}>
            <p style={{
              color: tk.accent, fontSize: 16, fontWeight: 700,
              letterSpacing: "0.05em", textTransform: "uppercase", margin: 0,
            }}>
              Fantasy Premier League
            </p>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <p style={{ color: tk.dim, fontSize: 16, letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>
                {data.leagueName}
              </p>
              <p style={{ fontSize: 16, color: tk.dim, margin: 0 }}>GAMEWEEK</p>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <h1 style={{ fontWeight: 900, textTransform: "uppercase", fontSize: 56, lineHeight: 1, margin: 0 }}>
                Season Race
              </h1>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span style={{ fontFamily: cond, fontSize: 56, fontWeight: 900, lineHeight: 1, color: tk.text }}>
                  {String(gwDisplay).padStart(2, "0")}
                </span>
                <span style={{ fontFamily: cond, fontSize: 16, fontWeight: 700, color: tk.dim }}>
                  /{String(totalGws).padStart(2, "0")}
                </span>
              </div>
            </div>

            {/* Progress bar */}
            <div style={{
              position: "relative", height: 2, marginTop: 12,
              background: tk.border, borderRadius: 2, overflow: "hidden",
            }}>
              <div style={{
                position: "absolute", inset: "0 auto 0 0",
                width: progressPct, background: tk.accent, borderRadius: 2,
              }} />
            </div>
          </div>

          {/* ── Folder tab ── */}
          <div style={{ position: "relative", paddingTop: 32 }}>
            <div style={{
              position: "absolute", top: 0, right: 0,
              width: 96, height: 32,
              backgroundColor: theme === "dark" ? "rgba(255,255,255,0.06)" : "#ffffff",
              borderRadius: "6px 6px 0 0",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ fontFamily: cond, fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: tk.text }}>
                2025/26
              </span>
            </div>

            {/* ── Card ── */}
            <div style={{
              borderRadius: "10px 0 10px 10px",
              backgroundColor: tk.card,
              padding: "4px 10px",
            }}>
              <div style={{ height: chartH, position: "relative" }}>

                {data.managers.map((m, i) => {
                  const rf = rankFrom[m.id] ?? 999;
                  const rt = rankTo[m.id]   ?? 999;
                  // Skip if off-screen in both frames
                  if (rf >= topN && rt >= topN) return null;

                  // ── Smooth rank position (key animation!) ──
                  // rf→rt interpolated with ease-in-out over stepsPerGw frames
                  const rankPos = rf + (rt - rf) * easedT;
                  const y       = rankPos * (SH + SG);

                  const score    = scores[i];
                  const pct      = (score / finalMaxScore) * 100;
                  const isTop    = rf === 0 || rt === 0;
                  const gwScore  = data.gwScores[i]?.[gwFrom - 1] ?? 0;
                  const dispRank = Math.round(rankPos) + 1;

                  return (
                    <div
                      key={m.id}
                      style={{
                        position: "absolute", top: 0, left: 0, right: 0,
                        height: SH,
                        transform: `translateY(${y}px)`,
                        display: "flex", flexDirection: "column", justifyContent: "center",
                        paddingTop: 10, paddingBottom: 10,
                        borderBottom: `1px solid ${tk.border}`,
                      }}
                    >
                      {/* Top row: badge + name/team */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{
                          width: rBadge, height: rBadge, flexShrink: 0,
                          borderRadius: Math.round(rBadge * 0.22),
                          backgroundColor: m.color,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <span style={{ fontSize: Math.round(rBadge * 0.45), fontWeight: 900, color: "#fff", fontFamily: mono }}>
                            {dispRank}
                          </span>
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: fName, fontWeight: 700,
                            textTransform: "uppercase", letterSpacing: "0.04em",
                            color: tk.text, whiteSpace: "nowrap",
                          }}>
                            {m.name}
                          </div>
                          <div style={{
                            fontSize: fTeam,
                            color: theme === "dark" ? "#a3a3a3" : "#374151",
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          }}>
                            {m.team}
                          </div>
                        </div>
                      </div>

                      {/* Bottom row: bar + score */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: rIndent }}>
                        {/* Bar track */}
                        <div style={{
                          flex: 1, position: "relative", height: 18,
                          borderRadius: 4, overflow: "hidden",
                        }}>
                          <div style={{
                            position: "absolute", inset: "0 auto 0 0",
                            width: `${pct}%`,
                            borderRadius: 4, overflow: "hidden",
                            boxShadow: isTop ? `0 0 16px ${m.color}55` : "none",
                          }}>
                            <div style={{
                              position: "absolute", inset: 0,
                              backgroundColor: m.color,
                              opacity: isTop ? tk.barOpTop : tk.barOpOther,
                            }} />
                            {gwScore > 0 && (
                              <span style={{
                                position: "absolute", right: 7,
                                top: "50%", transform: "translateY(-50%)",
                                fontSize: 10, fontWeight: 900,
                                color: "rgba(255,255,255,0.9)",
                                fontFamily: mono, pointerEvents: "none",
                                whiteSpace: "nowrap",
                              }}>
                                +{gwScore}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Total score */}
                        <div style={{
                          textAlign: "right", width: rScore, flexShrink: 0,
                          fontFamily: mono, fontSize: fScore, fontWeight: 900,
                          color: isTop ? tk.accent : tk.text,
                        }}>
                          {Math.round(score).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
