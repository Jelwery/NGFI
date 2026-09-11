import numpy as np
import pandas as pd


def _triangular_weights(grid: np.ndarray, low: float, high: float, avg: float) -> np.ndarray:
    """当日筹码在价格网格上的三角分布权重（峰值在均价，面积归一）"""
    w = np.zeros_like(grid)
    if not np.isfinite([low, high, avg]).all() or high < low:
        return w
    if high - low < 1e-9:                       # 一字板：全部堆在一个价位
        w[np.argmin(np.abs(grid - low))] = 1.0
        return w
    avg = min(max(avg, low), high)              # 均价必须落在当日区间内
    left = (grid >= low) & (grid <= avg)
    right = (grid > avg) & (grid <= high)
    if avg - low > 1e-9:
        w[left] = (grid[left] - low) / (avg - low)
    else:
        w[left] = 1.0
    if high - avg > 1e-9:
        w[right] = (high - grid[right]) / (high - avg)
    else:
        w[right] = 1.0
    total = w.sum()
    if total > 0:
        return w / total
    # 🔴 兜底：当日振幅窄于网格步长时，可能一个网格点都没落进 [low, high]，
    #    权重会全为 0。若就此跳过该日，连它的换手衰减也会一并丢失 ——
    #    低波动标的（银行股等）+ 长窗口下这会累积成很大的偏差。映射到最近网格点。
    w[np.argmin(np.abs(grid - avg))] = 1.0
    return w


def chip_distribution(df: pd.DataFrame, grid_size: int = 300, decay: float = 1.0) -> dict:
    """筹码分布 — df 需含 high/low/close/turn（turn 为百分数，0.31 表示 0.31%）

    decay: 换手衰减系数。1.0=按真实换手率换手；同花顺口径常用 1.5~2.0 加快历史筹码消散。
    """
    # 🔴 必须带 date 并按时间升序：换手衰减是有方向的时序递推，
    #    若传入常见的「最新在前」倒序，衰减会反向推、且 close.iloc[-1] 会把最老的
    #    收盘价当成现价 —— 结果完全错却不会报错。这里强制要求 date 并自行排序。
    need = {"date", "high", "low", "close", "turn"}
    missing = need - set(df.columns)
    if missing:
        raise ValueError(f"chip_distribution 缺少列: {sorted(missing)}（date 用于强制时间升序）")
    d = df.dropna(subset=["high", "low", "close", "turn"]).copy()
    d = d[d["high"] > 0]
    if d.empty:
        raise ValueError("chip_distribution: 有效行数为 0（检查是否全是停牌日，或字段类型不对）")
    d = d.sort_values("date").reset_index(drop=True)

    lo, hi = float(d["low"].min()), float(d["high"].max())
    pad = (hi - lo) * 0.02 or max(lo * 0.02, 0.01)
    grid = np.linspace(lo - pad, hi + pad, grid_size)

    # 🔴 初始筹码必须播种成「首日全部流通盘」，不能从全零开始。
    #    从零起步等于假设窗口之前没有任何持仓，再把窗口内的少量换手归一化成 100%：
    #    两个 1% 换手日（价 10 和 100）会被算成约 50/50，而真实情况是约 99% 仍在 10 附近。
    chips = None
    for row in d.itertuples(index=False):
        t = float(row.turn) / 100.0 * decay
        t = min(max(t, 0.0), 1.0)               # 换手率兜到 [0,1]，防异常值把筹码一次清零
        avg = (float(row.high) + float(row.low) + float(row.close)) / 3.0
        w = _triangular_weights(grid, float(row.low), float(row.high), avg)
        if w.sum() <= 0:
            continue
        if chips is None:
            chips = w.copy()                    # 首日分布 = 期初全部流通筹码
            continue
        chips = chips * (1.0 - t) + w * t
    if chips is None:
        raise RuntimeError("chip_distribution: 所有交易日的价格区间都无效，无法构建分布")

    total = chips.sum()
    if total <= 0:
        raise RuntimeError("chip_distribution: 筹码总量为 0，无法计算指标")
    chips = chips / total

    price = float(d["close"].iloc[-1])
    cum = np.cumsum(chips)

    def price_at(q: float) -> float:
        return float(np.interp(q, cum, grid))

    p05, p15, p85, p95 = (price_at(q) for q in (0.05, 0.15, 0.85, 0.95))
    peak_i = int(np.argmax(chips))
    return {
        "price": price,
        "profit_ratio": float(chips[grid <= price].sum()),      # 获利比例
        "avg_cost": float((grid * chips).sum()),                # 平均成本
        "cost_90": (p05, p95),
        "cost_70": (p15, p85),
        "concentration_90": float((p95 - p05) / (p95 + p05)) if p95 + p05 else None,
        "concentration_70": float((p85 - p15) / (p85 + p15)) if p85 + p15 else None,
        "peak_price": float(grid[peak_i]),                      # 筹码峰
        "histogram": [(float(pp), float(cc)) for pp, cc in zip(grid, chips) if cc > 1e-6],
    }


# 用法 — 输入用 §6.5 baostock（一次拿齐 OHLC + 换手率）
import baostock as bs

bs_code = _bs_code("600519")
with bs_session():
    rs = bs.query_history_k_data_plus(
        bs_code, "date,open,high,low,close,turn,tradestatus",
        start_date="2026-02-01", end_date="2026-08-18", frequency="d", adjustflag="2",
    )                                            # 2=前复权，筹码成本必须用复权价
    k = _rs_to_df(rs)
for c in ("open", "high", "low", "close", "turn"):
    k[c] = pd.to_numeric(k[c], errors="coerce")
k = k[k["tradestatus"] == "1"]                   # 停牌日不参与换手衰减

r = chip_distribution(k)
print(f"现价 {r['price']:.2f} | 获利比例 {r['profit_ratio']*100:.2f}% | 平均成本 {r['avg_cost']:.2f}")
print(f"90%成本区间 {r['cost_90'][0]:.2f}~{r['cost_90'][1]:.2f} 集中度 {r['concentration_90']*100:.2f}%")
print(f"筹码峰 {r['peak_price']:.2f}")
# 实测 2026-08-19（131 个交易日，窗口累计换手 46.5%）：
#   现价 1297.99 | 获利比例 15.44% | 平均成本 1371.31
#   90%成本区间 1207.89~1425.16 集中度 8.25% | 筹码峰 1398.99
#   ← 窗口累计换手不足 100%，多数筹码仍是期初高位持仓，故均成本高于现价、获利盘偏低
