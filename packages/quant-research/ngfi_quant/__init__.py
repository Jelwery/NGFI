"""Public API for NGFI quant research."""

from .contracts import (
    AShareBar, AShareCostModel, BacktestMetadata, BacktestRequest, BacktestResult, CandidateSignal,
    EquityPoint, Instrument, PortfolioConfig, Rejection, Trade,
)
from .execution import affordable_board_lot, execution_block, execution_price, is_price_limited, next_trading_day, transaction_cost
from .hashing import canonical_json, stable_hash
from .portfolio import compare_candidate_to_benchmark, run_research_backtest
from .promotion import PromotionThresholds, decide_promotion
from .validation import (
    CandidateReturn, DateFold, NestedFold, cscv_pbo, deflated_sharpe, minimum_track_record,
    nested_walk_forward, run_cost_stress, run_is_oos,
)
from .factors import (
    FactorLineage, FactorMetric, FactorMetricResult, FactorSplit, FactorTable, FactorTransformResult,
    FactorValue, FactorWeights, ForwardReturn, PriceValue, TransformDiagnostic, combine_test_factors,
    compute_forward_returns, correlation_matrix, factor_coverage, factor_turnover, fit_factor_weights, grouped_returns,
    handle_missing, information_coefficient, make_lineage, neutralize, split_factor_table, standardize, winsorize,
)

__all__ = [name for name in globals() if not name.startswith("_")]
