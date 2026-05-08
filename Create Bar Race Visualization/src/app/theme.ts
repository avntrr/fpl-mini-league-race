export type Theme = "dark" | "light";

export interface Tk {
  bg:           string;
  surface:      string;  // bar track / card background
  text:         string;
  textSub:      string;  // secondary text
  dim:          string;  // muted labels
  border:       string;
  accent:       string;
  accentFg:     string;  // text ON accent bg
  btnSubtle:    string;  // subtle button bg (download, speed, top-n unselected)
  barOpTop:     number;  // fill opacity for leader / manager bar
  barOpOther:   number;  // fill opacity for other bars
  rankDefault:  string;  // rank badge color for positions > 3
}

export const THEMES: Record<Theme, Tk> = {
  dark: {
    bg:          "#0a0e1a",
    surface:     "rgba(255,255,255,0.045)",
    text:        "#e2e8f0",
    textSub:     "#94a3b8",
    dim:         "#64748b",
    border:      "#1e293b",
    accent:      "#00ff87",
    accentFg:    "#060810",
    btnSubtle:   "rgba(255,255,255,0.07)",
    barOpTop:    0.92,
    barOpOther:  0.62,
    rankDefault: "#64748b",
  },
  light: {
    bg:          "#f8f9fb",          // Figma: white/light-gray background
    surface:     "#ececf0",          // shadcn --muted  (bar track)
    text:        "#0f172a",          // Figma: dark text
    textSub:     "#717182",          // shadcn --muted-foreground
    dim:         "#a1a1aa",          // lighter muted — label / metadata text
    border:      "rgba(0,0,0,0.1)", // shadcn --border
    accent:      "#00d084",          // Figma: FPL green (better contrast on light bg)
    accentFg:    "#ffffff",
    btnSubtle:   "#f3f3f5",          // shadcn --input-background
    barOpTop:    0.88,
    barOpOther:  0.75,
    rankDefault: "#9ca3af",          // slate-400 — rank badge > 3
  },
};

export const THEME_KEY = "fpl-theme";
