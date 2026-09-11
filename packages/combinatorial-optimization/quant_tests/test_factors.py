from __future__ import annotations

from dataclasses import replace
import math
import unittest

from ngfi_quant import (
    FactorSplit, FactorTable, FactorValue, ForwardReturn, Instrument, PriceValue,
    combine_test_factors, compute_forward_returns, correlation_matrix, factor_coverage, factor_turnover,
    fit_factor_weights, grouped_returns, handle_missing, information_coefficient, make_lineage,
    neutralize, stable_hash, standardize, winsorize,
)


INSTRUMENTS = tuple(Instrument("CN", "SSE", f"60000{index}") for index in range(4))
SOURCE = stable_hash({"source": "fixture"})
SPLIT = FactorSplit("2026-01-01", "2026-01-03", "2026-01-04", "2026-01-04", "2026-02-01T00:00:00+00:00")


def table(*, missing: bool = False) -> FactorTable:
    rows = []
    for day_index, day in enumerate(("2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04")):
        for index, instrument in enumerate(INSTRUMENTS):
            first = None if missing and day_index == 0 and index == 0 else float(index + 1 + day_index)
            rows.extend((
                FactorValue(day, instrument, "value", first, f"{day}T08:00:00+00:00", SOURCE,
                            "bank" if index < 2 else "tech", 100.0 * (index + 1)),
                FactorValue(day, instrument, "quality", float((index + 1) * (1 if day_index % 2 == 0 else -1)),
                            f"{day}T08:00:00+00:00", SOURCE,
                            "bank" if index < 2 else "tech", 100.0 * (index + 1)),
            ))
    return FactorTable(tuple(rows))


def lineage(data: FactorTable, algorithm: str = "fixture"):
    return make_lineage(
        algorithm=algorithm, version="1.0.0", table=data, config={"fixture": True}, split=SPLIT,
        created_at="2026-02-02T00:00:00+00:00",
    )


def forward(data: FactorTable, horizon: int = 1) -> tuple[ForwardReturn, ...]:
    values = {instrument.key: (-0.03, -0.01, 0.01, 0.03)[index] for index, instrument in enumerate(INSTRUMENTS)}
    rows = []
    for row in data.rows:
        if row.factor != "value" or row.date == "2026-01-04":
            continue
        outcome = f"2026-01-0{int(row.date[-1]) + 1}"
        rows.append(ForwardReturn(row.date, outcome, row.instrument, horizon, values[row.instrument.key],
                                  f"{outcome}T08:00:00+00:00", SOURCE))
    return tuple(rows)


