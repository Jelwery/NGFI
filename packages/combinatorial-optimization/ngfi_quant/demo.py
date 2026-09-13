from datetime import date, timedelta

import numpy as np

from .execution import money
from .factors.graph import factor_catalog


def demo_input() -> tuple[dict, dict]:
    dates = []
    day = date(2024, 1, 2)
    while len(dates) < 100:
        if day.weekday() < 5:
            dates.append(day.isoformat())
        day += timedelta(days=1)
    rng = np.random.default_rng(17)
    prices = np.linspace(10, 30, 8)
    bars = []
    for day in dates:
        for stock in range(8):
            previous = money(float(prices[stock]))
            opened = money(previous * (1 + rng.normal(0, 0.003)))
            close = money(opened * (1 + rng.normal(0.0002 + stock * 0.0001, 0.007)))
            prices[stock] = close
            bars.append({"date": day, "instrument": {"market": "CN", "exchange": "SSE", "symbol": str(600000 + stock)},
                         "availableAt": f"{day}T15:05:00+08:00", "statusAvailableAt": f"{day}T09:00:00+08:00",
                         "open": opened, "high": money(max(opened, close) * 1.01), "low": money(min(opened, close) * 0.99),
                         "close": close, "previousClose": previous, "volume": 1_000_000.0, "amount": close * 1_000_000,
                         "eligible": True, "industry": f"sector-{stock % 2}", "suspended": False, "limitRate": 0.1, "lotSize": 100})
    dataset = {"snapshotId": "synthetic-demo-v2", "asOf": f"{dates[-1]}T17:00:00+08:00", "synthetic": True,
               "provenance": "Synthetic prices and weekdays; not market data or an exchange calendar.",
               "priceBasis": "raw-no-corporate-actions", "universePolicy": "explicit-research-universe",
               "calendar": [{"date": day, "openAt": f"{day}T09:30:00+08:00", "closeAt": f"{day}T15:00:00+08:00",
                             "decisionAt": f"{day}T16:00:00+08:00"} for day in dates], "bars": bars}
    spec = {"startDate": dates[55], "endDate": dates[93], "factors": factor_catalog()["factors"][:3],
            "model": {"trainSessions": 30, "refitEvery": 10, "horizon": 5, "minimumSamples": 30},
            "risk": {"source": "ledoit-wolf"},
            "optimizer": {"maxWeight": 0.2, "riskLookback": 20, "industryCaps": {"sector-0": 0.6, "sector-1": 0.6}},
            "execution": {"rebalanceEvery": 5}}
    return dataset, spec
