#!/usr/bin/env python3
"""Worker STT persistant pour Novabot (faster-whisper, CPU int8).

Protocole : une ligne JSON par requête sur stdin {"id": "...", "path": "/fichier/audio", "language": "fr"}
→ une ligne JSON sur stdout {"id": "...", "text": "..."} ou {"id": "...", "error": "..."}.
Le modèle est chargé une seule fois (NOVABOT_STT_MODEL, défaut "small").
"""
import json
import os
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def load_audio(path: str) -> np.ndarray:
    """Décode n'importe quel format via ffmpeg → PCM float32 mono 16 kHz (évite PyAV)."""
    out = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le",
                          "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


MODEL = os.environ.get("NOVABOT_STT_MODEL", "small")
THREADS = int(os.environ.get("NOVABOT_STT_THREADS", "4"))
model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS,
                     download_root=os.path.expanduser("~/.novabot/whisper-models"))
print(json.dumps({"ready": True, "model": MODEL}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        segments, _info = model.transcribe(load_audio(req["path"]), language=req.get("language") or None,
                                           vad_filter=True, beam_size=1)
        text = " ".join(s.text.strip() for s in segments).strip()
        print(json.dumps({"id": req.get("id"), "text": text}), flush=True)
    except Exception as e:  # noqa: BLE001 — on renvoie l'erreur au daemon
        print(json.dumps({"id": req.get("id"), "error": str(e)}), flush=True)
