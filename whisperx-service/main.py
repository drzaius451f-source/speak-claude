"""
WhisperX Transcription Service with Speaker Diarization
FastAPI wrapper for m-bain/whisperx
"""

import os
import tempfile
import logging
from typing import Optional

# Fix for PyTorch 2.6+ weights_only default change
# Must be set BEFORE importing torch or whisperx
os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "0"

import torch
import torch.serialization

# Aggressive patch: override at multiple levels
# 1. Patch torch.load
_orig_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return _orig_load(*args, **kwargs)
torch.load = _safe_load

# 2. Patch torch.serialization.load (alias)
torch.serialization.load = _safe_load

# Now import whisperx (which will use our patched torch.load)
import whisperx

from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="WhisperX Transcription Service",
    description="Speech-to-text with speaker diarization",
    version="1.0.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE_TYPE = "float32" if DEVICE == "cuda" else "int8"
BATCH_SIZE = 16 if DEVICE == "cuda" else 4
MODEL_SIZE = os.getenv("WHISPERX_MODEL", "base")  # tiny, base, small, medium, large-v2
HF_TOKEN = os.getenv("HF_TOKEN", None)  # Required for diarization

# Global model cache
whisper_model = None


class TranscriptionResponse(BaseModel):
    transcript: str
    segments: list
    language: str
    has_speakers: bool


class HealthResponse(BaseModel):
    status: str
    device: str
    model: str
    diarization_available: bool


def get_whisper_model():
    """Lazy load WhisperX model."""
    global whisper_model
    if whisper_model is None:
        logger.info(f"Loading WhisperX model '{MODEL_SIZE}' on {DEVICE}...")
        whisper_model = whisperx.load_model(
            MODEL_SIZE,
            DEVICE,
            compute_type=COMPUTE_TYPE,
        )
        logger.info("WhisperX model loaded successfully")
    return whisper_model


def format_transcript_with_speakers(segments: list) -> str:
    """Format segments into readable transcript with speaker labels."""
    lines = []
    current_speaker = None
    current_text = []

    for segment in segments:
        speaker = segment.get("speaker", "UNKNOWN")
        text = segment.get("text", "").strip()

        if speaker != current_speaker:
            # Save previous speaker's text
            if current_speaker is not None and current_text:
                lines.append(f"{current_speaker}: {' '.join(current_text)}")
            current_speaker = speaker
            current_text = [text] if text else []
        else:
            if text:
                current_text.append(text)

    # Don't forget the last speaker
    if current_speaker is not None and current_text:
        lines.append(f"{current_speaker}: {' '.join(current_text)}")

    return "\n\n".join(lines)


def format_transcript_without_speakers(segments: list) -> str:
    """Format segments into plain transcript."""
    return " ".join(seg.get("text", "").strip() for seg in segments if seg.get("text"))


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    return HealthResponse(
        status="healthy",
        device=DEVICE,
        model=MODEL_SIZE,
        diarization_available=HF_TOKEN is not None,
    )


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    file: UploadFile = File(...),
    diarize: bool = Form(default=True),
    language: Optional[str] = Form(default=None),
    align: bool = Form(default=True),
):
    """
    Transcribe audio/video file with optional speaker diarization.

    - **file**: Audio/video file (mp3, mp4, wav, m4a, webm, ogg)
    - **diarize**: Enable speaker diarization (requires HF_TOKEN)
    - **language**: Language code (auto-detect if not specified)
    - **align**: Enable word-level alignment (requires NLTK, disable if having issues)
    """
    # Validate file type
    allowed_types = {
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
        "audio/mp4", "audio/m4a", "audio/x-m4a",
        "video/mp4", "video/webm", "audio/webm",
        "audio/ogg", "video/ogg",
    }

    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file.content_type}. Allowed: MP3, MP4, WAV, M4A, WebM, OGG",
        )

    # Save uploaded file temporarily
    suffix = os.path.splitext(file.filename)[1] if file.filename else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Load model
        model = get_whisper_model()

        # Load audio
        logger.info(f"Loading audio from {tmp_path}")
        audio = whisperx.load_audio(tmp_path)

        # Transcribe
        logger.info("Transcribing audio...")
        result = model.transcribe(audio, batch_size=BATCH_SIZE, language=language)
        detected_language = result.get("language", "en")

        # Align whisper output (optional - requires NLTK)
        if align:
            try:
                logger.info("Aligning transcript...")
                model_a, metadata = whisperx.load_align_model(
                    language_code=detected_language,
                    device=DEVICE,
                )
                result = whisperx.align(
                    result["segments"],
                    model_a,
                    metadata,
                    audio,
                    DEVICE,
                    return_char_alignments=False,
                )
            except Exception as e:
                logger.warning(f"Alignment failed: {e}. Returning unaligned transcript.")
        else:
            logger.info("Skipping alignment (align=False)")

        has_speakers = False

        # Speaker diarization (if enabled and HF_TOKEN available)
        if diarize and HF_TOKEN:
            try:
                logger.info("Running speaker diarization...")
                diarize_model = whisperx.DiarizationPipeline(
                    use_auth_token=HF_TOKEN,
                    device=DEVICE,
                )
                diarize_segments = diarize_model(audio)
                result = whisperx.assign_word_speakers(diarize_segments, result)
                has_speakers = True
                logger.info("Speaker diarization completed")
            except Exception as e:
                logger.warning(f"Diarization failed: {e}. Returning transcript without speakers.")
        elif diarize and not HF_TOKEN:
            logger.warning("Diarization requested but HF_TOKEN not set")

        # Format transcript
        segments = result.get("segments", [])
        if has_speakers:
            transcript = format_transcript_with_speakers(segments)
        else:
            transcript = format_transcript_without_speakers(segments)

        return TranscriptionResponse(
            transcript=transcript,
            segments=segments,
            language=detected_language,
            has_speakers=has_speakers,
        )

    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

    finally:
        # Cleanup temp file
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "WhisperX Transcription Service",
        "version": "1.0.0",
        "endpoints": {
            "POST /transcribe": "Transcribe audio with speaker diarization",
            "GET /health": "Health check",
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=48001)
