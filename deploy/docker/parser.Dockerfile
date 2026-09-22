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
  "python-docx>=1.1.0" "python-pptx>=1.0.0" "openpyxl>=3.1.0" \
  "xlrd>=2.0.1" "pymupdf>=1.24.0"
# Deliberately NOT installed: docling / MinerU / layout models. They would add
# several GB of local model weights, and this deployment's policy is that deep
# layout extraction stays off (LOCAL_DOCLING_ENABLED=0) or runs through the
# cloud OCR provider. `pymupdf` is a pure PDF rasteriser (no models) and is what
# the page-level VLM enrichment needs to render a page to an image; without it
# that path silently produced empty strings.
#
# Removed dependency: minio — no code in this worker ever imported it.

COPY apps/parser-worker/src ./src
RUN mkdir -p /var/lib/llmwiki/parser \
  && useradd --system --uid 10002 --home-dir /app --shell /usr/sbin/nologin parser \
  && chown -R parser:parser /app /var/lib/llmwiki

# The worker parses untrusted documents through third-party converters
# (antiword, pypdf, openpyxl); it has no reason to hold uid 0 inside the
# container. Deployments that created the parser volume before this change must
# fix its ownership once (see deploy/README.md).
USER parser

EXPOSE 8100
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8100"]
