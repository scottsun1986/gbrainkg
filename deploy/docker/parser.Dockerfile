FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends antiword curl \
  && rm -rf /var/lib/apt/lists/*

COPY apps/parser-worker/pyproject.toml apps/parser-worker/README.md ./
RUN pip install --no-cache-dir \
  "fastapi>=0.111.0" "uvicorn[standard]>=0.30.0" "pydantic>=2.7.0" \
  "python-multipart>=0.0.9" "httpx>=0.28.0" "pypdf>=5.0.0" \
  "python-docx>=1.1.0" "openpyxl>=3.1.0" "minio>=7.2.7"

COPY apps/parser-worker/src ./src
RUN mkdir -p /var/lib/llmwiki/parser

EXPOSE 8100
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8100"]
