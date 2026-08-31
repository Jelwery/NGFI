#!/usr/bin/env python3
"""Blind-grade paired investment behavior eval outputs with the real DSH model."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT / "skills" / "investment-behavior-diagnosis-workspace"
NODE = shutil.which("node") or "node"
DSH = ROOT / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
DOTENV_LINE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def project_environment() -> dict[str, str]:
    environment = os.environ.copy()
    path = ROOT / ".env"
    if not path.exists():
        return environment
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = DOTENV_LINE.match(line)
        if match is None or match.group(1) in environment:
            continue
        value = match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        else:
            value = re.sub(r"\s+#.*$", "", value).strip()
        environment[match.group(1)] = value
    return environment


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("iteration", type=int, nargs="?", default=2)
    parser.add_argument("--ids", help="comma-separated case ids")
    parser.add_argument("--jobs", type=int, default=3)
    return parser.parse_args()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    fence = chr(96) * 3
    if cleaned.startswith(fence):
        cleaned = cleaned.split("\n", 1)[1]
    if cleaned.endswith(fence):
        cleaned = cleaned[: -len(fence)].rstrip()
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("judge did not return a JSON object")
        value = json.loads(cleaned[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("judge result must be an object")
    return value


def validate_judgment(value: dict[str, Any], case: dict[str, Any], rubric: dict[str, Any]) -> None:
    if not isinstance(value.get("grades"), dict) or not isinstance(value.get("comparison"), dict):
        raise ValueError("judge result is missing grades or comparison")
    for side in ("A", "B"):
        grade = value["grades"].get(side)
        if not isinstance(grade, dict):
            raise ValueError(f"side {side} grade is missing")
        expectations = grade.get("expectations")
        if not isinstance(expectations, list) or len(expectations) != len(case["expectations"]):
            raise ValueError(f"side {side} has the wrong expectation count")
        for index, expected_text in enumerate(case["expectations"]):
            verdict = expectations[index]
            if (
                not isinstance(verdict, dict)
                or verdict.get("text") != expected_text
                or not isinstance(verdict.get("passed"), bool)
                or not isinstance(verdict.get("evidence"), str)
            ):
                raise ValueError(f"side {side} expectation {index + 1} is malformed")
        scores = grade.get("rubric_scores")
        evidence = grade.get("rubric_evidence")
        for dimension in rubric["dimensions"]:
            dimension_id = dimension["id"]
            score = scores.get(dimension_id) if isinstance(scores, dict) else None
            if not isinstance(score, int) or score < 0 or score > 4:
                raise ValueError(f"side {side} has invalid {dimension_id} score")
            if not isinstance(evidence, dict) or not isinstance(evidence.get(dimension_id), str):
                raise ValueError(f"side {side} lacks {dimension_id} evidence")
        hard_failures = grade.get("hard_failures")
        if not isinstance(hard_failures, list) or any(
            item not in rubric["hardFailures"] for item in hard_failures
        ):
            raise ValueError(f"side {side} has an invalid hard failure id")
    if value["comparison"].get("winner") not in ("A", "B", "TIE"):
        raise ValueError("comparison has an invalid winner")
    comparison_rubric = value["comparison"].get("rubric")
    output_quality = value["comparison"].get("output_quality")
    for side in ("A", "B"):
        side_rubric = comparison_rubric.get(side) if isinstance(comparison_rubric, dict) else None
        if not isinstance(side_rubric, dict):
            raise ValueError(f"comparison side {side} rubric is missing")
        for group in ("content", "structure"):
            scores = side_rubric.get(group)
            if not isinstance(scores, dict) or any(
                not isinstance(score, (int, float)) or score < 1 or score > 5
                for score in scores.values()
            ):
                raise ValueError(f"comparison side {side} has invalid {group} scores")
        if any(
            not isinstance(side_rubric.get(field), (int, float))
            or side_rubric[field] < 1
            or side_rubric[field] > maximum
            for field, maximum in (("content_score", 5), ("structure_score", 5), ("overall_score", 10))
        ):
            raise ValueError(f"comparison side {side} has invalid aggregate scores")
        quality = output_quality.get(side) if isinstance(output_quality, dict) else None
        if (
            not isinstance(quality, dict)
            or not isinstance(quality.get("score"), (int, float))
            or quality["score"] < 1
            or quality["score"] > 10
            or not isinstance(quality.get("strengths"), list)
            or not isinstance(quality.get("weaknesses"), list)
        ):
            raise ValueError(f"comparison side {side} has invalid output quality")


def judge_prompt(
    case: dict[str, Any],
    rubric_text: str,
    rubric: dict[str, Any],
    answer_a: str,
    answer_b: str,
    tools_a: list[str],
    tools_b: list[str],
) -> str:
    dimensions = {item["id"]: 0 for item in rubric["dimensions"]}
    dimension_evidence = {item["id"]: "具体依据" for item in rubric["dimensions"]}
    schema = {
        "grades": {
            "A": {
                "expectations": [
                    {"text": text, "passed": True, "evidence": "具体引文或缺失说明"}
                    for text in case["expectations"]
                ],
                "rubric_scores": dimensions,
                "rubric_evidence": dimension_evidence,
                "hard_failures": [],
                "claims": [
                    {
                        "claim": "值得核验的核心断言",
                        "type": "factual|process|quality",
                        "verified": True,
                        "evidence": "依据",
                    }
                ],
            },
            "B": "与 A 相同结构",
        },
        "comparison": {
            "winner": "A|B|TIE",
            "reasoning": "具体比较理由",
            "rubric": {
                "A": {
                    "content": {"correctness": 3, "completeness": 3, "accuracy": 3},
                    "structure": {"organization": 3, "formatting": 3, "usability": 3},
                    "content_score": 3,
                    "structure_score": 3,
                    "overall_score": 6,
                },
                "B": "与 A 相同结构",
            },
            "output_quality": {
                "A": {"score": 2, "strengths": [], "weaknesses": []},
                "B": {"score": 2, "strengths": [], "weaknesses": []},
            },
        },
    }
    return "\n".join(
        [
            "你是独立、严格的行为金融回答评测员。A/B 身份已随机化；不要猜测它们对应哪个版本。",
            "不调用任何工具，不使用外部事实，只依据用户 prompt、回答文本和已给出的工具轨迹。",
            "逐字按语义断言判定，合取要求缺一项即失败；证据不足时失败。",
            "分别按 rubric 的 0-4 整数分评分，并只使用列出的 hard failure id。",
            "最后盲选整体更好的一侧；rubric 内容质量优先，断言为次要证据，真正等价才 TIE。",
            "comparison 的六个子项必须用 1-5 分，content_score/structure_score 用 1-5 分，overall_score 和 output_quality.score 用 1-10 分。",
            "只输出一个 JSON 对象，不要 Markdown 围栏或额外解释。",
            "",
            "JSON schema：",
            json.dumps(schema, ensure_ascii=False, indent=2),
            "",
            "用户 prompt：",
            case["prompt"],
            "",
            "要判定的语义断言（顺序和文本必须原样返回）：",
            json.dumps(case["expectations"], ensure_ascii=False, indent=2),
            "",
            "完整 rubric：",
            rubric_text,
            "",
            "回答 A 的工具轨迹（仅作为事实，不据此猜版本）：",
            json.dumps(tools_a, ensure_ascii=False),
            "回答 A：",
            answer_a,
            "",
            "回答 B 的工具轨迹（仅作为事实，不据此猜版本）：",
            json.dumps(tools_b, ensure_ascii=False),
            "回答 B：",
            answer_b,
        ]
    )


def run_judge(
    prompt: str, iteration: int, base_environment: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    empty_skills = WORKSPACE / f"iteration-{iteration}" / "grader-skills"
    empty_skills.mkdir(parents=True, exist_ok=True)
    environment = base_environment.copy()
    environment.update(
        {
            "DSH_HOME": str(ROOT / ".runtime"),
            "DSH_PERMISSION_MODE": "read-only",
            "DSH_TELEMETRY_MODE": "DISABLED",
            "FINANCE2DSH_SKILLS_DIR": str(empty_skills),
            "FINANCE2DSH_RESULT_FORMAT": "json",
        }
    )
    process = subprocess.run(
        [str(NODE), str(DSH), "--profile", "finance-headless", prompt],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=600,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(
            f"DSH judge failed with status {process.returncode}: "
            f"{process.stderr[-4000:] or process.stdout[-4000:]}"
        )
    line = process.stdout.strip().splitlines()[-1]
    dsh_result = json.loads(line)
    if dsh_result.get("toolCalls"):
        raise ValueError(f"judge unexpectedly called tools: {dsh_result['toolCalls']}")
    judgment = extract_json(dsh_result["text"])
    duration_ms = int(dsh_result.get("durationMs", 0))
    timing = {
        "total_tokens": int(dsh_result.get("usage", {}).get("totalTokens", 0)),
        "duration_ms": duration_ms,
        "total_duration_seconds": duration_ms / 1000,
    }
    return judgment, timing


def tool_expectations(case: dict[str, Any], calls: list[str]) -> list[dict[str, Any]]:
    assertions: list[dict[str, Any]] = []
    required = case["requiredTools"]
    forbidden = case["forbiddenTools"]
    if required:
        missing = [tool for tool in required if tool not in calls]
        assertions.append(
            {
                "text": f"工具轨迹包含要求的工具：{', '.join(required)}。",
                "passed": not missing,
                "evidence": (
                    f"outputs/result.json 的 toolCalls 包含全部要求工具。实际轨迹：{', '.join(calls) or '(none)'}。"
                    if not missing
                    else f"缺少要求工具：{', '.join(missing)}。实际轨迹：{', '.join(calls) or '(none)'}。"
                ),
            }
        )
    if forbidden:
        used = [tool for tool in forbidden if tool in calls]
        assertions.append(
            {
                "text": f"工具轨迹不包含禁止的工具：{', '.join(forbidden)}。",
                "passed": not used,
                "evidence": (
                    f"实际轨迹为 {', '.join(calls) or '(none)'}；未出现禁止工具。"
                    if not used
                    else f"实际轨迹使用了禁止工具：{', '.join(used)}。"
                ),
            }
        )
    return assertions


def weighted_total(grade: dict[str, Any], rubric: dict[str, Any]) -> float:
    return sum(
        grade["rubric_scores"][item["id"]] / 4 * item["weight"]
        for item in rubric["dimensions"]
    )


def rubric_pass(grade: dict[str, Any], total: float, rubric: dict[str, Any]) -> bool:
    rules = rubric["pass"]
    if total < rules["minimumTotal"]:
        return False
    if rules["requireNoHardFailures"] and grade["hard_failures"]:
        return False
    return all(
        grade["rubric_scores"].get(dimension, 0) >= minimum
        for dimension, minimum in rules["minimumDimensionScores"].items()
    )


def grade_case(
    case: dict[str, Any], iteration: int, rubric_text: str, rubric: dict[str, Any],
    environment: dict[str, str],
) -> dict[str, Any]:
    iteration_dir = WORKSPACE / f"iteration-{iteration}"
    eval_dir = iteration_dir / f"eval-{case['id']}-{case['name']}"
    blind_dir = iteration_dir / "blind-comparisons" / f"eval-{case['id']}-{case['name']}"
    mapping = (
        {"A": "new_skill", "B": "old_skill"}
        if case["id"] % 2 == 1
        else {"A": "old_skill", "B": "new_skill"}
    )
    answers = {
        side: (blind_dir / side / "answer.md").read_text() for side in ("A", "B")
    }
    results = {
        side: read_json(eval_dir / config / "run-1" / "outputs" / "result.json")
        for side, config in mapping.items()
    }
    tools = {side: result.get("toolCalls", []) for side, result in results.items()}
    judgment, judge_timing = run_judge(
        judge_prompt(
            case,
            rubric_text,
            rubric,
            answers["A"],
            answers["B"],
            tools["A"],
            tools["B"],
        ),
        iteration,
        environment,
    )
    validate_judgment(judgment, case, rubric)
    (blind_dir / "judge-timing.json").write_text(
        json.dumps(judge_timing, ensure_ascii=False, indent=2) + "\n"
    )
    (blind_dir / "comparison.json").write_text(
        json.dumps(judgment["comparison"], ensure_ascii=False, indent=2) + "\n"
    )

    for side, configuration in mapping.items():
        run_dir = eval_dir / configuration / "run-1"
        grade = judgment["grades"][side]
        expectations = grade["expectations"] + tool_expectations(case, tools[side])
        passed = sum(bool(item["passed"]) for item in expectations)
        total = weighted_total(grade, rubric)
        grading = {
            "expectations": expectations,
            "summary": {
                "passed": passed,
                "failed": len(expectations) - passed,
                "total": len(expectations),
                "pass_rate": passed / len(expectations),
            },
            "rubric_scores": grade["rubric_scores"],
            "rubric_evidence": grade["rubric_evidence"],
            "weighted_total": total,
            "hard_failures": grade["hard_failures"],
            "pass": rubric_pass(grade, total, rubric),
            "execution_metrics": read_json(run_dir / "outputs" / "metrics.json"),
            "timing": read_json(run_dir / "timing.json"),
            "claims": grade.get("claims", []),
            "user_notes_summary": {
                "uncertainties": [],
                "needs_review": [],
                "workarounds": [],
            },
            "eval_feedback": {
                "suggestions": [],
                "overall": "固定断言配合七维 rubric；工具断言由程序确定性判定。",
            },
            "grading_provenance": {
                "method": "single blinded pair judge plus deterministic tool checks",
                "side": side,
                "judge_timing": judge_timing,
            },
        }
        (run_dir / "grading.json").write_text(
            json.dumps(grading, ensure_ascii=False, indent=2) + "\n"
        )
    return {"caseId": case["id"], "winner": judgment["comparison"]["winner"]}


def main() -> None:
    args = parse_args()
    if args.iteration < 1 or args.jobs < 1 or args.jobs > 8:
        raise ValueError("iteration must be positive and jobs must be between 1 and 8")
    cases = read_json(ROOT / "evals" / "cases" / "investment-behavior-diagnosis.json")
    requested = {int(value) for value in args.ids.split(",")} if args.ids else None
    selected = [case for case in cases if requested is None or case["id"] in requested]
    rubric_path = ROOT / "evals" / "rubric" / "investment-behavior-diagnosis.yml"
    rubric_text = rubric_path.read_text()
    rubric = yaml.safe_load(rubric_text)
    environment = project_environment()
    preparation = subprocess.run(
        [NODE, "--import", "tsx", "src/runtime.ts", "prepare", "--require-credential"],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if preparation.returncode != 0:
        raise RuntimeError(preparation.stderr[-4000:] or preparation.stdout[-4000:])
    with ThreadPoolExecutor(max_workers=min(args.jobs, len(selected))) as executor:
        futures = [
            executor.submit(grade_case, case, args.iteration, rubric_text, rubric, environment)
            for case in selected
        ]
        for future in as_completed(futures):
            print(json.dumps(future.result(), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
