from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


class SkillContractTests(unittest.TestCase):
    def test_keeps_three_primary_skills(self):
        skills = sorted(ROOT.glob("*/SKILL.md"))
        self.assertEqual(
            [path.parent.name for path in skills],
            ["公司财务分析", "宏观周期与政策分析", "投资行为诊断"],
        )

    def test_all_skills_put_v2_control_layer_first(self):
        for path in ROOT.glob("*/SKILL.md"):
            text = path.read_text(encoding="utf-8")
            control = text.index("## V2 执行控制层")
            first_legacy_section = min(
                index
                for heading in ("## 角色", "## 写作规范", "## 触发原则")
                if (index := text.find(heading)) >= 0
            )
            self.assertLess(control, first_legacy_section, path)

    def test_frontmatter_names_are_dsh_compatible(self):
        expected = {
            "投资行为诊断": "investment-behavior-diagnosis",
            "宏观周期与政策分析": "macro-cycle-policy-analysis",
            "公司财务分析": "company-financial-analysis",
        }
        for directory, name in expected.items():
            text = (ROOT / directory / "SKILL.md").read_text(encoding="utf-8")
            self.assertRegex(text, rf"(?m)^name: {re.escape(name)}$")

    def test_referenced_resources_exist(self):
        pattern = re.compile(r"(?:references|scripts)/[A-Za-z0-9_.\-\u4e00-\u9fff]+")
        for skill_path in ROOT.glob("*/SKILL.md"):
            text = skill_path.read_text(encoding="utf-8")
            for relative in sorted(set(pattern.findall(text))):
                self.assertTrue((skill_path.parent / relative).is_file(), relative)

    def test_behavior_guardrails(self):
        text = (ROOT / "投资行为诊断/SKILL.md").read_text(encoding="utf-8")
        for phrase in ("needs_input", "data_conflict", "not_a_bias", "理性行为是零假设"):
            self.assertIn(phrase, text)
        self.assertNotIn('卖出一部分，保留一部分', text)

    def test_macro_guardrails(self):
        text = (ROOT / "宏观周期与政策分析/SKILL.md").read_text(encoding="utf-8")
        for phrase in ("冻结快照", "needs_input", "tool_error", "有界双 Agent"):
            self.assertIn(phrase, text)
        self.assertIn("禁止基于伪前提推导行业", text)

    def test_finance_guardrails(self):
        text = (ROOT / "公司财务分析/SKILL.md").read_text(encoding="utf-8")
        for phrase in (
            "当前股价防火墙",
            "run_canonical.py",
            "validate_state.py",
            "通用 Z/M 模型不适用",
            "ROA 的定义固定为 `EBIT / 总资产`",
        ):
            self.assertIn(phrase, text)


class StateValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validator = load_module(
            "validate_state",
            ROOT / "公司财务分析/scripts/validate_state.py",
        )

    def valid_state(self):
        return {
            "metadata": {
                "code": "sh.600000",
                "name": "示例公司",
                "last_period": "20241231",
            },
            "stage1": {},
            "stage2_4_summary": {},
            "risk_models": {},
            "last_valuation": {
                "method": "DCF",
                "scenario": {"neutral": {"wacc": 0.09}},
                "results": {
                    "pessimistic": 8.0,
                    "neutral": 10.0,
                    "optimistic": 12.0,
                    "recommended": 10.0,
                },
            },
            "data_snapshots": {"2024": {"revenue": 100}},
        }

    def test_accepts_valid_state(self):
        self.assertEqual(self.validator.validate(self.valid_state()), [])

    def test_rejects_meta_alias(self):
        state = self.valid_state()
        state["meta"] = state.pop("metadata")
        errors = self.validator.validate(state)
        self.assertTrue(any("metadata" in error for error in errors))
        self.assertTrue(any("banned key" in error for error in errors))

    def test_rejects_price_anchoring_keys(self):
        state = self.valid_state()
        state["last_valuation"]["current_price"] = 10
        self.assertTrue(
            any("current_price" in error for error in self.validator.validate(state))
        )

    def test_accepts_explicit_unavailable_valuation(self):
        state = self.valid_state()
        state["last_valuation"] = {
            "status": "unavailable",
            "reason": "缺少可审计的权益成本参数",
        }
        self.assertEqual(self.validator.validate(state), [])

    def test_finance_output_validator_blocks_price_anchoring(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "report.md"
            state = root / "state.json"
            report.write_text("# 报告\n当前股价：10元\n建议买入\n", encoding="utf-8")
            state.write_text(json.dumps(self.valid_state(), ensure_ascii=False), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "公司财务分析/scripts/validate_finance_output.py"),
                    "--report",
                    str(report),
                    "--state",
                    str(state),
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("banned current price", completed.stderr)
            self.assertIn("banned trade recommendation", completed.stderr)


class RatioDefinitionTests(unittest.TestCase):
    def test_canonical_roa_is_ebit_over_assets(self):
        ratios = load_module(
            "calc_ratios",
            ROOT / "公司财务分析/scripts/calc_ratios.py",
        )
        data = {
            "company_type": "GENERAL",
            "annual_data": {
                "2024": {
                    "利润表": {
                        "营业收入": 1000.0,
                        "营业成本": 600.0,
                        "营业利润": 60.0,
                        "财务费用": 20.0,
                        "归属于母公司所有者的净利润": 96.8,
                    },
                    "资产负债表": {
                        "资产总计": 2000.0,
                        "负债合计": 600.0,
                        "归属于母公司股东权益合计": 1000.0,
                    },
                    "现金流量表": {},
                }
            },
        }
        result = ratios.calc_all(data)
        self.assertAlmostEqual(result["roa_vs_r"]["2024"]["roa"], 0.04)
        self.assertNotAlmostEqual(result["roa_vs_r"]["2024"]["roa"], 0.0484)

    def test_canonical_runner_records_provenance(self):
        data = {
            "company_type": "GENERAL",
            "annual_data": {
                "2024": {
                    "利润表": {
                        "营业收入": 1000.0,
                        "营业成本": 600.0,
                        "营业利润": 60.0,
                        "财务费用": 20.0,
                        "归属于母公司所有者的净利润": 80.0,
                    },
                    "资产负债表": {
                        "资产总计": 2000.0,
                        "负债合计": 600.0,
                        "归属于母公司股东权益合计": 1000.0,
                    },
                    "现金流量表": {},
                }
            },
        }
        with tempfile.TemporaryDirectory() as temp:
            workdir = Path(temp)
            input_path = workdir / "_data.json"
            output_path = workdir / "_ratios.json"
            input_path.write_text(json.dumps(data), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "公司财务分析/scripts/run_canonical.py"),
                    "--script",
                    "calc_ratios.py",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                ],
                cwd=workdir,
                text=True,
                capture_output=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(output_path.is_file())
            records = json.loads((workdir / "_provenance.json").read_text(encoding="utf-8"))
            self.assertEqual(records[0]["exit_code"], 0)
            self.assertEqual(records[0]["script"], str(ROOT / "公司财务分析/scripts/calc_ratios.py"))
            self.assertIsNotNone(records[0]["input_sha256"])
            self.assertIsNotNone(records[0]["output_sha256"])


if __name__ == "__main__":
    unittest.main()
