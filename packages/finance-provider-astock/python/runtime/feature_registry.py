from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

PYTHON_ROOT = Path(__file__).resolve().parents[1]
PROVIDER_ROOT = PYTHON_ROOT.parent
REGISTRY_PATH = PROVIDER_ROOT / "feature-registry.json"
SOURCE_MANIFEST_PATH = PROVIDER_ROOT / "upstream" / "source-manifest.json"
CAPABILITY_MANIFEST_PATH = PROVIDER_ROOT / "upstream" / "capability-manifest.json"


class RegistryError(RuntimeError):
  pass


def _read_json(path: Path) -> dict[str, Any]:
  try:
    value = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError) as exc:
    raise RegistryError(f"cannot load {path.name}") from exc
  if not isinstance(value, dict):
    raise RegistryError(f"{path.name} must contain an object")
  return value


@lru_cache(maxsize=1)
def registry() -> dict[str, Any]:
  document = _read_json(REGISTRY_PATH)
  features = document.get("features")
  if document.get("schemaVersion") != 1 or not isinstance(features, list) or len(features) != 60:
    raise RegistryError("feature registry must contain exactly 60 version-1 features")
  capability_manifest = _read_json(CAPABILITY_MANIFEST_PATH)
  capabilities = capability_manifest.get("capabilities")
  if not isinstance(capabilities, list) or len(capabilities) != 60:
    raise RegistryError("upstream capability manifest must contain exactly 60 entries")
  expected = {item.get("id"): item for item in capabilities if isinstance(item, dict)}
  seen_features: set[str] = set()
  seen_capabilities: set[str] = set()
  optional_auth: list[str] = []
  for feature in features:
    if not isinstance(feature, dict):
      raise RegistryError("feature registry entry must be an object")
    feature_id = feature.get("featureId")
    capability_id = feature.get("upstreamCapabilityId")
    if not isinstance(feature_id, str) or not feature_id or feature_id in seen_features:
      raise RegistryError("feature IDs must be unique non-empty strings")
    if not isinstance(capability_id, str) or capability_id in seen_capabilities or capability_id not in expected:
      raise RegistryError(f"invalid capability mapping for {feature_id}")
    seen_features.add(feature_id)
    seen_capabilities.add(capability_id)
    variants = feature.get("variants")
    if not isinstance(variants, list) or not variants:
      raise RegistryError(f"{feature_id} must declare variants")
    mapped = sorted({item.get("upstreamCallable") for item in variants if isinstance(item, dict)})
    upstream = sorted(expected[capability_id].get("upstreamCallables", []))
    if mapped != upstream:
      raise RegistryError(f"{feature_id} does not map every upstream callable")
    if feature.get("auth") == "api-key":
      optional_auth.append(capability_id)
  if seen_capabilities != set(expected) or optional_auth != ["capability-008"]:
    raise RegistryError("feature registry capability/auth coverage is incomplete")
  return document


@lru_cache(maxsize=1)
def source_policies() -> dict[str, dict[str, Any]]:
  document = _read_json(SOURCE_MANIFEST_PATH)
  sources = document.get("sources")
  if not isinstance(sources, list):
    raise RegistryError("source manifest has no sources")
  return {item["id"]: item for item in sources if isinstance(item, dict) and isinstance(item.get("id"), str)}


@lru_cache(maxsize=1)
def features_by_id() -> dict[str, dict[str, Any]]:
  return {item["featureId"]: item for item in registry()["features"]}


def feature(feature_id: str) -> dict[str, Any]:
  selected = features_by_id().get(feature_id)
  if selected is None:
    raise RegistryError("feature is not allowlisted")
  return selected


def variant(feature_entry: dict[str, Any], variant_id: str | None) -> dict[str, Any]:
  variants = feature_entry["variants"]
  selected_id = variant_id or variants[0]["id"]
  selected = next((item for item in variants if item["id"] == selected_id), None)
  if selected is None:
    raise RegistryError("feature variant is not allowlisted")
  return selected
