import copy

import numpy as np
import pytest

from cne6_engine.interfaces.portfolio_risk import (
    Cne6PortfolioSnapshotError,
    build_portfolio_risk_snapshot,
)


def pipeline_result() -> dict:
    exposures = np.array([[1.0, 1.0, 1.0], [1.0, 0.0, -1.0]])
    factor_cov = np.diag([0.0004, 0.0001, 0.000225])
    specific_risk = np.array([0.01, 0.02])
    stock_cov = exposures @ factor_cov @ exposures.T
    stock_cov[np.diag_indices(2)] += specific_risk ** 2
    return {
        "exposures": exposures,
        "factor_cov": factor_cov,
        "specific_risk": specific_risk,
        "sigma_stock": stock_cov,
        "codes": ["sh.600000", "sz.000001"],
        "factor_names": ["COUNTRY", "银行", "Size"],
        "meta": {
            "end_date": "2026-09-05",
            "n_days": 252,
            "lookback_days": 252,
            "factor_cov_kwargs": {"oba_method": "monte_carlo"},
            "specific_risk_kwargs": {"vol_half_life": 21},
            "provenance": {"snapshot": "fixture"},
        },
    }


def test_build_portfolio_risk_snapshot_projects_pipeline_without_mutation() -> None:
    source = pipeline_result()
    original_exposures = source["exposures"].copy()

    snapshot = build_portfolio_risk_snapshot(source)

    assert snapshot["schemaVersion"] == "1"
    assert snapshot["model"] == "CNE6"
    assert snapshot["modelVersion"] == "cne6-engine@0.1.0"
    assert snapshot["asOf"] == "2026-09-05"
    assert snapshot["currency"] == "CNY"
    assert snapshot["factors"] == [
        {"name": "COUNTRY", "kind": "country"},
        {"name": "银行", "kind": "industry"},
        {"name": "Size", "kind": "style"},
    ]
    assert snapshot["securities"][0] == {
        "instrument": {
            "market": "CN", "exchange": "SSE", "symbol": "600000",
            "assetType": "equity",
        },
        "modelCode": "sh.600000",
        "exposures": [1.0, 1.0, 1.0],
        "specificRisk": 0.01,
    }
    assert snapshot["coverage"] == {
        "universeCount": 2, "exposureCount": 2, "specificRiskCount": 2,
        "numerator": 2, "denominator": 2, "coverage": 1.0, "exclusions": {},
    }
    assert snapshot["sourceQuality"]["quality_flag"] == "unverified"
    assert snapshot["quality"]["status"] == "ok"
    assert snapshot["quality"]["stockReconciliationMaxError"] == pytest.approx(0.0)
    assert snapshot["inputHash"].startswith("sha256:")
    assert len(snapshot["inputHash"]) == 71
    assert np.array_equal(source["exposures"], original_exposures)


def test_build_portfolio_risk_snapshot_hash_is_stable_and_semantic() -> None:
    first = pipeline_result()
    reordered = {key: first[key] for key in reversed(first)}
    same = build_portfolio_risk_snapshot(reordered)
    changed = pipeline_result()
    changed["exposures"][0, 2] = 1.1
    changed["sigma_stock"] = (
        changed["exposures"]
        @ changed["factor_cov"]
        @ changed["exposures"].T
    )
    changed["sigma_stock"][np.diag_indices(2)] += changed["specific_risk"] ** 2

    assert build_portfolio_risk_snapshot(first)["inputHash"] == same["inputHash"]
    assert build_portfolio_risk_snapshot(changed)["inputHash"] != same["inputHash"]


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("codes", ["sh.600000", "sh.600000"], "codes must be unique"),
        ("exposures", np.ones((2, 2)), "exposures shape"),
        ("specific_risk", np.array([0.01, np.nan]), "non-finite"),
        ("factor_cov", np.array([[0.1, 0, 0], [0, np.inf, 0], [0, 0, 0.1]]), "non-finite"),
    ],
)
def test_build_portfolio_risk_snapshot_rejects_invalid_pipeline_contract(
    field: str, value: object, message: str,
) -> None:
    source = pipeline_result()
    source[field] = value
    with pytest.raises(Cne6PortfolioSnapshotError, match=message):
        build_portfolio_risk_snapshot(source)


def test_build_portfolio_risk_snapshot_reports_covariance_quality_failures() -> None:
    source = pipeline_result()
    source["factor_cov"] = np.diag([0.0004, -0.0001, 0.000225])
    snapshot = build_portfolio_risk_snapshot(source)

    assert snapshot["quality"]["status"] == "invalid"
    assert snapshot["quality"]["positiveSemidefinite"] is False
    assert snapshot["quality"]["stockReconciliationMaxError"] > 0
    assert any(
        "not positive semidefinite" in issue
        for issue in snapshot["quality"]["issues"]
    )
    assert any(
        "does not equal" in issue
        for issue in snapshot["quality"]["issues"]
    )


def test_build_portfolio_risk_snapshot_rejects_unmappable_code_and_bad_specific_risk() -> None:
    unsupported = pipeline_result()
    unsupported["codes"] = ["us.AAPL", "sz.000001"]
    with pytest.raises(Cne6PortfolioSnapshotError, match="unsupported CNE6 security code"):
        build_portfolio_risk_snapshot(unsupported)

    non_positive = pipeline_result()
    non_positive["specific_risk"][0] = 0
    with pytest.raises(Cne6PortfolioSnapshotError, match="strictly positive"):
        build_portfolio_risk_snapshot(non_positive)


def test_build_portfolio_risk_snapshot_does_not_expose_pipeline_callables() -> None:
    source = pipeline_result()
    source["adapter"] = lambda: None
    source["meta"]["writer"] = lambda: None
    snapshot = build_portfolio_risk_snapshot(source)

    assert "adapter" not in snapshot
    assert "pipeline" not in snapshot
    assert snapshot == copy.deepcopy(snapshot)
