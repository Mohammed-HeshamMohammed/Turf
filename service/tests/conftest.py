import sys
from pathlib import Path

import pytest

# The service is run from this folder, not installed.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def _isolated_app_data(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Tests never write log files or the recent-projects list into the real app-data folder."""
    monkeypatch.setenv("CALLERWHALE_LOG_FILE", "0")
    monkeypatch.setenv("CALLERWHALE_APP_DATA", str(tmp_path / "app-data"))
    monkeypatch.setenv("CALLERWHALE_STATUS_MODEL_DOWNLOAD", "0")  # tests never fetch the status model from the internet
