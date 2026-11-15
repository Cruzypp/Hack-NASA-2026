# Build from the repository root:  docker build -f backend/Dockerfile .
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/astra ./astra
COPY public/samples /app/public/samples

# SQLite lives on a mounted volume so data survives restarts and redeploys.
RUN mkdir -p /data
ENV PATH="/app/backend/.venv/bin:$PATH" \
    ASTRA_DB=/data/astra.db \
    ASTRA_GROUND_DB=/data/ground.db
EXPOSE 8000
CMD ["sh", "-c", "uvicorn astra.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
