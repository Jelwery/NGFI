from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat

from .contracts import strict_object, require_hash
from .hashing import stable_hash
from .research_contracts import ResearchDataset, ResearchSpec

MAX_BYTES = 128 * 1024 * 1024


def compute_research(operation: str, value: dict) -> dict:
    if operation == "parse-json":
        strict_object(value, {"text"}, set(), operation)
        from .agent_bridge import _unique_object
        if not isinstance(value["text"], str):
            raise ValueError("JSON input must be text")
        parsed = json.loads(value["text"], object_pairs_hook=_unique_object,
                            parse_constant=lambda item: (_ for _ in ()).throw(ValueError("non-finite JSON")))
        if not isinstance(parsed, dict):
            raise ValueError("JSON input must be an object")
        return parsed
    if operation == "catalog":
        from .factors.graph import factor_catalog
        strict_object(value, set(), set(), operation)
        return factor_catalog()
    if operation == "schema":
        strict_object(value, set(), set(), operation)
        return {"dataset": ResearchDataset.model_json_schema(by_alias=True), "spec": ResearchSpec.model_json_schema(by_alias=True)}
    if operation == "demo":
        from .demo import demo_input
        strict_object(value, set(), set(), operation)
        dataset, spec = demo_input()
        return {"dataset": dataset, "spec": spec}
    if operation == "validate-dataset":
        strict_object(value, {"dataset"}, set(), operation)
        dataset = ResearchDataset.model_validate(value["dataset"])
        return {"dataset": dataset.json(), "datasetId": dataset.hash}
    if operation == "validate-spec":
        strict_object(value, {"spec"}, set(), operation)
        return {"spec": ResearchSpec.model_validate(value["spec"]).json()}
    if operation == "run":
        from .experiment import run_experiment
        strict_object(value, {"dataset", "spec"}, set(), operation)
        return run_experiment(ResearchDataset.model_validate(value["dataset"]), ResearchSpec.model_validate(value["spec"]))
    raise ValueError("unknown research computation")


def artifact_computation(value: dict) -> dict:
    strict_object(value, {"operation", "inputHash"}, set(), "artifact computation")
    require_hash(value["inputHash"], "inputHash")
    root = Path(os.environ["NGFI_QUANT_TRANSPORT"])
    for component in [*reversed(root.parents), root]:
        if component.is_symlink():
            raise ValueError("transport directory cannot contain symlinks")
    metadata = root.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("transport directory must be private")
    descriptor = os.open(root / "input.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
            raise ValueError("input artifact must be regular and at most 128 MiB")
        chunks, total = [], 0
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 65536):
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError("input artifact exceeds 128 MiB")
            chunks.append(chunk)
            digest.update(chunk)
    finally:
        os.close(descriptor)
    if "sha256:" + digest.hexdigest() != value["inputHash"]:
        raise ValueError("input artifact hash mismatch")
    from .agent_bridge import _unique_object
    parsed = json.loads(b"".join(chunks), object_pairs_hook=_unique_object,
                        parse_constant=lambda item: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    result = compute_research(value["operation"], parsed)
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    digest, total = hashlib.sha256(), 0
    descriptor = os.open(root / "output.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        for fragment in encoder.iterencode(result):
            chunk = fragment.encode("utf-8")
            total += len(chunk)
            if total > MAX_BYTES:
                raise ValueError("output artifact exceeds 128 MiB")
            stream.write(chunk)
            digest.update(chunk)
        stream.flush()
        os.fsync(stream.fileno())
    return {"hash": "sha256:" + digest.hexdigest(), "bytes": total}
