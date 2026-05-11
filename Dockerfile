# ── Stage 1: build React app ──────────────────────────────────────────────────
FROM node:20-slim AS react-build

WORKDIR /app
COPY ["Create Bar Race Visualization/package.json", "Create Bar Race Visualization/package-lock.json", "./Create Bar Race Visualization/"]
RUN cd "Create Bar Race Visualization" && npm install --legacy-peer-deps

COPY ["Create Bar Race Visualization/", "./Create Bar Race Visualization/"]
RUN cd "Create Bar Race Visualization" && npm run build


# ── Stage 2: runtime (Python + Node.js untuk Remotion) ────────────────────────
FROM python:3.11-slim

# System deps: ffmpeg + curl + Chromium runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 — dibutuhkan Remotion saat render MP4 di runtime
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright Chromium (reused oleh Remotion via --chromium flag)
RUN playwright install chromium

# ── React web UI (dist/) dari build stage ────────────────────────────────────
COPY --from=react-build ["/app/Create Bar Race Visualization/dist", \
                          "./Create Bar Race Visualization/dist"]

# ── Remotion runtime: node_modules + render script + source ──────────────────
# node_modules berisi remotion, @remotion/bundler, @remotion/renderer, dll.
COPY --from=react-build ["/app/Create Bar Race Visualization/node_modules", \
                          "./Create Bar Race Visualization/node_modules"]
COPY ["Create Bar Race Visualization/render.mjs",      "./Create Bar Race Visualization/"]
COPY ["Create Bar Race Visualization/src/remotion/",   "./Create Bar Race Visualization/src/remotion/"]

# Python source
COPY *.py .

RUN mkdir -p output

EXPOSE 8080
CMD ["python", "app.py"]
