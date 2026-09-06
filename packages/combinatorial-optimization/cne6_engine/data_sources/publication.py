"""Safe resolution helpers for content-addressed CNE6 publications.

Published data roots may use the legacy ``quality-report.json``/``reference``
layout, or a ``CURRENT`` pointer to an immutable directory below
``snapshots``.  A present pointer is authoritative: malformed or dangling
pointers never fall back to legacy data.
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any, Iterable

SNAPSHOT_ID_RE = re.compile(rb"[0-9a-f]{64}\n")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
MAX_QUALITY_REPORT_BYTES = 8 * 1024 * 1024


def _open_current(path: Path) -> bytes | None:
    """Read CURRENT without following a final-component symlink."""
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0))
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ValueError("CURRENT must not be a symlink") from exc
        raise
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("CURRENT must be a regular file")
        payload = os.read(fd, 66)
        if os.read(fd, 1):
            payload += b"x"
    finally:
        os.close(fd)
    return payload


def read_current_snapshot_id(data_root: Path) -> str | None:
    """Return the strictly encoded CURRENT id, or ``None`` if absent."""
    payload = _open_current(data_root / "CURRENT")
    if payload is None:
        return None
    if SNAPSHOT_ID_RE.fullmatch(payload) is None:
        raise ValueError("CURRENT must contain one lowercase 64-hex id and a newline")
    return payload[:-1].decode("ascii")


def _require_plain_directory(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"{label} is missing: {path}") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise ValueError(f"{label} must not be a symlink")
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"{label} must be a directory")


def _require_plain_file(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"{label} is missing: {path}") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise ValueError(f"{label} must not be a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} must be a regular file")


def _read_regular_file(path: Path, label: str, maximum: int) -> bytes:
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0))
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ValueError(f"{label} must not be a symlink") from exc
        raise
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f"{label} must be a regular file")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > maximum:
            raise ValueError(f"{label} exceeds its size limit")
        return payload
    finally:
        os.close(fd)


def _hash_regular_asset(path: Path, expected_bytes: int) -> str:
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
             | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0))
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ValueError(f"snapshot asset must not be a symlink: {path.name}") from exc
        raise
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"snapshot asset must be a regular file: {path.name}")
        if metadata.st_size != expected_bytes:
            raise ValueError(f"snapshot asset size mismatch: {path.name}")
        digest = hashlib.sha256()
        for chunk in iter(lambda: os.read(fd, 1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(fd)


def verify_snapshot_manifest(
    snapshot_root: Path, snapshot_id: str, *, required_files: Iterable[str] = (),
) -> dict[str, Any]:
    """Verify a pinned snapshot's report hash and every manifest asset."""
    root = Path(snapshot_root)
    _require_plain_directory(root, "CURRENT snapshot")
    reference = root / "reference"
    _require_plain_directory(reference, "snapshot reference")
    report_payload = _read_regular_file(
        root / "quality-report.json", "snapshot quality report",
        MAX_QUALITY_REPORT_BYTES,
    )
    if hashlib.sha256(report_payload).hexdigest() != snapshot_id:
        raise ValueError("CURRENT snapshot id does not match quality-report.json")
    try:
        report = json.loads(
            report_payload.decode("utf-8"),
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON number {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("snapshot quality report is not strict JSON") from exc
    if not isinstance(report, dict) or not isinstance(report.get("assets"), dict):
        raise ValueError("snapshot quality report has no asset manifest")

    manifest_files: set[str] = set()
    for key, entry in report["assets"].items():
        if not isinstance(key, str) or not isinstance(entry, dict):
            raise ValueError("snapshot asset manifest entry is invalid")
        if set(entry) != {"file", "bytes", "sha256"}:
            raise ValueError(f"snapshot asset manifest entry is invalid: {key}")
        filename = entry.get("file")
        expected_bytes = entry.get("bytes")
        expected_hash = entry.get("sha256")
        if (not isinstance(filename, str) or not filename
                or "/" in filename or "\\" in filename
                or filename in {".", ".."}):
            raise ValueError(f"snapshot asset filename is unsafe: {key}")
        if filename in manifest_files:
            raise ValueError("snapshot asset filenames must be unique")
        if (not isinstance(expected_bytes, int) or isinstance(expected_bytes, bool)
                or expected_bytes < 0):
            raise ValueError(f"snapshot asset byte count is invalid: {key}")
        if not isinstance(expected_hash, str) or SHA256_RE.fullmatch(expected_hash) is None:
            raise ValueError(f"snapshot asset hash is invalid: {key}")
        actual_hash = _hash_regular_asset(reference / filename, expected_bytes)
        if actual_hash != expected_hash:
            raise ValueError(f"snapshot asset hash mismatch: {filename}")
        manifest_files.add(filename)

    missing = set(required_files) - manifest_files
    if missing:
        raise ValueError(f"snapshot manifest lacks configured assets: {sorted(missing)}")
    return report


def resolve_published_root(
    data_root: Path, *, verify_report_hash: bool = True,
) -> tuple[Path, str | None]:
    """Resolve CURRENT once and return the selected publication root.

    Legacy fallback is permitted only when CURRENT is genuinely absent.
    ``verify_report_hash=False`` is used by configuration assembly, where the
    path must be pinned before any asset is opened; the validating reader
    performs the report check when it consumes the bundle.
    """
    root = Path(data_root)
    _require_plain_directory(root, "published data root")
    snapshot_id = read_current_snapshot_id(root)
    if snapshot_id is None:
        return root, None

    snapshots = root / "snapshots"
    snapshot_root = snapshots / snapshot_id
    _require_plain_directory(snapshots, "snapshots directory")
    _require_plain_directory(snapshot_root, "CURRENT snapshot")
    _require_plain_directory(snapshot_root / "reference", "snapshot reference")
    if verify_report_hash:
        verify_snapshot_manifest(snapshot_root, snapshot_id)
    return snapshot_root, snapshot_id
