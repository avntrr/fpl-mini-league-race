import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion } from "motion/react";
import { Play, Pause, RotateCcw, Loader2, ChevronLeft, Sun, Moon } from "lucide-react";
import { Link } from "react-router";

/* ── Types ───────────────────────────────────────────────────────────────── */
interface GwDataPoint {
  gw:             number;
  overallRank:    number;
  percentileRank: number;
  totalPoints:    number;
  gwPoints:       number;
}

interface RankData {
  managerName:    string;
  teamName:       string;
  region:         string;
  totalManagers:  number;
  gwData:         GwDataPoint[];
}

import { THEMES, THEME_KEY } from "./theme";
import type { Theme, Tk } from "./theme";

/* ── RankPage-specific bar opacity tokens ────────────────────────────────── */
const BAR_THRESH: Record<Theme, number> = { dark: 0.28, light: 0.55 };
const BAR_MGR:    Record<Theme, number> = { dark: 0.88, light: 0.90 };

/* ── Constants ───────────────────────────────────────────────────────────── */
const SH       = 52;
const SG       = 10;
const FRAME_MS = 33;

const SPEEDS = [
  { label: "1×", stepsPerGw: 26 },
  { label: "2×", stepsPerGw: 13 },
  { label: "4×", stepsPerGw:  5 },
];

const RANK_LEVELS = [
  { label: "Top 1K",    rank: 1_000,     color: "#10b981" },
  { label: "Top 10K",   rank: 10_000,    color: "#14b8a6" },
  { label: "Top 50K",   rank: 50_000,    color: "#38bdf8" },
  { label: "Top 100K",  rank: 100_000,   color: "#818cf8" },
  { label: "Top 250K",  rank: 250_000,   color: "#a855f7" },
  { label: "Top 500K",  rank: 500_000,   color: "#f472b6" },
  { label: "Top 1M",    rank: 1_000_000, color: "#fb923c" },
  { label: "Top 5M",    rank: 5_000_000, color: "#64748b" },
] as const;

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function rankToPct(rank: number, total: number): number {
  if (rank <= 1) return 98;
  const pct = (Math.log(total) - Math.log(rank)) / Math.log(total) * 100;
  return Math.max(2, Math.min(98, pct));
}

function fmtRank(r: number): string {
  return "#" + Math.round(r).toLocaleString();
}

/* ── Theme toggle button (reusable) ─────────────────────────────────────── */
function ThemeToggle({ theme, onToggle, tk }: { theme: Theme; onToggle: () => void; tk: Tk }) {
  return (
    <button
      onClick={onToggle}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        background:   "none",
        border:       `1px solid ${tk.border}`,
        borderRadius: 8,
        padding:      "6px 8px",
        cursor:       "pointer",
        color:        tk.dim,
        display:      "flex",
        alignItems:   "center",
        transition:   "color 0.2s, border-color 0.2s",
      }}
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

