"""Generated a-stock-data compatibility surface."""
from importlib import import_module

__all__ = (
    "index_constituents", "index_weights", "index_valuation",
    "trading_calendar", "margin_trading_backup", "bse_quote_backup",
)

def __getattr__(name):
    if name not in __all__:
        raise AttributeError(name)
    return getattr(import_module(".astock_upstream", __name__), name)
