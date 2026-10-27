"""Builds the service into one executable for the installer, so a packaged Turf needs no Python.

    python service/tools/build_service.py [--dist <folder>] [--work <folder>]

Writes service/dist/turf-service.exe (turf-service on other systems), or into `--dist`; `--work` is where the build
keeps its working files (a few hundred megabytes), for a drive with more room. The desktop host looks for it in the bundle's
`service` folder and starts it with `--resources <bundle>`; the migrations travel beside it (see src-tauri/tauri.package.conf.json).
Needs PyInstaller (`pip install pyinstaller`) and everything in service/requirements.txt.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, default=SERVICE / "dist", help="where the executable is written")
    parser.add_argument("--work", type=Path, default=SERVICE / "build", help="where the build keeps its working files")
    args = parser.parse_args()
    dist, work = args.dist.resolve(), args.work.resolve()
    data = SERVICE / "turf_service" / "data"
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--console", "--name", "turf-service",
        "--distpath", str(dist), "--workpath", str(work), "--specpath", str(work),
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
    built = dist / ("turf-service.exe" if os.name == "nt" else "turf-service")
    print(f"Built {built} ({built.stat().st_size / 1_048_576:.0f} MB)")


if __name__ == "__main__":
    main()
