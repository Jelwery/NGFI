#!/usr/bin/env python3
"""Normalize skill-creator benchmark metadata and restore real model-token metrics."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from statistics import mean, stdev
from typing import Any


def stats(values: list[float]) -> dict[str, float]:
    return {
        "mean": round(mean(values), 4),
        "stddev": round(stdev(values), 4) if len(values) > 1 else 0.0,
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def fmt_delta(value: float, digits: int) -> str:
    return f"{value:+.{digits}f}"


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("iteration", type=Path)
    parser.add_argument("--provider", default=os.environ.get("NGFI_LLM_PROVIDER", "deepseek-official"))
    parser.add_argument("--model", default=os.environ.get("NGFI_LLM_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--reasoning-effort", default=os.environ.get("NGFI_REASONING_EFFORT"))
    args = parser.parse_args()
    model_label = f"{args.provider}/{args.model}"
    if args.reasoning_effort:
        model_label += f" ({args.reasoning_effort})"
    benchmark_path = args.iteration / "benchmark.json"
    benchmark = load(benchmark_path)
    eval_names: dict[int, str] = {}
    blind_wins = {"new_skill": 0, "old_skill": 0, "ties": 0}
    rubric_totals: dict[str, list[float]] = {"new_skill": [], "old_skill": []}
    rubric_passes = {"new_skill": 0, "old_skill": 0}
    hard_failures = {"new_skill": 0, "old_skill": 0}
    expectation_counts = {
        "new_skill": {"passed": 0, "total": 0},
        "old_skill": {"passed": 0, "total": 0},
    }
    residual_failures: list[str] = []

    eval_dirs = sorted(
        (path for path in args.iteration.glob("eval-*") if path.is_dir()),
        key=lambda path: int(path.name.split("-", 2)[1]),
    )
    for eval_dir in eval_dirs:
        metadata = load(eval_dir / "eval_metadata.json")
        eval_id = int(metadata["eval_id"])
        eval_names[eval_id] = metadata["eval_name"]
        for configuration in ("new_skill", "old_skill"):
            grading = load(eval_dir / configuration / "run-1" / "grading.json")
            rubric_totals[configuration].append(float(grading["weighted_total"]))
            rubric_passes[configuration] += int(bool(grading["pass"]))
            hard_failures[configuration] += len(grading["hard_failures"])
            expectation_counts[configuration]["passed"] += int(grading["summary"]["passed"])
            expectation_counts[configuration]["total"] += int(grading["summary"]["total"])
            if configuration == "new_skill":
                failed = [
                    item["text"]
                    for item in grading["expectations"]
                    if not item["passed"]
                ]
                if failed:
                    residual_failures.append(
                        f"Case {eval_id} ({metadata['eval_name']}) failed "
                        + "; ".join(failed)
                    )
        comparison = load(
            args.iteration
            / "blind-comparisons"
            / f"eval-{eval_id}-{metadata['eval_name']}"
            / "comparison.json"
        )
        if comparison["winner"] == "TIE":
            blind_wins["ties"] += 1
        else:
            mapping = (
                {"A": "new_skill", "B": "old_skill"}
                if eval_id % 2 == 1
                else {"A": "old_skill", "B": "new_skill"}
            )
            blind_wins[mapping[comparison["winner"]]] += 1

    for run in benchmark["runs"]:
        run["eval_name"] = eval_names[int(run["eval_id"])]
        run_dir = (
            args.iteration
            / f"eval-{run['eval_id']}-{run['eval_name']}"
            / run["configuration"]
            / f"run-{run['run_number']}"
        )
        timing = load(run_dir / "timing.json")
        run["result"]["tokens"] = int(timing["total_tokens"])
        run["result"]["time_seconds"] = float(timing["total_duration_seconds"])

    configurations = [key for key in benchmark["run_summary"] if key != "delta"]
    for configuration in configurations:
        runs = [run for run in benchmark["runs"] if run["configuration"] == configuration]
        benchmark["run_summary"][configuration]["pass_rate"] = stats(
            [float(run["result"]["pass_rate"]) for run in runs]
        )
        benchmark["run_summary"][configuration]["time_seconds"] = stats(
            [float(run["result"]["time_seconds"]) for run in runs]
        )
        benchmark["run_summary"][configuration]["tokens"] = stats(
            [float(run["result"]["tokens"]) for run in runs]
        )
    new_summary = benchmark["run_summary"]["new_skill"]
    old_summary = benchmark["run_summary"]["old_skill"]
    benchmark["run_summary"]["delta"] = {
        "pass_rate": fmt_delta(
            new_summary["pass_rate"]["mean"] - old_summary["pass_rate"]["mean"], 2
        ),
        "time_seconds": fmt_delta(
            new_summary["time_seconds"]["mean"] - old_summary["time_seconds"]["mean"], 1
        ),
        "tokens": fmt_delta(new_summary["tokens"]["mean"] - old_summary["tokens"]["mean"], 0),
    }
    benchmark["metadata"].update(
        {
            "skill_path": str(args.iteration.parents[1] / "investment-behavior-diagnosis"),
            "executor_model": model_label,
            "analyzer_model": f"{model_label} (blinded pair judge)",
            "runs_per_configuration": 1,
        }
    )
    comparable = blind_wins["new_skill"] + blind_wins["old_skill"]
    benchmark["behavior_summary"] = {
        "objective_expectations": {
            key: {
                **counts,
                "pass_rate": round(counts["passed"] / counts["total"], 4),
            }
            for key, counts in expectation_counts.items()
        },
        "rubric_weighted_mean": {
            key: round(mean(values), 4) for key, values in rubric_totals.items()
        },
        "rubric_passes": rubric_passes,
        "hard_failures": hard_failures,
        "blind_comparison": {
            **blind_wins,
            "new_skill_win_rate_among_comparable": round(
                blind_wins["new_skill"] / comparable, 4
            ),
        },
    }
    benchmark["notes"] = [
        (
            "Objective expectation counts are "
            f"{expectation_counts['new_skill']['passed']}/{expectation_counts['new_skill']['total']} "
            f"({expectation_counts['new_skill']['passed'] / expectation_counts['new_skill']['total'] * 100:.2f}%) "
            "for new_skill and "
            f"{expectation_counts['old_skill']['passed']}/{expectation_counts['old_skill']['total']} "
            f"({expectation_counts['old_skill']['passed'] / expectation_counts['old_skill']['total'] * 100:.2f}%) "
            "for old_skill."
        ),
        (
            f"The new skill passed the behavior rubric on {rubric_passes['new_skill']}/{len(eval_names)} "
            f"cases with {hard_failures['new_skill']} hard failures; the old skill passed "
            f"{rubric_passes['old_skill']}/{len(eval_names)} with {hard_failures['old_skill']} hard failures."
        ),
        (
            f"Blind comparison favored the new skill in {blind_wins['new_skill']} of {comparable} "
            f"non-tied cases ({blind_wins['new_skill'] / comparable * 100:.2f}%); "
            f"{blind_wins['ties']} case(s) tied."
        ),
        "Token metrics come from each real DSH result's usage.totalTokens, not output character counts.",
        (
            "Residual new-skill assertion gaps: " + " | ".join(residual_failures)
            if residual_failures
            else "The new skill has no residual assertion gaps in this iteration."
        ),
    ]
    benchmark_path.write_text(json.dumps(benchmark, ensure_ascii=False, indent=2) + "\n")

    lines = [
        "# Skill Benchmark: investment-behavior-diagnosis",
        "",
        f"**Model**: {model_label}",
        f"**Date**: {benchmark['metadata']['timestamp']}",
        "**Runs**: 12 fixed evals, 1 real DSH run per configuration",
        "",
        "## Summary",
        "",
        "| Metric | New skill | Original skill | Delta |",
        "|---|---:|---:|---:|",
        (
            f"| Objective expectations (pooled) | {expectation_counts['new_skill']['passed']}/"
            f"{expectation_counts['new_skill']['total']} "
            f"({expectation_counts['new_skill']['passed'] / expectation_counts['new_skill']['total'] * 100:.2f}%) "
            f"| {expectation_counts['old_skill']['passed']}/{expectation_counts['old_skill']['total']} "
            f"({expectation_counts['old_skill']['passed'] / expectation_counts['old_skill']['total'] * 100:.2f}%) "
            f"| {(expectation_counts['new_skill']['passed'] / expectation_counts['new_skill']['total'] - expectation_counts['old_skill']['passed'] / expectation_counts['old_skill']['total']) * 100:+.2f} pp |"
        ),
        (
            f"| Mean per-case pass rate | {new_summary['pass_rate']['mean'] * 100:.2f}% "
            f"| {old_summary['pass_rate']['mean'] * 100:.2f}% "
            f"| {float(benchmark['run_summary']['delta']['pass_rate']) * 100:+.2f} pp |"
        ),
        (
            f"| Behavior rubric mean | {mean(rubric_totals['new_skill']):.2f} "
            f"| {mean(rubric_totals['old_skill']):.2f} "
            f"| {mean(rubric_totals['new_skill']) - mean(rubric_totals['old_skill']):+.2f} |"
        ),
        f"| Rubric cases passed | {rubric_passes['new_skill']}/{len(eval_names)} | {rubric_passes['old_skill']}/{len(eval_names)} | +{rubric_passes['new_skill'] - rubric_passes['old_skill']} |",
        f"| Hard failures | {hard_failures['new_skill']} | {hard_failures['old_skill']} | {hard_failures['new_skill'] - hard_failures['old_skill']:+d} |",
        (
            f"| Mean duration | {new_summary['time_seconds']['mean']:.2f}s "
            f"| {old_summary['time_seconds']['mean']:.2f}s "
            f"| {benchmark['run_summary']['delta']['time_seconds']}s |"
        ),
        (
            f"| Mean model tokens | {new_summary['tokens']['mean']:.2f} "
            f"| {old_summary['tokens']['mean']:.2f} "
            f"| {benchmark['run_summary']['delta']['tokens']} |"
        ),
        "",
        "## Blind comparison",
        "",
        f"- New skill: {blind_wins['new_skill']} wins",
        f"- Original skill: {blind_wins['old_skill']} wins",
        f"- Ties: {blind_wins['ties']}",
        f"- New-skill win rate among non-tied cases: {blind_wins['new_skill'] / comparable * 100:.2f}%",
        "",
        "## Notes",
        "",
        *[f"- {note}" for note in benchmark["notes"]],
        "",
    ]
    (args.iteration / "benchmark.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
