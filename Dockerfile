# ── Stage: build React ────────────────────────────────────────────────────────
FROM node:20-slim AS react-build

WORKDIR /app

# Copy only package files first (layer cache)
COPY ["Create Bar Race Visualization/package.json", "Create Bar Race Visualization/package-lock.json", "./Create Bar Race Visualization/"]
RUN cd "Create Bar Race Visualization" \
    && npm install --legacy-peer-deps \
    && npm install --save react@18.3.1 react-dom@18.3.1

# Copy source and build
COPY ["Create Bar Race Visualization/", "./Create Bar Race Visualization/"]
RUN cd "Create Bar Race Visualization" && npm run build


# ── Stage: production ─────────────────────────────────────────────────────────
FROM python:3.11-slim

# System deps: ffmpeg + Playwright/Chromium runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    # Chromium runtime dependencies
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright Chromium (uses system libs installed above)
RUN playwright install chromium

# Copy built React dist from react-build stage
COPY --from=react-build ["/app/Create Bar Race Visualization/dist", "./Create Bar Race Visualization/dist"]

# Copy Python source
COPY *.py .

# Output dir (video files written here at runtime)
RUN mkdir -p output

EXPOSE 8080

CMD ["python", "app.py"]
