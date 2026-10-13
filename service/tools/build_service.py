"""Builds the service into one executable for the installer, so a packaged Turf needs no Python.

    python service/tools/build_service.py

Writes service/dist/turf-service.exe (turf-service on other systems). The desktop host looks for it in the bundle's
`service` folder and starts it with `--resources <bundle>`; the migrations travel beside it (see src-tauri/tauri.conf.json).
Needs PyInstaller (`pip install pyinstaller`) and everything in service/requirements.txt.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]


def main() -> None:
    data = SERVICE / "turf_service" / "data"
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--console", "--name", "turf-service",
        "--distpath", str(SERVICE / "dist"), "--workpath", str(SERVICE / "build"), "--specpath", str(SERVICE / "build"),
        "--paths", str(SERVICE),
        # The ZIP centres and the throwaway-domain list are read from beside the code.
        "--add-data", f"{data}{os.pathsep}turf_service/data",
        # Phone metadata is loaded by region name at run time, which the analysis cannot follow.
        "--collect-submodules", "phonenumbers",
        # Optional at run time, but a packaged Turf has no other way to get them.
        "--collect-all", "model2vec",
        "--hidden-import", "dns.resolver",
        "--hidden-import", "dns.exception",
        "--hidden-import", "pyarrow.parquet",
        "--hidden-import", "openpyxl",
        str(SERVICE / "tools" / "service_entry.py"),
    ]
    subprocess.run(command, check=True, cwd=SERVICE)
    built = SERVICE / "dist" / ("turf-service.exe" if os.name == "nt" else "turf-service")
    print(f"Built {built} ({built.stat().st_size / 1_048_576:.0f} MB)")


if __name__ == "__main__":
    main()
