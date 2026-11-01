# Python AI service — CPU-only inference image
FROM python:3.14-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/.cache/huggingface

# eMudhra/emSign CA incident (Oct 2026): the pip bundled with the base image
# predates pip 26.2.2 and keeps trusting the compromised emSign CAs (pip
# always loads its vendored certifi in addition to the system store, so the
# base image's CA bundle alone does not fix it). Bootstrap a fixed pip from
# the PSF advisory's hash-pinned direct URL before installing anything.
RUN pip install --no-cache-dir "pip @ https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl#sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"

# Install CPU-only torch in its own layer (cached across requirements bumps):
# the default PyPI wheels pull multi-GB NVIDIA CUDA dependencies that are
# useless in this CPU container.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch

# Copy requirements first for better layer caching
COPY requirements.txt .

# Everything ships prebuilt wheels, so no compilers or system packages needed
RUN pip install --no-cache-dir -r requirements.txt

# Bake the embedding model into the image at build time...
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

# ...then stop runtime Hub lookups. Without this the library re-checks
# huggingface.co on every start: with no network it retries for ~2.5 min
# before falling back to the cache, and with network an upstream change can
# swap the model under stored embeddings. Must come after the download above.
ENV HF_HUB_OFFLINE=1

# Copy application code
COPY app/ ./app/

# Run as non-root
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Health check via the stdlib — no curl needed in the image
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
