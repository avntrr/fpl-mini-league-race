import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion } from "motion/react";
import { Play, Pause, RotateCcw, Trophy, Download, Loader2, ChevronLeft, Sun, Moon, ChevronUp, ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { THEMES, THEME_KEY } from "./theme";
import type { Theme } from "./theme";

/* ── Types ───────────────────────────────────────────────────────────────── */
interface Manager {
  id: string;
  name: string;   // manager name (coloured)
  team: string;   // team name (dim)
  color: string;
}

interface FplData {
  leagueName: string;
  totalGws: number;
  topN?: number;
  managers: Manager[];
  scores: number[][];    // [managerIdx][gwIdx] cumulative points
  gwScores: number[][];  // [managerIdx][gwIdx] per-GW points
  regionsMap?: Record<string, string>; // team_name → ISO 2-letter code (Global only)
}

// FPL uses non-standard codes for UK nations.
// England/Scotland/Wales have their own subdivision flag emojis (tag characters).
// Northern Ireland has no official emoji → use 🇬🇧.
const FPL_FLAG_OVERRIDES: Record<string, string> = {
  EN: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // 🏴󠁧󠁢󠁥󠁮󠁧󠁿
  SC: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}", // 🏴󠁧󠁢󠁳󠁣󠁴󠁿
  WA: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}", // 🏴󠁧󠁢󠁷󠁬󠁳󠁿
  NI: "\u{1F1EC}\u{1F1E7}",                                               // 🇬🇧
};

/** Convert 2-letter ISO code (or FPL custom code) to flag emoji. "ID" → 🇮🇩 */
const isoToFlag = (iso: string): string => {
  if (!iso) return "";
  const upper = iso.toUpperCase();
  if (upper in FPL_FLAG_OVERRIDES) return FPL_FLAG_OVERRIDES[upper];
  if (upper.length !== 2) return "";
  return upper.split("").map(c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  ).join("");
};

/* ── Constants ───────────────────────────────────────────────────────────── */
// SH/SG moved inside component — see below
const FRAME_MS = 33;

const SPEEDS = [
  { label: "1×", stepsPerGw: 26 },
  { label: "2×", stepsPerGw: 13 },
  { label: "4×", stepsPerGw:  5 },
];

const RANK_COLORS = ["#F9CE64", "#B1B0B6", "#E68D3F"];
const RANK_GLYPHS = ["①", "②", "③"];
const TOP_N_OPTIONS = [5, 8, 10, 15, 20];

