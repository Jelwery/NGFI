"""Keep relocated quant tests/bridge subprocesses importable from the repo root."""
import os
from pathlib import Path
import sys

PACKAGE_ROOT = str(Path(__file__).resolve().parents[1])
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)
os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, (PACKAGE_ROOT, os.environ.get("PYTHONPATH"))))
