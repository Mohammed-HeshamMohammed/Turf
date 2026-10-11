"""Downloads the model that helps read call statuses into Turf's app data (or TURF_STATUS_MODEL).

    python tools/fetch_status_model.py

Source: https://huggingface.co/minishlab/potion-base-8M (MIT license), at a fixed revision, three files, about 31 MB.
Needs the huggingface_hub package, which model2vec installs. Turf works without the model; see turf_service/status_model.py.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from huggingface_hub import hf_hub_download  # noqa: E402

from turf_service.status_model import MODEL_FILES, MODEL_REPO, MODEL_REVISION, embedder, model_dir  # noqa: E402


def main() -> None:
    target = model_dir()
    target.mkdir(parents=True, exist_ok=True)
    for name in MODEL_FILES:
        downloaded = hf_hub_download(MODEL_REPO, name, revision=MODEL_REVISION)
        shutil.copyfile(downloaded, target / name)
        print(f"{name}: {(target / name).stat().st_size:,} bytes")
    print(f"Saved in {target}" if embedder() else f"Saved in {target}, but it could not be loaded (is model2vec installed?)")


if __name__ == "__main__":
    main()
