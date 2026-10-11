"""The small embedding model that helps read call statuses Turf's phrase rules do not know.

It is optional. Without it (the model2vec package missing, or the model files not fetched) statuses are read by memory
and phrase rules alone. The model is Model2Vec's potion-base-8M (MIT license, about 30 MB), a static embedding model
that runs on the CPU with numpy only, and it is loaded from the computer, never from the internet. Fetch it with

    python tools/fetch_status_model.py
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

from .projects import app_data_dir

MODEL_REPO = "minishlab/potion-base-8M"
MODEL_REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
MODEL_FILES = ("config.json", "model.safetensors", "tokenizer.json")

log = logging.getLogger(__name__)


def model_dir() -> Path:
    """Where the model's files are: TURF_STATUS_MODEL, or the models folder in Turf's app data."""
    return Path(os.environ.get("TURF_STATUS_MODEL") or app_data_dir() / "models" / "potion-base-8M")


def embedder():
    """A function from texts to unit-length vectors, or None when the model is not available."""
    folder = model_dir()
    if not all((folder / name).is_file() for name in MODEL_FILES):
        return None
    return _load(str(folder))


@lru_cache(maxsize=2)
def _load(path: str):
    folder = Path(path)
    try:
        from model2vec import StaticModel
    except ImportError:
        log.info("model2vec is not installed; call statuses are read without the model")
        return None
    try:
        model = StaticModel.from_pretrained(str(folder), normalize=True)
    except Exception:  # a damaged download must not stop Skip Tracing
        log.exception("The status model in %s could not be loaded", folder)
        return None
    return lambda texts: model.encode(list(texts), show_progress_bar=False)