/* ── Component ───────────────────────────────────────────────────────────── */
export default function RankPage() {
  /* Theme */
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem(THEME_KEY) as Theme) ?? "dark"
  );
  const tk = THEMES[theme];
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  /* Data */
  const [phase,    setPhase]    = useState<"form" | "loading" | "ready" | "error">("form");
  const [entryId,  setEntryId]  = useState("");
  const [rankData, setRankData] = useState<RankData | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  /* Playback */
  const [gw,      setGw]   = useState<number>(1);
  const [playing, setPlay] = useState(false);
  const [spd,     setSpd]  = useState(0);
  const tick = useRef<ReturnType<typeof setInterval>>();

  const totalGws = rankData?.gwData.length ?? 38;

  /* ── Fetch ── */
  const fetchData = async () => {
    if (!entryId.trim()) return;
    setPhase("loading");
    try {
      const res  = await fetch(`/api/rank?entry_id=${entryId}`);
      const json = await res.json();
      if (json.error) { setErrorMsg(json.error); setPhase("error"); return; }
      setRankData(json);
      setPhase("ready");
    } catch {
      setErrorMsg("Failed to connect to server.");
      setPhase("error");
    }
  };

  useEffect(() => {
    if (rankData) { setGw(1); setPlay(false); }
  }, [rankData]);

  /* ── Timer ── */
  useEffect(() => {
    clearInterval(tick.current);
    if (!playing || !rankData) return;
    const gwStep = 1 / SPEEDS[spd].stepsPerGw;
    tick.current = setInterval(() =>
      setGw(g => {
        if (g >= totalGws) { setPlay(false); return totalGws; }
        return Math.min(totalGws, g + gwStep);
      }),
      FRAME_MS
    );
    return () => clearInterval(tick.current);
  }, [playing, spd, rankData, totalGws]);

  const toggle = useCallback(() => {
    if (gw >= totalGws && !playing) { setGw(1); setPlay(true); return; }
    setPlay(p => !p);
  }, [gw, playing, totalGws]);

  /* ── Frame ── */
  const frame = useMemo(() => {
    if (!rankData) return null;
    const n  = rankData.gwData.length;
    const fi = Math.max(0, Math.floor(gw) - 1);
    const ci = Math.min(n - 1, Math.ceil(gw) - 1);
    const t  = gw - Math.floor(gw);

    const dF = rankData.gwData[fi];
    const dC = rankData.gwData[ci];

    const rank        = dF.overallRank    * (1 - t) + dC.overallRank    * t;
    const totalPoints = dF.totalPoints    * (1 - t) + dC.totalPoints    * t;
    const percentile  = dF.percentileRank * (1 - t) + dC.percentileRank * t;
    const prevIdx     = Math.max(0, fi - 1);
    const gwImprove   = rankData.gwData[prevIdx].overallRank - dC.overallRank;

    const total = rankData.totalManagers;

    const threshBars = RANK_LEVELS
      .filter(lv => lv.rank <= total)
      .map(lv => ({
        id:        lv.label,
        label:     lv.label,
        rank:      lv.rank,
        pct:       rankToPct(lv.rank, total),
        color:     lv.color,
        isManager: false as const,
      }));

    const managerBar = {
      id:        "manager",
      label:     rankData.teamName,
      rank,
      pct:       rankToPct(rank, total),
      color:     tk.accent,
      isManager: true as const,
    };

    const all = [...threshBars, managerBar].sort((a, b) => a.rank - b.rank);

    return { rank, totalPoints, percentile, gwImprove, all };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gw, rankData, tk.accent]);

  const gwInt    = Math.floor(gw);
  const isFinale = gw >= totalGws;
  const progPct  = `${(gw / totalGws) * 100}%`;

  /* shared font shortcuts */
  const mono    = "'JetBrains Mono', monospace";
  const condensed = "'Barlow Condensed', sans-serif";

  /* ════════════════════════════════════════════════════
     Phase: FORM
  ════════════════════════════════════════════════════ */
  if (phase === "form") return (
    <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  padding: 24, fontFamily: condensed, transition: "background 0.3s, color 0.3s" }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        {/* top row: back + theme toggle */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <Link to="/"
            style={{ color: tk.dim, fontFamily: mono, fontSize: "0.625rem",
                     letterSpacing: "0.2em", textTransform: "uppercase",
                     display: "flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
            <ChevronLeft size={10} /> Mini League Race
          </Link>
          <ThemeToggle theme={theme} onToggle={toggleTheme} tk={tk} />
        </div>

        <p style={{ color: tk.accent, fontFamily: mono, fontSize: "0.625rem",
                    letterSpacing: "0.3em", textTransform: "uppercase", marginBottom: "0.5rem" }}>
          Fantasy Premier League
        </p>
        <h1 style={{ fontWeight: 900, textTransform: "uppercase", fontSize: "3rem", lineHeight: 1, margin: 0 }}>Global</h1>
        <h1 style={{ fontWeight: 900, textTransform: "uppercase", fontSize: "3rem", lineHeight: 1, margin: 0 }}>Rank</h1>
        <h1 style={{ fontWeight: 900, textTransform: "uppercase", fontSize: "3rem", lineHeight: 1, marginBottom: 32 }}>Journey</h1>

        <div style={{ height: 1, marginBottom: 32,
                      background: `linear-gradient(to right, ${tk.accent}60, ${tk.text}20, transparent)` }} />

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <label style={{ display: "block", marginBottom: 8, color: tk.dim,
                            fontFamily: mono, fontSize: "0.625rem",
                            letterSpacing: "0.2em", textTransform: "uppercase" }}>
              FPL Manager ID
            </label>
            <input
              type="number"
              value={entryId}
              onChange={e => setEntryId(e.target.value)}
              onKeyDown={e => e.key === "Enter" && fetchData()}
              placeholder="e.g. 8130326"
              style={{ width: "100%", background: "transparent", border: `1px solid ${tk.border}`,
                       borderRadius: 6, padding: "12px 16px", color: tk.text, fontSize: "1.1rem",
                       fontWeight: 700, outline: "none", boxSizing: "border-box", fontFamily: mono }}
            />
            <p style={{ marginTop: 6, color: tk.dim, fontFamily: mono, fontSize: "0.625rem" }}>
              fpl.premierleague.com/entry/<span style={{ color: tk.accent }}>XXXXXXX</span>/history
            </p>
          </div>
          <button onClick={fetchData}
            style={{ width: "100%", padding: "12px 0", borderRadius: 6, border: "none",
                     background: tk.accent, color: tk.accentFg, fontWeight: 900,
                     fontSize: "1rem", letterSpacing: "0.15em", textTransform: "uppercase",
                     cursor: "pointer", fontFamily: condensed }}>
            Generate →
          </button>
        </div>
      </div>
    </div>
  );

  /* ════════════════════════════════════════════════════
     Phase: LOADING
  ════════════════════════════════════════════════════ */
  if (phase === "loading") return (
    <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: mono, transition: "background 0.3s" }}>
      <div style={{ textAlign: "center" }}>
        <Loader2 size={32} className="animate-spin" style={{ color: tk.accent, margin: "0 auto 16px" }} />
        <p style={{ color: tk.dim, fontSize: "0.75rem", letterSpacing: "0.2em", textTransform: "uppercase" }}>
          Fetching rank data...
        </p>

      </div>
    </div>
  );

  /* ════════════════════════════════════════════════════
     Phase: ERROR
  ════════════════════════════════════════════════════ */
  if (phase === "error") return (
    <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "#f87171", marginBottom: 16 }}>{errorMsg}</p>
        <button onClick={() => setPhase("form")}
          style={{ background: "none", border: "none", color: tk.dim, cursor: "pointer",
                   display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: "0.75rem" }}>
          <ChevronLeft size={12} /> Back
        </button>
      </div>
    </div>
  );

  /* ════════════════════════════════════════════════════
     Phase: READY
  ════════════════════════════════════════════════════ */
  if (!frame || !rankData) return null;

  const { rank, totalPoints, percentile, gwImprove, all } = frame;
  const barContainerH = all.length * (SH + SG) - SG;

  return (
    <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                  fontFamily: condensed, transition: "background 0.3s, color 0.3s" }}>
      <div style={{ maxWidth: 672, margin: "0 auto", padding: "32px 16px 48px" }}>

        {/* ── Header ── */}
        <motion.header initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }} style={{ marginBottom: 40 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
            <p style={{ color: tk.accent, fontFamily: mono, fontSize: "0.625rem",
                        letterSpacing: "0.3em", textTransform: "uppercase", margin: 0 }}>
              Fantasy Premier League · {rankData.region}
            </p>
            <ThemeToggle theme={theme} onToggle={toggleTheme} tk={tk} />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
            <h1 style={{ fontWeight: 900, textTransform: "uppercase", lineHeight: 1, margin: 0,
                         fontSize: "clamp(2.5rem, 10vw, 4.5rem)" }}>
              Global<br />Rank<br />Journey
            </h1>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{ fontSize: "0.75rem", color: tk.dim, letterSpacing: "0.1em",
                          textTransform: "uppercase", margin: 0 }}>Season</p>
              <p style={{ fontSize: "1.5rem", fontWeight: 900, margin: 0 }}>2024/25</p>
            </div>
          </div>
          <div style={{ height: 1, marginTop: 16,
                        background: `linear-gradient(to right, ${tk.accent}60, ${tk.text}20, transparent)` }} />
        </motion.header>

        {/* ── GW counter + progress ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
          <p style={{ color: tk.dim, fontFamily: mono, fontSize: "0.625rem",
                      letterSpacing: "0.2em", textTransform: "uppercase", flexShrink: 0, margin: 0 }}>GW</p>
          <motion.span key={gwInt}
            initial={{ color: tk.accent, scale: 1.18 }} animate={{ color: tk.text, scale: 1 }}
            transition={{ duration: 0.3 }}
            style={{ fontFamily: mono, fontSize: "3rem", fontWeight: 900,
                     lineHeight: 1, minWidth: "3ch", display: "block" }}>
            {String(gwInt).padStart(2, "0")}
          </motion.span>
          <span style={{ color: tk.dim, fontSize: "1.25rem", marginRight: 4 }}>
            /{String(totalGws).padStart(2, "0")}
          </span>
          <div style={{ flex: 1, position: "relative", height: 2,
                        background: tk.border, borderRadius: 2, overflow: "hidden" }}>
            <motion.div style={{ position: "absolute", inset: "0 auto 0 0", background: tk.accent, borderRadius: 2 }}
              animate={{ width: progPct }} transition={{ duration: 0.55 }} />
          </div>
        </div>

        {/* ── Manager info ── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }} style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.04em",
                          fontSize: "1.35rem", color: tk.accent, margin: 0,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {rankData.managerName}
              </p>
              <p style={{ color: tk.dim, fontSize: "0.9rem", margin: 0 }}>{rankData.teamName}</p>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{ fontFamily: mono, fontWeight: 900, lineHeight: 1,
                          fontSize: "clamp(1.4rem,5vw,2rem)", color: tk.accent, margin: 0 }}>
                {fmtRank(rank)}
              </p>
              <p style={{ color: tk.textSub, fontFamily: mono, fontSize: "0.625rem", marginTop: 2 }}>
                of {rankData.totalManagers.toLocaleString()}
              </p>
              {gwImprove !== 0 && gwInt > 1 && (
                <p style={{ fontFamily: mono, fontSize: "0.7rem", fontWeight: 700, margin: 0,
                            color: gwImprove > 0 ? "#4ade80" : "#f87171" }}>
                  {gwImprove > 0 ? "▲" : "▼"} {Math.abs(Math.round(gwImprove)).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── Bar Chart Race ── */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
          style={{ position: "relative", height: barContainerH, marginBottom: 32 }}>

          {all.map((bar, idx) => {
            const y = idx * (SH + SG);
            return (
              <motion.div
                key={bar.id}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: SH }}
                animate={{ y }}
                transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
              >
                <div style={{
                  position:        "relative",
                  height:          "100%",
                  borderRadius:    6,
                  overflow:        "hidden",
                  backgroundColor: tk.surface,
                  border:          bar.isManager ? `1px solid ${tk.accent}40` : `1px solid transparent`,
                }}>
                  {/* Fill */}
                  <motion.div
                    initial={false}
                    animate={{ width: `${bar.pct}%` }}
                    transition={bar.isManager
                      ? { duration: 0.55, ease: [0.4, 0, 0.2, 1] }
                      : { duration: 0 }}
                    style={{
                      position:        "absolute",
                      top: 0, bottom: 0, left: 0,
                      borderRadius:    "5px 0 0 5px",
                      backgroundColor: bar.color,
                      opacity:         bar.isManager ? BAR_MGR[theme] : BAR_THRESH[theme],
                      boxShadow:       bar.isManager ? `0 0 18px ${tk.accent}50` : "none",
                    }}
                  />

                  {/* Labels */}
                  <div style={{
                    position:       "absolute", inset: 0,
                    display:        "flex", alignItems: "center",
                    justifyContent: "space-between",
                    padding:        "0 0.8rem",
                    pointerEvents:  "none",
                  }}>
                    <span style={{
                      fontFamily:    condensed,
                      fontWeight:    bar.isManager ? 900 : 700,
                      fontSize:      bar.isManager ? "1rem" : "0.88rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color:         bar.isManager ? tk.accent : tk.text,
                      textShadow:    theme === "dark" ? "0 1px 6px rgba(0,0,0,0.7)" : "none",
                    }}>
                      {bar.label}
                    </span>
                    <span style={{
                      fontFamily:  mono,
                      fontSize:    bar.isManager ? "0.75rem" : "0.65rem",
                      fontWeight:  bar.isManager ? 700 : 400,
                      color:       bar.isManager ? tk.accent : tk.textSub,
                      textShadow:  theme === "dark" ? "0 1px 6px rgba(0,0,0,0.7)" : "none",
                    }}>
                      {fmtRank(Math.round(bar.rank))}
                    </span>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* ── Stats ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 24,
                      marginBottom: 32, paddingTop: 12,
                      borderTop: `1px solid ${tk.border}` }}>
          <div>
            <p style={{ color: tk.dim, fontFamily: mono, fontSize: "0.56rem",
                        letterSpacing: "0.15em", textTransform: "uppercase", margin: 0 }}>Total Points</p>
            <p style={{ fontFamily: mono, fontSize: "1.25rem", fontWeight: 900,
                        color: tk.text, margin: 0 }}>
              {Math.round(totalPoints).toLocaleString()}
            </p>
          </div>
          <div style={{ width: 1, height: 32, background: tk.border }} />
          <div>
            <p style={{ color: tk.dim, fontFamily: mono, fontSize: "0.56rem",
                        letterSpacing: "0.15em", textTransform: "uppercase", margin: 0 }}>Top %</p>
            <p style={{ fontFamily: mono, fontSize: "1.25rem", fontWeight: 900,
                        color: tk.accent, margin: 0 }}>
              {percentile.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* ── Playback controls ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                      paddingTop: 20, borderTop: `1px solid ${tk.border}` }}>
          <button onClick={() => { setPlay(false); setGw(1); }}
            style={{ padding: 8, background: "none", border: "none",
                     cursor: "pointer", color: tk.dim }}>
            <RotateCcw size={15} />
          </button>
          <button onClick={toggle}
            style={{ display: "flex", alignItems: "center", gap: 8,
                     padding: "8px 20px", borderRadius: 6, border: "none",
                     background: tk.accent, color: tk.accentFg,
                     fontWeight: 900, fontSize: "0.875rem",
                     letterSpacing: "0.1em", textTransform: "uppercase",
                     cursor: "pointer", fontFamily: condensed }}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
            <span>{playing ? "Pause" : isFinale ? "Replay" : "Play"}</span>
          </button>
          <div style={{ display: "flex", gap: 4 }}>
            {SPEEDS.map((s, i) => (
              <button key={s.label} onClick={() => setSpd(i)}
                style={{
                  padding:         "5px 10px",
                  borderRadius:    5,
                  border:          "none",
                  background:      spd === i ? `${tk.accent}22` : "transparent",
                  color:           spd === i ? tk.accent : tk.dim,
                  fontFamily:      mono,
                  fontSize:        "0.7rem",
                  fontWeight:      700,
                  cursor:          "pointer",
                }}>
                {s.label}
              </button>
            ))}
          </div>
          <input type="range" min={1} max={totalGws} value={gwInt}
            onChange={e => { setPlay(false); setGw(Number(e.target.value)); }}
            style={{ flex: 1, minWidth: 80, accentColor: tk.accent } as React.CSSProperties} />
          <span style={{ fontFamily: mono, fontSize: "0.625rem", color: tk.dim }}>
            GW{String(gwInt).padStart(2, "0")}
          </span>
        </div>

        {/* ── Footer nav ── */}
        <div style={{ display: "flex", alignItems: "center", marginTop: 16 }}>
          <button onClick={() => { setPhase("form"); setPlay(false); }}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none",
                     border: "none", color: tk.dim, cursor: "pointer",
                     fontFamily: mono, fontSize: "0.75rem" }}>
            <ChevronLeft size={12} /> Change manager
          </button>
          <div style={{ flex: 1 }} />
          <Link to="/"
            style={{ color: tk.dim, fontFamily: mono, fontSize: "0.75rem",
                     textDecoration: "none" }}>
            Mini League Race →
          </Link>
        </div>

      </div>
    </div>
  );
}
