/**
 * Remotion render script — called by screenshotter.py as a subprocess.
 *
 * Usage:
 *   node render.mjs \
 *     --data    /path/to/fpl-data.json \
 *     --output  /path/to/out.mp4       \
 *     --fps     30                      \
 *     --theme   dark                    \
 *     --speed   0                       \
 *     --top-n   10                      \
 *     [--chromium /path/to/chrome]
 *
 * Progress is reported to stdout as: PROGRESS:<0-100>
 */
import { bundle }                        from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { readFileSync, existsSync, writeFileSync, statSync } from "fs";
import { fileURLToPath }                 from "url";
import { dirname, join, resolve }        from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/* ── Parse CLI args ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const get  = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };

const dataPath     = get("--data");
const outputPath   = get("--output");
const fps          = parseInt(get("--fps")    ?? "30",  10);
const theme        = get("--theme")  ?? "dark";
const speed        = parseInt(get("--speed")  ?? "0",   10);
const topN         = parseInt(get("--top-n")  ?? "10",  10);
const chromiumPath = get("--chromium");

if (!dataPath || !outputPath) {
  console.error("Usage: node render.mjs --data <json> --output <mp4> [options]");
  process.exit(1);
}

/* ── Load FPL data ─────────────────────────────────────────────────────────── */
const data = JSON.parse(readFileSync(dataPath, "utf-8"));

/* ── Bundle caching ──────────────────────────────────────────────────────────
 * Remotion's bundle() is webpack-based and fast on repeat runs (webpack cache).
 * We also persist the bundle dir path to disk so sequential renders can skip
 * re-bundling entirely if source files haven't changed.
 */
const ENTRY_POINT  = join(__dirname, "src", "remotion", "Root.tsx");
const CACHE_FILE   = join(__dirname, ".remotion-bundle-path");

async function getBundle() {
  // Check if we have a cached bundle that's still valid
  if (existsSync(CACHE_FILE)) {
    const cachedPath = readFileSync(CACHE_FILE, "utf-8").trim();
    if (existsSync(join(cachedPath, "index.html"))) {
      const bundleMtime = statSync(join(cachedPath, "index.html")).mtimeMs;
      const sourceMtime = statSync(ENTRY_POINT).mtimeMs;
      if (bundleMtime > sourceMtime) {
        console.log("Using cached Remotion bundle.");
        return cachedPath;
      }
    }
  }

  console.log("Bundling Remotion composition...");
  const bundlePath = await bundle({
    entryPoint: ENTRY_POINT,
    // Enable webpack caching for faster subsequent bundles
    webpackOverride: (config) => config,
  });

  writeFileSync(CACHE_FILE, bundlePath);
  console.log("Bundle ready:", bundlePath);
  return bundlePath;
}

/* ── Main ───────────────────────────────────────────────────────────────────── */
const inputProps = { data, theme, speed, topN, fps };

const bundlePath  = await getBundle();
const composition = await selectComposition({
  serveUrl:   bundlePath,
  id:         "Race",
  inputProps,
});

console.log(`Rendering ${composition.durationInFrames} frames @ ${composition.fps}fps → ${outputPath}`);

await renderMedia({
  composition,
  serveUrl:         bundlePath,
  codec:            "h264",
  outputLocation:   resolve(outputPath),
  inputProps,

  // Use Playwright's Chromium if provided — avoids a second Chrome download
  browserExecutable: chromiumPath || undefined,

  // Match screenshotter quality settings
  crf:         23,
  pixelFormat: "yuv420p",

  // Memory-efficient (Railway 512MB)
  concurrency: 2,

  // 2× scale: composition is 540×960 logical → output 1080×1920
  scale: 2,

  // ffmpeg flags matching screenshotter.py
  ffmpegOverride: ({ args }) => {
    // Insert ultrafast + ref=1:bframes=0 before the output path (last arg)
    const out = args[args.length - 1];
    return [
      ...args.slice(0, -1),
      "-preset", "ultrafast",
      "-x264opts", "ref=1:bframes=0:no-cabac=1",
      "-threads", "2",
      out,
    ];
  },

  onProgress: ({ renderedFrames, renderedDoneIn, encodingDoneIn }) => {
    if (renderedFrames !== undefined) {
      const pct = Math.round((renderedFrames / composition.durationInFrames) * 100);
      // Python reads this line to update progress
      process.stdout.write(`PROGRESS:${pct}:${renderedFrames}:${composition.durationInFrames}\n`);
    }
  },
});

console.log("Remotion render complete.");
