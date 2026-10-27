"""Turf's Python worker (plan 2.1, Python): imports, Skip Tracing jobs, report files and the legacy project import.

It claims jobs from the API's internal routes and never connects to the database; the phone and status rules are
the desktop service's own (service/turf_matching), so a list checked on the server and on a laptop reads the same.
"""

import sys
from pathlib import Path

# The shared rules live in the repository's service folder; a container copies them beside this package.
_service = Path(__file__).resolve().parents[5] / "service"
if _service.is_dir() and str(_service) not in sys.path:
    sys.path.append(str(_service))
