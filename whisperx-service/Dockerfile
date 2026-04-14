# WhisperX Transcription Service with Speaker Diarization
# Based on official m-bain/whisperx

FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install PyTorch CPU version (for GPU, use nvidia/cuda base image)
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# Install WhisperX from official repo
RUN pip install --no-cache-dir git+https://github.com/m-bain/whisperx.git

# Install FastAPI and dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directory for model cache
RUN mkdir -p /root/.cache/huggingface

# Expose port
EXPOSE 48001

# Health check — start-period covers model download + load on first boot
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:48001/health || exit 1

# Run the service
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "48001", "--timeout-keep-alive", "300"]