class FactorResearchTest(unittest.TestCase):
    def test_long_table_rejects_duplicate_keys_and_nonfinite_values(self) -> None:
        data = table()
        with self.assertRaisesRegex(ValueError, "duplicate factor key"):
            FactorTable(data.rows + (data.rows[0],))
        with self.assertRaisesRegex(ValueError, "finite or null"):
            replace(data.rows[0], value=math.nan)
        empty = FactorTable(())
        empty_trace = make_lineage(
            algorithm="empty", version="1.0.0", table=empty, config={}, split=SPLIT,
            created_at="2026-02-02T00:00:00+00:00", additional_hashes=(SOURCE,),
        )
        self.assertEqual(factor_coverage(empty, lineage=empty_trace, role="train")["periods"], [])

    def test_winsorize_standardize_and_missing_strategies_are_hand_computable(self) -> None:
        rows = tuple(
            FactorValue("2026-01-01", INSTRUMENTS[index], "x", value, "2026-01-01T08:00:00+00:00", SOURCE)
            for index, value in enumerate((1.0, 2.0, None, 100.0))
        )
        data = FactorTable(rows)
        trace = lineage(data)
        clipped = winsorize(data, lineage=trace, lower=0.25, upper=0.75)
        self.assertEqual([row.value for row in clipped.table.rows], [1.5, 2.0, None, 51.0])
        filled = handle_missing(data, lineage=trace, method="median")
        self.assertEqual([row.value for row in filled.table.rows], [1.0, 2.0, 2.0, 100.0])
        standardized = standardize(FactorTable(rows[:2]), lineage=trace)
        self.assertEqual([row.value for row in standardized.table.rows], [-1.0, 1.0])
        self.assertIs(standardized.lineage, trace)

        empty = FactorTable(tuple(replace(row, value=None) for row in rows))
        result = standardize(empty, lineage=lineage(empty))
        self.assertTrue(all(row.value is None for row in result.table.rows))
        self.assertEqual(result.diagnostics[0].status, "insufficient")

    def test_industry_and_size_neutralization_removes_linear_exposures(self) -> None:
        rows = []
        for index, instrument in enumerate(INSTRUMENTS):
            industry = "bank" if index < 2 else "tech"
            market_cap = float(index + 1)
            industry_effect = 2.0 if industry == "tech" else 0.0
            residual = (-0.2, 0.2, -0.2, 0.2)[index]
            rows.append(FactorValue("2026-01-01", instrument, "x", 1 + industry_effect + math.log(market_cap) + residual,
                                    "2026-01-01T08:00:00+00:00", SOURCE, industry, market_cap))
        data = FactorTable(tuple(rows))
        result = neutralize(data, lineage=lineage(data), industry=True, market_cap=True)
        residuals = [row.value for row in result.table.rows]
        self.assertAlmostEqual(sum(value for value in residuals if value is not None), 0.0, places=10)
        self.assertEqual(result.diagnostics[0].sample_count if hasattr(result.diagnostics[0], "sample_count") else result.diagnostics[0].output_count, 4)

    def test_forward_return_uses_future_price_shift_without_future_factor_access(self) -> None:
        data = table()
        trace = lineage(data)
        prices = tuple(
            PriceValue(day, instrument, 10 + day_index + index, f"{day}T08:00:00+00:00", SOURCE)
            for index, instrument in enumerate(INSTRUMENTS)
            for day_index, day in enumerate(("2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"))
        )
        result = compute_forward_returns(prices, horizon=1, lineage=trace)
        self.assertEqual(result, compute_forward_returns(prices, horizon=1, lineage=trace))
        first = result["rows"][0]
        self.assertEqual((first.factor_date, first.outcome_date), ("2026-01-01", "2026-01-02"))
        self.assertAlmostEqual(first.value, 0.1)
        self.assertEqual(result["sampleCount"], 12)
        future = replace(prices[0], available_at="2027-01-01T00:00:00+00:00")
        with self.assertRaisesRegex(ValueError, "future-available"):
            compute_forward_returns((future,) + prices[1:], horizon=1, lineage=trace)

    def test_ic_rank_ic_icir_group_returns_turnover_and_coverage(self) -> None:
        data = table(missing=True)
        trace = lineage(data)
        train = FactorTable(tuple(row for row in data.rows if row.date <= SPLIT.train_end and row.factor == "value"))
        outcomes = tuple(row for row in forward(data) if row.outcome_date <= SPLIT.train_end)
        ic = information_coefficient(train, outcomes, horizon=1, method="pearson", lineage=trace, role="train")
        rank_ic = information_coefficient(train, outcomes, horizon=1, method="spearman", lineage=trace, role="train")
        self.assertAlmostEqual(ic["mean"].value, 1.0)
        self.assertAlmostEqual(rank_ic["mean"].value, 1.0)
        self.assertEqual(ic["daily"][0]["metric"].sample_count, 3)
        self.assertAlmostEqual(ic["daily"][0]["metric"].coverage, 0.75)
        self.assertEqual(ic["icir"].value, None)

        grouped = grouped_returns(train, outcomes, horizon=1, groups=2, lineage=trace, role="train")
        self.assertAlmostEqual(grouped["periods"][1]["longShort"], 0.04)
        turnover = factor_turnover(train, quantile_fraction=0.5, lineage=trace, role="train")
        self.assertEqual(turnover["periods"][0]["value"], None)
        self.assertAlmostEqual(turnover["periods"][1]["value"], 0.0)
        coverage = factor_coverage(train, lineage=trace, role="train")
        self.assertAlmostEqual(coverage["periods"][0]["coverage"], 0.75)

    def test_pearson_and_spearman_correlation_matrices_handle_constant_factors(self) -> None:
        data = table()
        trace = lineage(data)
        train = FactorTable(tuple(row for row in data.rows if row.date <= SPLIT.train_end))
        pearson = correlation_matrix(train, method="pearson", lineage=trace, role="train")
        spearman = correlation_matrix(train, method="spearman", lineage=trace, role="train")
        diagonal = next(cell for cell in pearson["cells"] if cell["left"] == cell["right"] == "value")
        self.assertAlmostEqual(diagonal["metric"].value, 1.0)
        self.assertEqual(pearson["factors"], spearman["factors"])
        constant = FactorTable(tuple(replace(row, value=1.0) for row in train.rows))
        cell = correlation_matrix(constant, method="pearson", lineage=lineage(data), role="train")["cells"][0]
        self.assertEqual(cell["metric"].status, "not-meaningful")
        self.assertIsNone(cell["metric"].value)

    def test_equal_ic_and_minimum_correlation_weights_are_fit_only_on_train(self) -> None:
        data = table()
        trace = lineage(data)
        outcomes = tuple(row for row in forward(data) if row.outcome_date <= SPLIT.train_end)
        for method in ("equal", "ic", "minimum-correlation"):
            weights = fit_factor_weights(data, outcomes, split=SPLIT, horizon=1, method=method, lineage=trace)
            self.assertAlmostEqual(sum(value for _, value in weights.weights), 1.0)
            self.assertEqual(weights.fitted_through, SPLIT.train_end)
            self.assertIs(weights.lineage, trace)
            combined = combine_test_factors(data, split=SPLIT, weights=weights, lineage=trace)
            self.assertTrue(all(row["date"] >= SPLIT.test_start for row in combined["rows"]))
            self.assertTrue(all("sampleCount" in row and "coverage" in row for row in combined["rows"]))

        reversed_test = FactorTable(tuple(
            replace(row, value=-row.value) if row.date >= SPLIT.test_start and row.value is not None else row
            for row in data.rows
        ))
        original = fit_factor_weights(data, outcomes, split=SPLIT, horizon=1, method="equal", lineage=trace)
        changed = fit_factor_weights(reversed_test, outcomes, split=SPLIT, horizon=1, method="equal", lineage=trace)
        self.assertEqual(original.weights, changed.weights)

    def test_zero_weight_and_train_test_boundary_violations_fail_closed(self) -> None:
        data = table()
        trace = lineage(data)
        value_by_key = {
            (row.date, row.instrument.key): row.value
            for row in data.rows if row.factor == "value"
        }
        zero_data = FactorTable(tuple(
            replace(row, value=-value_by_key[(row.date, row.instrument.key)])
            if row.factor == "quality" else row
            for row in data.rows
        ))
        outcomes = tuple(row for row in forward(data) if row.outcome_date <= SPLIT.train_end)
        with self.assertRaisesRegex(ValueError, "weight sum is zero"):
            fit_factor_weights(zero_data, outcomes, split=SPLIT, horizon=1, method="ic", lineage=trace)
        with self.assertRaisesRegex(ValueError, "crosses train/test boundary"):
            fit_factor_weights(data, forward(data), split=SPLIT, horizon=1, method="equal", lineage=trace)
        train = FactorTable(tuple(row for row in data.rows if row.date <= SPLIT.train_end and row.factor == "value"))
        with self.assertRaisesRegex(ValueError, "forward outcome crosses the declared train boundary"):
            information_coefficient(train, forward(data), horizon=1, method="pearson", lineage=trace, role="train")
        mixed = FactorTable((data.rows[0], next(row for row in data.rows if row.date == SPLIT.test_start)))
        with self.assertRaisesRegex(ValueError, "train boundary"):
            factor_coverage(mixed, lineage=trace, role="train")


if __name__ == "__main__":
    unittest.main()
