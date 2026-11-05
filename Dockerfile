# One container for the public demo (Render free web service): build web/, then FastAPI serves it.
# Keys (GROQ_API_KEY, NVIDIA_API_KEY) come from the host's environment settings, never from this image.

# --- 1. Build the frontend -------------------------------------------------------------------------
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 2. Run the backend ----------------------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY config/ config/
COPY fixtures/ fixtures/
COPY --from=web /app/web/dist web/dist
# Map tiles are fetched on first use and cached here (lost on restart, which is fine).
RUN mkdir -p data results
# Render sets $PORT; 8000 when run elsewhere.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
