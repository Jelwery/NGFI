"""Single-host content-addressed research artifacts, without caller-controlled paths."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import tempfile

from .experiment import run_experiment
from .hashing import stable_hash
from .research_contracts import ResearchDataset, ResearchSpec
from .research_factors import factor_catalog

MAX_FILE_BYTES = 128 * 1024 * 1024
IDENTITY = re.compile(r"^sha256:[a-f0-9]{64}$")


class ExperimentStore:
    def __init__(self, root: str | Path):
        self.root = Path(root).absolute()
        for path in [*reversed(self.root.parents), self.root]:
            if path.is_symlink():
                raise ValueError("research store root cannot contain symlinks")
            path.mkdir(exist_ok=True, mode=0o700)
            if not path.is_dir():
                raise ValueError("research store root must be a directory")
        self._require_private_directory(self.root)
        for kind in ("datasets", "runs"):
            path = self.root / kind
            if path.is_symlink():
                raise ValueError("research artifact directory cannot be a symlink")
            path.mkdir(exist_ok=True, mode=0o700)
            self._require_private_directory(path)

    @staticmethod
    def _require_private_directory(path: Path) -> None:
        metadata = path.stat(follow_symlinks=False)
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ValueError("research store directories must be private and owned by the current user")

    def _path(self, kind: str, identity: str) -> Path:
        if not isinstance(identity, str) or not IDENTITY.fullmatch(identity):
            raise ValueError("artifact id must be a sha256 content hash")
        path = self.root / kind / f"{identity[7:]}.json"
        if path.parent.is_symlink() or path.is_symlink():
            raise ValueError("research artifacts cannot be symlinks")
        return path

    def _read(self, kind: str, identity: str) -> dict:
        path = self._path(kind, identity)
        if not path.is_file():
            raise ValueError("research artifact does not exist")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("research artifact exceeds size limit")
        document = json.loads(path.read_text())
        if document["hash"] != stable_hash(document["content"]):
            raise ValueError("research artifact content hash mismatch")
        return document["content"]

    def _write(self, kind: str, identity: str, content: dict) -> None:
        path = self._path(kind, identity)
        if path.exists():
            if self._read(kind, identity) != content:
                raise ValueError("immutable artifact identity conflict")
            return
        payload = json.dumps({"hash": stable_hash(content), "content": content},
                             ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(payload.encode()) > MAX_FILE_BYTES:
            raise ValueError("research artifact exceeds size limit")
        descriptor, temporary = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @contextmanager
    def writer(self):
        # Advisory locks are released by the OS on interruption; do not unlink an active lock inode.
        import fcntl
        lock = self.root / ".writer.lock"
        if lock.is_symlink():
            raise ValueError("research writer lock cannot be a symlink")
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("research workspace is locked by another writer") from None
            yield
        finally:
            os.close(descriptor)

    def import_dataset(self, value: dict) -> dict:
        dataset = ResearchDataset.model_validate(value)
        identity = dataset.hash
        with self.writer():
            self._write("datasets", identity, dataset.json())
        return {"datasetId": identity, "snapshotId": dataset.snapshot_id, "rows": len(dataset.bars),
                "sessions": len(dataset.calendar), "securities": len({bar.instrument.key for bar in dataset.bars}),
                "asOf": dataset.as_of}

    def dataset(self, identity: str) -> ResearchDataset:
        dataset = ResearchDataset.model_validate(self._read("datasets", identity))
        if dataset.hash != identity:
            raise ValueError("dataset id/content mismatch")
        return dataset

    def run(self, dataset_id: str, value: dict) -> dict:
        spec = ResearchSpec.model_validate(value)
        with self.writer():
            dataset = self.dataset(dataset_id)
            if len(dataset.bars) * len(spec.factors) > 2_000_000:
                raise ValueError("factor panel exceeds two million cells; reduce the experiment scope")
            result = run_experiment(dataset, spec)
            self._write("runs", result["id"], result)
        return {"runId": result["id"], "datasetId": dataset_id, "specHash": result["specHash"],
                "artifactHashes": result["artifactHashes"], **result["summary"]}

    def get(self, identity: str, section: str = "summary", offset: int = 0, limit: int = 50) -> dict:
        if section not in {"summary", "spec", "models", "predictions", "factors", "diagnostics",
                           "factorSummary", "correlations", "modelDiagnostics",
                           "equity", "orders", "fills", "decisions", "benchmark"}:
            raise ValueError("unknown research result section")
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("offset must be nonnegative and limit must be in [1, 200]")
        result = self._read("runs", identity)
        if result["id"] != identity:
            raise ValueError("run id/content mismatch")
        if section in {"equity", "orders", "fills", "decisions"}:
            value = result["backtest"][section]
        elif section == "benchmark":
            value = result["benchmark"]["metrics"]
        elif section == "diagnostics":
            value = [{"factor": name, **row} for name, item in result["diagnostics"].items() for row in item["daily"]]
        elif section == "factorSummary":
            value = [{"factor": name, **{key: value for key, value in item.items() if key != "daily"}}
                     for name, item in result["diagnostics"].items()]
        else:
            value = result[section]
        if isinstance(value, list):
            return {"runId": identity, "section": section, "total": len(value),
                    "offset": offset, "items": value[offset:offset + limit]}
        return {"runId": identity, "section": section, "value": value}

    def list_runs(self) -> dict:
        files = sorted((self.root / "runs").glob("*.json"), key=lambda path: path.name)
        datasets = sorted((self.root / "datasets").glob("*.json"), key=lambda path: path.name)
        return {"runIds": [f"sha256:{path.stem}" for path in files[:200]], "total": len(files),
                "datasetIds": [f"sha256:{path.stem}" for path in datasets[:200]], "datasetCount": len(datasets)}


def dispatch_research(root: str | Path, value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("research request must be an object")
    action = value.get("action")
    allowed = {
        "catalog": {"action"},
        "schema": {"action"},
        "import": {"action", "dataset"},
        "run": {"action", "datasetId", "spec"},
        "get": {"action", "runId", "section", "offset", "limit"},
        "list": {"action"},
    }
    if not isinstance(action, str) or action not in allowed or set(value) - allowed[action]:
        raise ValueError("unknown research action or unsupported parameters")
    if action == "catalog":
        return factor_catalog()
    if action == "schema":
        return {"dataset": ResearchDataset.model_json_schema(by_alias=True),
                "spec": ResearchSpec.model_json_schema(by_alias=True)}
    required = {"import": {"dataset"}, "run": {"datasetId", "spec"}, "get": {"runId"}, "list": set()}
    if not required[action] <= value.keys():
        raise ValueError(f"missing parameters for {action}: {sorted(required[action] - value.keys())}")
    store = ExperimentStore(root)
    if action == "import":
        return store.import_dataset(value["dataset"])
    if action == "run":
        return store.run(value["datasetId"], value["spec"])
    if action == "get":
        return store.get(value["runId"], value.get("section", "summary"), value.get("offset", 0), value.get("limit", 50))
    return store.list_runs()