/* ── App ─────────────────────────────────────────────────────────────────── */
export default function App() {
  // ── Capture mode (Playwright screenshot renderer) ──
  const captureMode = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("capture");

  const SG      = captureMode ? 4 : 6;

  // ── Theme — in capture mode read from URL (?theme=light), else localStorage ──
  const [theme, setTheme] = useState<Theme>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("capture")) return (params.get("theme") as Theme) ?? "dark";
    return (localStorage.getItem(THEME_KEY) as Theme) ?? "light";
  });
  const tk = THEMES[theme];
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  // ── UI phase ──
  type Mode = "global" | "nation" | "mini";
  const [phase, setPhase]       = useState<"form" | "loading" | "ready" | "error">("form");
  const [mode, setMode]         = useState<Mode>("mini");
  const [leagueId, setLeagueId] = useState("");
  const [country, setCountry]   = useState("Indonesia");
  const [countries, setCountries] = useState<string[]>([]);
  const [topN, setTopN]         = useState(10);
  const [fplData, setFplData]   = useState<FplData | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // ── Animation ──
  const [gw, setGw]             = useState<number>(1);
  const [_seekTick, setSeekTick] = useState(0);
  const [playing, setPlay]      = useState(false);
  const [spd, setSpd]           = useState(0);
  const tick                    = useRef<ReturnType<typeof setInterval>>();

  // ── Download state ──
  const [downloading, setDownloading] = useState(false);
  const [dlMsg, setDlMsg]             = useState("");

  // ── Responsive zoom for narrow mobile screens ──
  const [windowW, setWindowW] = useState(() => window.innerWidth);
  useEffect(() => {
    if (captureMode) return;
    const onResize = () => setWindowW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [captureMode]);
  // Scale down card when viewport < 440px (natural comfortable width)
  const webCardZoom = captureMode ? 1 : Math.min(1, (windowW - 32) / 440);

  const totalGws = fplData?.totalGws ?? 38;

  // Adaptive row height + card zoom for captureMode (fits 5–20 teams in 1080×1920)
  const _AVAIL_CH = 793; // px available for chart in 960px capture viewport
  const _BASE_SH  = captureMode ? 68 : 78;
  const _MIN_SH   = captureMode ? 34 : 44; // captureMode rows are much more compact
  const SH = captureMode
    ? Math.max(_MIN_SH, Math.min(_BASE_SH, Math.floor((_AVAIL_CH + SG) / topN) - SG))
    : _BASE_SH;
  const _rawCH       = topN * (SH + SG) - SG;
  const captureCardZoom = (captureMode && _rawCH > _AVAIL_CH) ? _AVAIL_CH / _rawCH : 1;
  // compact = video render with 15 or 20 teams → slim bars, no rank box
  const compact = captureMode && topN >= 15;

  // ── Capture mode: load fpl-data.json + expose window.__FPL_SEEK ──
  useEffect(() => {
    if (!captureMode) return;
    fetch("/fpl-data.json")
      .then(r => r.json())
      .then((d: FplData & { topN?: number }) => {
        setFplData(d);
        setTopN(d.topN ?? 10);
        setPhase("ready");
      })
      .catch(() => setPhase("error"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!captureMode) return;
    (window as any).__FPL_SEEK = (g: number) => {
      setSeekTick(t => t + 1);
      setGw(g);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!captureMode) return;
    (window as any).__FPL_READY = true;
  });

  // Sync html/body background to theme so mobile zoom gap matches app colour
  useEffect(() => {
    document.documentElement.style.background = tk.bg;
    document.body.style.background = tk.bg;
  }, [tk.bg]);

  useEffect(() => {
    if (fplData) { setGw(1); setPlay(false); }
  }, [fplData]);

  // ── Playback timer ──
  useEffect(() => {
    clearInterval(tick.current);
    if (!playing || !fplData || captureMode) return;
    const gwStep = 1 / SPEEDS[spd].stepsPerGw;
    tick.current = setInterval(() =>
      setGw(g => {
        if (g >= totalGws) { setPlay(false); return totalGws; }
        return Math.min(totalGws, g + gwStep);
      }),
      FRAME_MS
    );
    return () => clearInterval(tick.current);
  }, [playing, spd, fplData, totalGws, captureMode]);

  const toggle = useCallback(() => {
    if (gw >= totalGws && !playing) { setGw(1); setPlay(true); return; }
    setPlay(p => !p);
  }, [gw, playing, totalGws]);

  // ── Load country list on mount ──
  useEffect(() => {
    if (captureMode) return;
    fetch("/api/countries")
      .then(r => r.json())
      .then(d => setCountries(d.countries ?? []))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch ──
  const fetchData = async () => {
    if (mode === "mini" && !leagueId.trim()) return;
    setPhase("loading");
    try {
      const params = new URLSearchParams({ mode, top_n: String(topN) });
      if (mode === "mini") params.set("league_id", leagueId);
      if (mode === "nation") params.set("country", country);
      const res  = await fetch(`/api/data?${params}`);
      const json = await res.json();
      if (json.error) { setErrorMsg(json.error); setPhase("error"); return; }
      setFplData(json);
      setPhase("ready");
    } catch {
      setErrorMsg("Failed to connect to server.");
      setPhase("error");
    }
  };

  // ── Download MP4 ──
  const downloadMp4 = async () => {
    setDownloading(true);
    setDlMsg("Starting render...");
    try {
      const res  = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, league_id: leagueId, country, top_n: topN, speed: spd, theme }),
      });
      const { job_id, error } = await res.json();
      if (error) { setDlMsg("Error: " + error); setDownloading(false); return; }

      const poll = setInterval(async () => {
        const s = await fetch(`/status/${job_id}`).then(r => r.json());
        setDlMsg(s.message);
        if (s.status === "done") {
          clearInterval(poll);
          setDownloading(false);
          setDlMsg("");
          // Use <a download> for reliable mobile download
          const a = document.createElement("a");
          a.href = `/download/${s.filename}`;
          a.download = s.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } else if (s.status === "error") {
          clearInterval(poll);
          setDownloading(false);
          setDlMsg(`❌ ${s.message}`);
        }
      }, 2000);
    } catch {
      setDlMsg("Connection failed.");
      setDownloading(false);
    }
  };

  // ── Frame calc ──
  const frame = useMemo(() => {
    if (!fplData) return [];
    const gwFloor = Math.max(1, Math.floor(gw));
    const gwCeil  = Math.min(fplData.totalGws, Math.ceil(gw));
    const t       = gw - Math.floor(gw);
    return fplData.managers.map((m, i) => {
      const totalF = fplData.scores[i]?.[gwFloor - 1] ?? 0;
      const totalC = fplData.scores[i]?.[gwCeil  - 1] ?? 0;
      return {
        ...m,
        total:   totalF * (1 - t) + totalC * t,
        gwScore: fplData.gwScores[i]?.[gwFloor - 1] ?? 0,
      };
    });
  }, [gw, fplData]);

  const sorted   = useMemo(() => [...frame].sort((a, b) => b.total - a.total).slice(0, topN), [frame, topN]);
  const maxTot   = sorted[0]?.total ?? 1;
  // Fixed scale: highest total across ALL GWs so bars grow throughout the race
  const finalMaxTot = useMemo(() => {
    if (!fplData) return 1;
    const last = fplData.totalGws - 1;
    return Math.max(...fplData.managers.map((_, i) => fplData.scores[i]?.[last] ?? 0)) || 1;
  }, [fplData]);
  const CH       = sorted.length * (SH + SG) - SG;
  const rankOf   = useMemo(() => Object.fromEntries(sorted.map((m, i) => [m.id, i])), [sorted]);
  const gwInt    = Math.floor(gw);

  // Rank at previous integer GW — for rank-change indicators (↑↓●)
  const prevFrame = useMemo(() => {
    if (!fplData) return [];
    const prevGw = Math.max(1, gwInt - 1);
    return fplData.managers.map((m, i) => ({
      id:    m.id,
      total: fplData.scores[i]?.[prevGw - 1] ?? 0,
    }));
  }, [gwInt, fplData]);
  const prevRankOf = useMemo(() => {
    const ps = [...prevFrame].sort((a, b) => b.total - a.total).slice(0, topN);
    return Object.fromEntries(ps.map((m, i) => [m.id, i]));
  }, [prevFrame, topN]);
  const isFinale = gw >= totalGws;
  const winner   = isFinale ? sorted[0] : null;
  const progWidth = `${(gw / totalGws) * 100}%`;

  // FPL standings API truncates team names at ~20 chars with "..."
  // regionsMap is keyed by FULL name → do prefix match for truncated names
  const resolvedTeamMap = useMemo<Record<string, { fullName: string; iso: string | undefined }>>(() => {
    if (!fplData?.regionsMap) return {};
    const rm = fplData.regionsMap;
    const result: Record<string, { fullName: string; iso: string | undefined }> = {};
    for (const m of fplData.managers) {
      const t = m.team;
      if (rm[t] !== undefined) {
        result[t] = { fullName: t, iso: rm[t] };
      } else if (t.endsWith("...")) {
        const prefix = t.slice(0, -3);
        const entry = Object.entries(rm).find(([k]) => k.startsWith(prefix));
        result[t] = { fullName: entry?.[0] ?? t, iso: entry?.[1] };
      } else {
        result[t] = { fullName: t, iso: undefined };
      }
    }
    return result;
  }, [fplData]);

  const mono      = "'JetBrains Mono', monospace";
  const condensed = "'Barlow Condensed', sans-serif";

  /* ════════════════════════════════════════════════════════════════════════
     Phase: FORM
  ════════════════════════════════════════════════════════════════════════ */
  if (phase === "form") {
    const TABS: { id: Mode; label: string }[] = [
      { id: "global", label: "Global" },
      { id: "nation", label: "Nation" },
      { id: "mini",   label: "Mini League" },
    ];
    const canGenerate = mode === "global" || (mode === "nation" && !!country) || (mode === "mini" && !!leagueId.trim());
    const inputStyle: React.CSSProperties = {
      width: "100%", background: "transparent", border: `1px solid ${tk.border}`,
      borderRadius: 6, padding: "12px 16px", color: tk.text,
      fontSize: "1rem", fontWeight: 700, outline: "none",
      boxSizing: "border-box", fontFamily: mono,
    };

    return (
      <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 24, fontFamily: condensed, transition: "background 0.3s, color 0.3s" }}>
        <div style={{ width: "100%", maxWidth: 360 }}>
          {/* top row */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 24 }}>
            <button onClick={toggleTheme}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              style={{ background: "none", border: "none", borderRadius: 8,
                       padding: "6px 8px", cursor: "pointer", color: tk.dim, display: "flex", alignItems: "center" }}>
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>

          <p style={{ color: tk.accent, fontFamily: condensed, fontSize: "1rem",
                      fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
            Fantasy Premier League
          </p>
          <h1 style={{ fontSize: "3.75rem", fontWeight: 900, textTransform: "uppercase",
                       lineHeight: 1, margin: 0 }}>Season</h1>
          <h1 style={{ fontSize: "3.75rem", fontWeight: 900, textTransform: "uppercase",
                       lineHeight: 1, marginBottom: 32 }}>Race</h1>
          <div style={{ height: 1, marginBottom: 32,
                        background: `linear-gradient(to right, ${tk.accent}60, ${tk.text}20, transparent)` }} />

          {/* Mode tabs */}
          <div style={{ display: "flex", gap: 4, marginBottom: 24,
                        background: tk.btnSubtle, borderRadius: 8, padding: 4 }}>
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => setMode(tab.id)}
                style={{
                  flex: 1, padding: "8px 4px", borderRadius: 6, border: "none",
                  fontFamily: mono, fontSize: "0.7rem", fontWeight: 700,
                  cursor: "pointer", transition: "all 0.15s",
                  backgroundColor: mode === tab.id ? tk.accent    : "transparent",
                  color:           mode === tab.id ? tk.accentFg  : tk.dim,
                  letterSpacing: "0.05em",
                }}>
                {tab.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Mode-specific input — minHeight dikunci ke panel tertinggi (mini) agar tidak bergeser */}
            <div style={{ minHeight: 96 }}>
            {mode === "mini" && (
              <div>
                <label style={{ display: "block", marginBottom: 8, color: tk.dim,
                                fontFamily: mono, fontSize: "0.625rem",
                                letterSpacing: "0.2em", textTransform: "uppercase" }}>
                  League ID
                </label>
                <input
                  type="number"
                  value={leagueId}
                  onChange={e => setLeagueId(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && fetchData()}
                  placeholder="e.g. 154649"
                  style={inputStyle}
                />
                <p style={{ marginTop: 6, color: tk.dim, fontFamily: mono, fontSize: "0.625rem" }}>
                  URL: /leagues/<span style={{ color: tk.accent }}>XXXXXX</span>/standings/c
                </p>
              </div>
            )}

            {mode === "nation" && (
              <div>
                <label style={{ display: "block", marginBottom: 8, color: tk.dim,
                                fontFamily: mono, fontSize: "0.625rem",
                                letterSpacing: "0.2em", textTransform: "uppercase" }}>
                  Country
                </label>
                <select
                  value={country}
                  onChange={e => setCountry(e.target.value)}
                  style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none",
                           backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                           backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center",
                           paddingRight: 36, cursor: "pointer" }}>
                  {(countries.length ? countries : [country]).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}

            {mode === "global" && (
              <div style={{ padding: "12px 16px", borderRadius: 6,
                            background: tk.btnSubtle, color: tk.dim,
                            fontFamily: mono, fontSize: "0.75rem", lineHeight: 1.5 }}>
                Top managers worldwide ranked by total points.
              </div>
            )}
            </div>

            {/* Top N */}
            <div>
              <label style={{ display: "block", marginBottom: 8, color: tk.dim,
                              fontFamily: mono, fontSize: "0.625rem",
                              letterSpacing: "0.2em", textTransform: "uppercase" }}>
                Show Teams
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                {TOP_N_OPTIONS.map(n => (
                  <button key={n} onClick={() => setTopN(n)}
                    style={{
                      flex:            1,
                      padding:         "8px 0",
                      borderRadius:    6,
                      border:          "none",
                      fontFamily:      mono,
                      fontSize:        "0.875rem",
                      fontWeight:      900,
                      cursor:          "pointer",
                      transition:      "all 0.15s",
                      backgroundColor: topN === n ? tk.accent   : tk.btnSubtle,
                      color:           topN === n ? tk.accentFg : tk.dim,
                    }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={fetchData} disabled={!canGenerate}
              style={{ width: "100%", padding: "12px 0", borderRadius: 6, border: "none",
                       background: canGenerate ? tk.accent : tk.btnSubtle,
                       color: canGenerate ? tk.accentFg : tk.dim,
                       fontWeight: 900, fontSize: "1rem", letterSpacing: "0.15em",
                       textTransform: "uppercase", cursor: canGenerate ? "pointer" : "not-allowed",
                       fontFamily: condensed, transition: "all 0.15s" }}>
              Generate →
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
     Phase: LOADING
  ════════════════════════════════════════════════════════════════════════ */
  if (phase === "loading") {
    return (
      <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: mono, transition: "background 0.3s" }}>
        <div style={{ textAlign: "center" }}>
          <Loader2 size={32} className="animate-spin" style={{ color: tk.accent, margin: "0 auto 16px" }} />
          <p style={{ color: tk.dim, fontSize: "0.75rem", letterSpacing: "0.2em", textTransform: "uppercase" }}>
            Fetching league data...
          </p>
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
     Phase: ERROR
  ════════════════════════════════════════════════════════════════════════ */
  if (phase === "error") {
    return (
      <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                    display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#f87171", marginBottom: 16 }}>{errorMsg}</p>
          <button onClick={() => setPhase("form")}
            style={{ background: "none", border: "none", color: tk.dim, cursor: "pointer",
                     display: "flex", alignItems: "center", gap: 8,
                     fontFamily: mono, fontSize: "0.75rem" }}>
            <ChevronLeft size={12} /> Back
          </button>
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
     Phase: READY
  ════════════════════════════════════════════════════════════════════════ */
  return (
    <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text,
                  fontFamily: condensed, transition: "background 0.3s, color 0.3s" }}>
      <style>{`
        ::-webkit-scrollbar { display: none; }
        * { scrollbar-width: none; }
        input[type=range] { height: 4px; cursor: pointer; }
        input[type=range]::-webkit-slider-thumb { width: 14px; height: 14px; }
      `}</style>

      <div style={{ maxWidth: 672, margin: "0 auto", padding: captureMode ? "8px 16px 8px" : "24px 16px 32px" }}>

        {/* ── Header ── */}
        <motion.header initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: captureMode ? 0 : 0.45 }}
          style={{ marginBottom: captureMode ? 14 : 28 }}>
          {/* Row 1: FPL title + theme button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <p style={{ color: tk.accent, fontFamily: condensed, fontSize: "1rem",
                        fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", margin: 0 }}>
              Fantasy Premier League
            </p>
            {!captureMode && (
              <button onClick={toggleTheme}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                style={{ background: "none", border: "none",
                         padding: "6px 8px", cursor: "pointer", color: tk.dim,
                         display: "flex", alignItems: "center", flexShrink: 0 }}>
                {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            )}
          </div>
          {/* Row 2: League name (left) aligned with GAMEWEEK label (right) */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <p style={{ color: tk.dim, fontFamily: condensed, fontSize: "1rem",
                        letterSpacing: "0.04em", textTransform: "uppercase", margin: 0 }}>
              {fplData?.leagueName}
            </p>
            <p style={{ fontFamily: condensed, fontSize: "1rem", fontWeight: 400,
                        color: tk.dim, letterSpacing: "0.04em", textTransform: "uppercase",
                        margin: 0, flexShrink: 0 }}>
              GAMEWEEK
            </p>
          </div>
          {/* Row 3: SEASON RACE (left) aligned with GW number (right) */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <h1 style={{ fontWeight: 900, textTransform: "uppercase", lineHeight: 1,
                         fontSize: "clamp(1.8rem, 8vw, 3.5rem)", margin: 0, whiteSpace: "nowrap" }}>
              Season Race
            </h1>
            <div style={{ display: "flex", alignItems: "baseline", gap: 2, flexShrink: 0 }}>
              <motion.span key={gwInt}
                initial={{ color: tk.accent }}
                animate={{ color: tk.text }}
                transition={{ duration: captureMode ? 0 : 0.3 }}
                style={{ fontFamily: condensed, fontSize: "clamp(1.8rem, 8vw, 3.5rem)",
                         fontWeight: 900, lineHeight: 1 }}>
                {String(gwInt).padStart(2, "0")}
              </motion.span>
              <span style={{ fontFamily: condensed, fontSize: "1rem", fontWeight: 700,
                             color: tk.dim }}>/{String(totalGws).padStart(2, "0")}</span>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ position: "relative", height: 2, marginTop: 12,
                        background: tk.border, borderRadius: 2, overflow: "hidden" }}>
            <motion.div style={{ position: "absolute", inset: "0 auto 0 0",
                                 background: tk.accent, borderRadius: 2 }}
              animate={{ width: progWidth }} transition={{ duration: 0.55 }} />
          </div>
        </motion.header>

        {/* ── Bar chart ── */}
        <div style={{
          position: "relative",
          marginBottom: captureMode ? 0 : 32,
          paddingTop: 32,
          filter: theme === "dark" ? "drop-shadow(0 2px 14px rgba(0,0,0,0.55))" : "drop-shadow(0 2px 10px rgba(0,0,0,0.12))",
          zoom: captureMode ? captureCardZoom : webCardZoom,
        }}>
          {/* Folder tab — sticks up above card on top-right */}
          <div style={{
            position: "absolute", top: 0, right: 0,
            width: 96, height: 32,
            backgroundColor: theme === "dark" ? "rgba(255,255,255,0.06)" : "#ffffff",
            borderRadius: "6px 6px 0 0",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{
              fontFamily: condensed, fontSize: "1rem", fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.04em",
              color: tk.text,
            }}>2025/26</span>
          </div>
        <div style={{
          borderRadius: "10px 0 10px 10px",
          backgroundColor: theme === "dark" ? "rgba(255,255,255,0.04)" : "#ffffff",
          padding: captureMode ? "4px 10px" : "8px 14px",
        }}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: captureMode ? 0 : 0.4 }}
          style={{ height: CH, position: "relative" }}>

          {frame.map(m => {
            const rank  = rankOf[m.id] ?? 9999;
            if (rank >= topN) return null;
            const y            = rank * (SH + SG);
            const pct = (m.total / finalMaxTot) * 100;
            const isTop        = rank === 0;
            const displayTotal = Math.round(m.total);

            const prevRank  = prevRankOf[m.id] ?? rank;
            const rankDelta = prevRank - rank; // positive = moved up (better), negative = dropped

            return (
              <motion.div key={m.id}
                initial={false}
                animate={{ y }}
                transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
                style={{
                  position: "absolute", top: 0, left: 0, right: 0, height: SH,
                  display: "flex", flexDirection: "column", justifyContent: "center",
                  borderBottom: compact ? "none" : `1px solid ${tk.border}`,
                }}>

                {/* Top row: rank | circle | name + team + flag */}
                <div style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 8, marginBottom: compact ? 1 : 6 }}>

                  {/* Rank — box on web/small topN, plain coloured number when compact */}
                  {compact ? (
                    <span style={{
                      width: 20, flexShrink: 0, textAlign: "center",
                      fontSize: "0.8rem", fontWeight: 900, color: m.color, fontFamily: mono,
                    }}>{rank + 1}</span>
                  ) : (
                    <div style={{
                      width: 36, height: 36, flexShrink: 0,
                      borderRadius: 8, backgroundColor: m.color,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "background-color 0.5s",
                    }}>
                      <span style={{ fontSize: "1rem", fontWeight: 900, color: "#fff", fontFamily: mono }}>
                        {rank + 1}
                      </span>
                    </div>
                  )}

                  {/* Rank-change indicator */}
                  <div style={{
                    width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    backgroundColor: rankDelta > 0 ? "#16a34a"
                                   : rankDelta < 0 ? "#dc2626"
                                   : tk.surface,
                    transition: "background-color 0.4s",
                  }}>
                    {rankDelta > 0
                      ? <ChevronUp  size={12} color="#fff" strokeWidth={3} />
                      : rankDelta < 0
                      ? <ChevronDown size={12} color="#fff" strokeWidth={3} />
                      : <span style={{ width: 5, height: 5, borderRadius: "50%",
                                       backgroundColor: tk.dim, display: "block" }} />
                    }
                  </div>

                  {/* Name + team + flag */}
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "1rem", fontWeight: 700, textTransform: "uppercase",
                                   letterSpacing: "0.04em", color: tk.text }}>
                      {m.name}
                    </span>
                    <span style={{ fontSize: "0.8rem", color: tk.dim }}>
                      {resolvedTeamMap[m.team]?.fullName ?? m.team}
                    </span>
                    {resolvedTeamMap[m.team]?.iso && (
                      <span style={{ fontSize: "0.85rem", flexShrink: 0, lineHeight: 1 }}>
                        {isoToFlag(resolvedTeamMap[m.team].iso!)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Bottom row: bar (indented) + total score */}
                <div style={{ display: "flex", alignItems: "center", gap: 8,
                              paddingLeft: compact ? 53 : 74 }}>

                  {/* Bar track */}
                  <div style={{ flex: 1, position: "relative",
                                height: compact ? 4 : 18,
                                borderRadius: compact ? 2 : 4,
                                overflow: "hidden", backgroundColor: "transparent" }}>
                    <motion.div
                      initial={false}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0 }}
                      style={{
                        position:     "absolute", inset: "0 auto 0 0",
                        borderRadius: compact ? 2 : 4,
                        overflow:     "hidden",
                        boxShadow:    isTop ? `0 0 ${compact ? 6 : 16}px ${m.color}55` : "none",
                      }}>
                      <div style={{
                        position:        "absolute", inset: 0,
                        backgroundColor: m.color,
                        opacity:         isTop ? tk.barOpTop : tk.barOpOther,
                      }} />
                      {/* GW score — hidden when compact (bar too thin) */}
                      {!compact && m.gwScore > 0 && (
                        <span style={{
                          position:      "absolute", right: 7,
                          top:           "50%", transform: "translateY(-50%)",
                          fontSize:      "0.65rem", fontWeight: 900,
                          color:         "rgba(255,255,255,0.9)",
                          fontFamily:    mono, pointerEvents: "none",
                          whiteSpace:    "nowrap", zIndex: 2,
                        }}>+{m.gwScore}</span>
                      )}
                    </motion.div>
                  </div>

                  {/* Total score — right of bar */}
                  <div style={{ textAlign: "right", width: compact ? 52 : 72, flexShrink: 0,
                                fontFamily: mono, fontSize: compact ? "0.95rem" : "1.5rem",
                                fontWeight: 900, lineHeight: 1,
                                color: isTop ? tk.accent : tk.text }}>
                    {displayTotal.toLocaleString()}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
        </div>
        </div>


        {/* ── Controls (hidden in capture mode) ── */}
        {!captureMode && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                          paddingTop: 20, borderTop: `1px solid ${tk.border}` }}>
              <button onClick={() => { setPlay(false); setGw(1); }}
                style={{ padding: 8, background: "none", border: "none",
                         cursor: "pointer", color: tk.dim }} title="Reset to GW 1">
                <RotateCcw size={15} />
              </button>
              <button onClick={toggle}
                style={{ display: "flex", alignItems: "center", gap: 8,
                         padding: "10px 24px", borderRadius: 24, border: "none",
                         background: tk.accent, color: tk.accentFg, fontWeight: 900,
                         fontSize: "0.875rem", letterSpacing: "0.1em",
                         textTransform: "uppercase", cursor: "pointer", fontFamily: condensed }}>
                {playing ? <Pause size={14} /> : <Play size={14} />}
                <span>{playing ? "Pause" : isFinale ? "Replay" : "Play"}</span>
              </button>
              <div style={{ display: "flex", gap: 4 }}>
                {SPEEDS.map((s, i) => (
                  <button key={s.label} onClick={() => setSpd(i)}
                    style={{
                      padding:         "5px 10px", borderRadius: 5,
                      border:          spd === i ? `1px solid ${tk.accent}60` : `1px solid ${tk.border}`,
                      fontFamily:      mono, fontSize: "0.7rem", fontWeight: 700, cursor: "pointer",
                      backgroundColor: spd === i ? `${tk.accent}22` : "transparent",
                      color:           spd === i ? tk.accent : tk.dim,
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

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
              <button onClick={() => { setPhase("form"); setPlay(false); }}
                style={{ display: "flex", alignItems: "center", gap: 8, background: "none",
                         border: "none", color: tk.dim, cursor: "pointer",
                         fontFamily: mono, fontSize: "0.75rem" }}>
                <ChevronLeft size={12} /> Back
              </button>
              <div style={{ flex: 1 }} />
              {downloading ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8,
                               color: tk.dim, fontFamily: mono, fontSize: "0.6875rem" }}>
                  <Loader2 size={11} className="animate-spin" />{dlMsg}
                </span>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <button onClick={downloadMp4}
                    style={{ display: "flex", alignItems: "center", gap: 8,
                             padding: "7px 14px", borderRadius: 6, border: "none",
                             background: tk.btnSubtle, color: tk.textSub,
                             fontFamily: mono, fontSize: "0.75rem", fontWeight: 700,
                             textTransform: "uppercase", letterSpacing: "0.05em", cursor: "pointer" }}>
                    <Download size={12} /> Download MP4
                  </button>
                  {dlMsg && (
                    <span style={{ fontFamily: mono, fontSize: "0.6rem",
                                   color: dlMsg.startsWith("❌") ? "#f87171" : tk.dim }}>
                      {dlMsg}
                    </span>
                  )}
                </div>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
