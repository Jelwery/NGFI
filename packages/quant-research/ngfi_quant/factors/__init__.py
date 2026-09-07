"""Public factor-research API."""

from .analytics import (
    compute_forward_returns, correlation_matrix, factor_coverage, factor_turnover, grouped_returns,
    information_coefficient,
)
from .combination import FactorWeights, combine_test_factors, fit_factor_weights
from .contracts import (
    FactorLineage, FactorMetric, FactorMetricResult, FactorSplit, FactorTable, FactorValue, ForwardReturn, PriceValue,
    make_lineage, split_factor_table,
)
from .preprocessing import FactorTransformResult, TransformDiagnostic, handle_missing, neutralize, standardize, winsorize

__all__ = [name for name in globals() if not name.startswith("_")]
