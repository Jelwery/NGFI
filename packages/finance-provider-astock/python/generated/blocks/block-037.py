def baostock_stock_basic(code: str) -> dict:
    """标的基本信息 — ipoDate(上市日) / outDate(退市日，在市为空) / status(1=上市 0=退市)"""
    bs_code = _bs_code(code)
    with bs_session():
        df = _rs_to_df(bs.query_stock_basic(code=bs_code))
    return df.iloc[0].to_dict() if not df.empty else {}


# 用法
print(baostock_stock_basic("600519"))
# 实测：{'code': 'sh.600519', 'code_name': '贵州茅台', 'ipoDate': '2001-08-27',
#        'outDate': '', 'type': '1', 'status': '1'}   ← outDate 为空 = 仍在市
