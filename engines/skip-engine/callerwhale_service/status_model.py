"""The small embedding model that helps read call statuses Caller Whale's phrase rules do not know.

It sets itself up: the first time Skip Tracing reads a list's statuses and the model is not on this computer yet, it
is downloaded in the background, once, into Caller Whale's app data, and used from then on. Until it is there (or when there
is no internet, or the model2vec package is missing) statuses are read by memory and phrase rules alone, which is
how Caller Whale worked before.

The model is Model2Vec's potion-base-8M (MIT license, about 31 MB), a static embedding model that runs on the CPU with
numpy only. The download comes from Hugging Face at a fixed revision, and every file is checked against its known
SHA-256 before it is used, so a changed or damaged file is never loaded.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
import urllib.request
from functools import lru_cache
from pathlib import Path

from .projects import app_data_dir

MODEL_REPO = "minishlab/potion-base-8M"
MODEL_REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
MODEL_FILES = {
    "config.json": "2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553",
    "model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
    "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
}
MODEL_SIZE = 30_921_000  # bytes, roughly, for progress
RETRY_AFTER = 600  # seconds before a failed download is tried again

log = logging.getLogger(__name__)
_lock = threading.Lock()
_fetch = {"state": "idle", "done": 0, "error": "", "failed_at": 0.0}


def model_dir() -> Path:
    """Where the model's files are: CALLERWHALE_STATUS_MODEL, or the models folder in Caller Whale's app data."""
    return Path(os.environ.get("CALLERWHALE_STATUS_MODEL") or app_data_dir() / "models" / "potion-base-8M")


def _present(folder: Path) -> bool:
    return all((folder / name).is_file() for name in MODEL_FILES)


def _package() -> bool:
    try:
        import model2vec  # noqa: F401
    except ImportError:
        return False
    return True


def state() -> dict:
    """{"state": "ready" | "downloading" | "waiting" | "failed" | "unavailable", ...} for the screen."""
    if _present(model_dir()) and _package():
        return {"state": "ready"}
    if not _package():
        return {"state": "unavailable", "detail": "The model2vec package is not installed"}
    with _lock:
        if _fetch["state"] == "downloading":
            return {"state": "downloading", "done": _fetch["done"], "total": MODEL_SIZE}
        if _fetch["state"] == "failed":
            return {"state": "failed", "detail": _fetch["error"]}
    return {"state": "waiting"}


def ensure() -> None:
    """Starts fetching the model in the background when it is missing. Returns at once."""
    folder = model_dir()
    if _present(folder) or os.environ.get("CALLERWHALE_STATUS_MODEL_DOWNLOAD") == "0" or not _package():
        return
    with _lock:
        if _fetch["state"] == "downloading" or (_fetch["state"] == "failed" and time.time() - _fetch["failed_at"] < RETRY_AFTER):
            return
        _fetch.update(state="downloading", done=0, error="")
    threading.Thread(target=_fetch_in_background, args=(folder,), name="status-model-download", daemon=True).start()


def _fetch_in_background(folder: Path) -> None:
    try:
        download(folder)
        with _lock:
            _fetch.update(state="idle")
        log.info("The status model is ready in %s", folder)
    except Exception as error:  # no internet, a proxy, a full disk: Caller Whale carries on without the model
        with _lock:
            _fetch.update(state="failed", error=str(error), failed_at=time.time())
        log.warning("The status model could not be fetched: %s", error)


def download(folder: Path, opener=urllib.request.urlopen) -> None:
    """Fetches every model file that is missing, checks it, and only then puts it in place."""
    folder.mkdir(parents=True, exist_ok=True)
    for name, expected in MODEL_FILES.items():
        target = folder / name
        if target.is_file():
            continue
        partial = folder / f"{name}.part"
        digest = hashlib.sha256()
        url = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{name}"
        with opener(url, timeout=60) as response, partial.open("wb") as handle:
            while chunk := response.read(1 << 16):
                digest.update(chunk)
                handle.write(chunk)
                with _lock:
                    _fetch["done"] += len(chunk)
        if digest.hexdigest() != expected:
            partial.unlink(missing_ok=True)
            raise ValueError(f"{name} did not match its known checksum, so it was not used")
        os.replace(partial, target)


def embedder():
    """A function from texts to unit-length vectors, or None while the model is not available."""
    folder = model_dir()
    if not _present(folder):
        ensure()
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
    except Exception:  # a damaged folder must not stop Skip Tracing
        log.exception("The status model in %s could not be loaded", folder)
        return None
    return lambda texts: model.encode(list(texts), show_progress_bar=False)
