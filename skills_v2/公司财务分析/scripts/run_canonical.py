#!/usr/bin/env python3
"""Run one canonical finance script and append an auditable provenance record."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path


ALLOWED = {
    "extract_financials.py",
    "calc_ratios.py",
    "calc_risk_models.py",
    "calc_valuation.py",
}


def digest(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True, choices=sorted(ALLOWED))
    parser.add_argument("--input")
    parser.add_argument("--output", required=True)
    parser.add_argument("script_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    script = Path(__file__).resolve().parent / args.script
    output = Path(args.output).resolve()
    input_path = Path(args.input).resolve() if args.input else None
    command = [sys.executable, str(script)]
    if args.input:
        command.append(str(input_path))
    script_args = list(args.script_args)
    if script_args and script_args[0] == "--":
        script_args.pop(0)
    command.extend(script_args)
    if "-o" not in command and "--output" not in command:
        command.extend(["-o", str(output)])

    started = time.time()
    completed = subprocess.run(command, text=True, capture_output=True)
    record = {
        "script": str(script),
        "script_sha256": digest(script),
        "input": str(input_path) if input_path else None,
        "input_sha256": digest(input_path) if input_path else None,
        "output": str(output),
        "output_sha256": digest(output),
        "exit_code": completed.returncode,
        "duration_seconds": round(time.time() - started, 6),
        "stderr": completed.stderr[-4000:],
    }
    provenance_path = Path.cwd() / "_provenance.json"
    records = []
    if provenance_path.exists():
        try:
            records = json.loads(provenance_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            records = []
    records.append(record)
    provenance_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if completed.stdout:
        print(completed.stdout, end="")
    if completed.stderr:
        print(completed.stderr, end="", file=sys.stderr)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
