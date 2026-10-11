"""Fetches the call-status model now, instead of waiting for Turf to fetch it in the background.

    python tools/fetch_status_model.py

Turf does this by itself the first time Skip Tracing reads a list's statuses; this is for a computer that will be
offline later, or to see the download happen. Same source, revision and checksums as turf_service/status_model.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from turf_service.status_model import download, embedder, model_dir  # noqa: E402


def main() -> None:
    folder = model_dir()
    download(folder)
    print(f"Saved in {folder}" if embedder() else f"Saved in {folder}, but it could not be loaded (is model2vec installed?)")


if __name__ == "__main__":
    main()
