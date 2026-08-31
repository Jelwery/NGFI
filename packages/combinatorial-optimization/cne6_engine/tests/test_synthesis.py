# cne6_engine/tests/test_synthesis.py
"""Two-stage factor synthesis tests."""
import numpy as np
import polars as pl
import pytest

from cne6_engine.algorithm.synthesis import (
    _orthogonalize,
    fill_industry_median,
    mad_winsorize,
    synthesize_styles,
    weighted_zscore,
)


class TestPrimitives:
    def test_mad_winsorize_clips_outliers(self):
        x = np.array([1.0, 1.1, 0.9, 1.05, 100.0])
        out = mad_winsorize(x)
        assert out[-1] < 100.0
        assert np.allclose(out[:4], x[:4])

    def test_mad_winsorize_keeps_clean_data(self):
        x = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0])
        assert np.allclose(mad_winsorize(x), x)

    def test_mad_winsorize_nan_aware(self):
        x = np.array([1.0, np.nan, 1.1, 0.9, 1.05, 100.0])
        out = mad_winsorize(x)
        assert np.isnan(out[1])
        assert out[-1] < 100.0

    def test_fill_industry_median(self):
        x = np.array([1.0, np.nan, 2.0, np.nan, 3.0, 4.0])
        industry = np.array([0, 0, 0, 1, 1, 1])
        filled, rate = fill_industry_median(x, industry, 2)
        assert filled[1] == 1.5  # median of industry 0 valid values
        assert filled[3] == 3.5
        assert rate == pytest.approx(2 / 6)

    def test_fill_falls_back_to_market_median(self):
        # Industry 1 has no valid values at all.
        x = np.array([1.0, np.nan, 3.0, np.nan, np.nan, np.nan])
        industry = np.array([0, 0, 0, 1, 1, 1])
        filled, _ = fill_industry_median(x, industry, 2)
        assert filled[3] == np.median([1.0, 3.0])

    def test_weighted_zscore(self):
        x = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        w = np.ones(5)
        z, mean, std = weighted_zscore(x, w)
        assert mean == pytest.approx(3.0)
        assert std == pytest.approx(np.sqrt(2.0))
        assert z[0] == pytest.approx(-2.0 / np.sqrt(2.0))

    def test_weighted_zscore_weights_matter(self):
        x = np.array([0.0, 1.0, 2.0])
        w = np.array([10.0, 1.0, 1.0])
        z, mean, _ = weighted_zscore(x, w)
        assert mean < 1.0  # heavy weight pulls mean toward 0

    def test_fill_weighted_median_uses_weights(self):
        x = np.array([1.0, np.nan, 2.0])
        industry = np.array([0, 0, 0])
        # 1.0 carries 100x the weight of 2.0 → weighted median = 1.0
        filled, _ = fill_industry_median(
            x, industry, 1, np.array([100.0, 1.0, 1.0]),
        )
        assert filled[1] == 1.0

    def test_orthogonalize_removes_control(self):
        rng = np.random.default_rng(7)
        control = rng.normal(size=500)
        noise = rng.normal(size=500)
        x = 3.0 * control + 0.5 + noise
        resid = _orthogonalize(x, control[:, np.newaxis])
        assert abs(np.corrcoef(resid, control)[0, 1]) < 0.1
        assert abs(resid.mean()) < 0.05
        # The residual is the noise we injected.
        assert np.corrcoef(resid, noise)[0, 1] > 0.99


def _descriptor_frame(n_per_ind=20, seed=3):
    """Two industries; descriptors with known structure."""
    rng = np.random.default_rng(seed)
    codes, industries = [], []
    for g, prefix in enumerate(["sz.00", "sh.60"]):
        for i in range(n_per_ind):
            codes.append(f"{prefix}{i:04d}")
            industries.append(["银行", "白酒"][g])
    n = len(codes)

    lncap = np.concatenate([
        rng.uniform(1e9, 1e10, n_per_ind),
        rng.uniform(1e10, 5e10, n_per_ind),
    ])
    # Volatility descriptor: industry-shifted + noise.
    vol = 0.02 + 0.05 * (np.array(industries) == "白酒") + rng.normal(0, 0.01, n)
    # Liquidity descriptor: cap-correlated + noise.
    liq = np.log(lncap) * 0.1 + rng.normal(0, 0.05, n)
    # Momentum descriptor: pure noise.
    mom = rng.normal(0, 1, n)

    frame = pl.DataFrame({
        "code": codes,
        "LNCAP": np.log(lncap),
        "HSIGMA": vol,
        "STOM": liq,
        "RSTR": mom,
    })
    caps = lncap
    industry_map = dict(zip(codes, industries))
    return frame, industry_map, caps


