from __future__ import annotations

import ast
import re
from functools import lru_cache
from pathlib import Path
from types import MappingProxyType
from typing import Any

PYTHON_ROOT = Path(__file__).resolve().parents[1]
BLOCK_ROOT = PYTHON_ROOT / "generated" / "blocks"
GENERATED_MODULE = PYTHON_ROOT / "generated" / "astock_upstream.py"

PREREQUISITES: dict[str, tuple[str, ...]] = {
  "block-005.py": ("block-001.py",),
  "block-008.py": ("block-002.py", "block-003.py"),
  "block-009.py": ("block-002.py", "block-003.py", "block-004.py"),
  "block-010.py": ("block-004.py", "block-009.py"),
  "block-011.py": ("block-002.py", "block-003.py"),
  "block-015.py": ("block-002.py", "block-003.py", "block-004.py"),
  "block-016.py": ("block-002.py", "block-003.py", "block-004.py"),
  "block-017.py": ("block-004.py",), "block-018.py": ("block-004.py",),
  "block-019.py": ("block-004.py",), "block-020.py": ("block-004.py",),
  "block-021.py": ("block-004.py",), "block-023.py": ("block-004.py",),
  "block-024.py": ("block-004.py",), "block-025.py": ("block-004.py",),
  "block-026.py": ("block-004.py",),
  "block-027.py": ("block-002.py", "block-003.py", "block-004.py"),
  "block-029.py": ("block-004.py",), "block-030.py": ("block-004.py",),
  "block-031.py": ("block-004.py",),
  "block-034.py": ("block-002.py", "block-003.py", "block-004.py"),
  "block-035.py": ("block-002.py",), "block-037.py": ("block-036.py",),
  "block-039.py": ("block-004.py",), "block-041.py": ("block-004.py",),
  "block-042.py": ("block-004.py",), "block-043.py": ("block-004.py", "block-041.py"),
  "block-044.py": ("block-004.py",), "block-045.py": ("block-004.py",),
  "block-046.py": ("block-004.py",), "block-047.py": ("block-004.py",),
  "block-048.py": ("block-002.py", "block-003.py", "block-004.py"),
  "block-060.py": ("block-051.py",), "block-062.py": ("block-004.py",),
}


def _target_names(node: ast.Assign | ast.AnnAssign) -> list[str]:
  targets = node.targets if isinstance(node, ast.Assign) else [node.target]
  return [target.id for target in targets if isinstance(target, ast.Name)]


def _safe_constant(node: ast.AST) -> bool:
  if any(isinstance(child, (ast.Await, ast.Yield, ast.Lambda, ast.NamedExpr)) for child in ast.walk(node)):
    return False
  calls = [child for child in ast.walk(node) if isinstance(child, ast.Call)]
  return all(isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
             and call.func.value.id == "re" and call.func.attr == "compile" for call in calls)


def _safe_tree(path: Path) -> ast.Module:
  source = path.read_text(encoding="utf-8")
  parsed = ast.parse(source, filename=str(path))
  body: list[ast.stmt] = []
  for node in parsed.body:
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
      body.append(node)
    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
      names = _target_names(node)
      value = node.value
      if names and all(name.isupper() or name.startswith("_") for name in names) and _safe_constant(value):
        body.append(node)
  return ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))


def _ordered_blocks(block: str, result: list[str], seen: set[str]) -> None:
  if block in seen:
    return
  if not re.fullmatch(r"block-\d{3}\.py", block):
    raise RuntimeError("snapshot block is not allowlisted")
  for dependency in PREREQUISITES.get(block, ()):
    _ordered_blocks(dependency, result, seen)
  seen.add(block)
  result.append(block)


@lru_cache(maxsize=64)
def load_block(block: str) -> dict[str, Any]:
  ordered: list[str] = []
  _ordered_blocks(block, ordered, set())
  namespace: dict[str, Any] = {"__name__": "ngfi_astock_snapshot"}
  for current in ordered:
    path = BLOCK_ROOT / current
    if not path.is_file() or path.parent != BLOCK_ROOT:
      raise RuntimeError("snapshot block is unavailable")
    exec(compile(_safe_tree(path), str(path), "exec"), namespace, namespace)
  return namespace


@lru_cache(maxsize=1)
def load_generated_module() -> dict[str, Any]:
  namespace: dict[str, Any] = {"__name__": "ngfi_astock_generated"}
  exec(compile(_safe_tree(GENERATED_MODULE), str(GENERATED_MODULE), "exec"), namespace, namespace)
  return namespace


def resolve_callable(runtime: dict[str, Any]) -> Any:
  kind = runtime.get("kind")
  symbol = runtime.get("symbol")
  if not isinstance(symbol, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", symbol):
    raise RuntimeError("snapshot callable is invalid")
  namespace = load_generated_module() if kind == "generated-module" else load_block(runtime.get("block", ""))
  value = namespace.get(symbol)
  if not callable(value):
    raise RuntimeError("snapshot callable is unavailable")
  return value


SNAPSHOT_DEPENDENCIES = MappingProxyType(PREREQUISITES)