class TestSynthesizeStyles:
    def test_output_shape_and_names(self):
        frame, industry_map, caps = _descriptor_frame()
        S, names, meta = synthesize_styles(frame, industry_map, caps)
        assert S.shape[0] == frame.height
        assert len(names) == S.shape[1]
        # Size (LNCAP), Volatility (HSIGMA), Liquidity (STOM), Momentum (RSTR)
        assert set(names) == {"Size", "Volatility", "Liquidity", "Momentum"}
        assert all(np.isfinite(S).all(axis=1))

    def test_two_stage_weighting(self):
        # Stage 1: Volatility = mean of its descriptors; stage 2 aggregates
        # level-2 groups.  With one descriptor per level-2 here, Volatility
        # style == orthogonalized HSIGMA.
        frame, industry_map, caps = _descriptor_frame()
        S, names, meta = synthesize_styles(frame, industry_map, caps)
        vol_col = S[:, names.index("Volatility")]
        assert np.isfinite(vol_col).all()

    def test_missing_descriptor_drops_from_group(self):
        frame, industry_map, caps = _descriptor_frame()
        # Blank one descriptor entirely → its group disappears.
        blanked = frame.with_columns(
            pl.lit(None, dtype=pl.Float64).alias("RSTR")
        )
        S, names, meta = synthesize_styles(blanked, industry_map, caps)
        assert "Momentum" not in names

    def test_partial_nan_filled(self):
        frame, industry_map, caps = _descriptor_frame()
        rng = np.random.default_rng(11)
        values = frame["RSTR"].to_numpy().copy()
        holes = rng.choice(len(values), size=5, replace=False)
        values[holes] = np.nan
        holed = frame.with_columns(pl.Series("RSTR", values))
        S, names, meta = synthesize_styles(holed, industry_map, caps)
        mom_col = S[:, names.index("Momentum")]
        assert np.isfinite(mom_col).all()
        assert meta["fill_rates"]["RSTR"] == pytest.approx(5 / len(values))

    def test_orthogonalized_styles_uncorrelated_with_lncap(self):
        frame, industry_map, caps = _descriptor_frame()
        S, names, meta = synthesize_styles(frame, industry_map, caps)
        lncap = frame["LNCAP"].to_numpy()
        for name in ["Volatility", "Liquidity", "Momentum"]:
            col = S[:, names.index(name)]
            corr = abs(np.corrcoef(col, lncap)[0, 1])
            assert corr < 0.2, f"{name} corr with LNCAP: {corr}"

    def test_size_style_correlates_with_lncap(self):
        frame, industry_map, caps = _descriptor_frame()
        S, names, meta = synthesize_styles(frame, industry_map, caps)
        lncap = frame["LNCAP"].to_numpy()
        size_col = S[:, names.index("Size")]
        corr = np.corrcoef(size_col, lncap)[0, 1]
        assert corr > 0.99

    def test_volatility_style_industry_neutral(self):
        frame, industry_map, caps = _descriptor_frame()
        S, names, meta = synthesize_styles(frame, industry_map, caps)
        vol_col = S[:, names.index("Volatility")]
        industries = np.array(
            [industry_map[c] for c in frame["code"].to_list()]
        )
        bank_mean = vol_col[industries == "银行"].mean()
        liquor_mean = vol_col[industries == "白酒"].mean()
        assert abs(bank_mean - liquor_mean) < 0.1

    def test_meta_reports_structure(self):
        frame, industry_map, caps = _descriptor_frame()
        S, names, meta = synthesize_styles(frame, industry_map, caps)
        assert meta["level2_active"]
        assert {entry["name"] for entry in meta["level1_active"]} == set(names)
        assert len(meta["industries"]) == 2
