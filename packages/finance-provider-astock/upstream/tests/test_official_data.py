"""Test the Python shipped inside SKILL.md, not a second implementation.

Offline: python3 -m unittest discover -s tests -v
Live: ASTOCK_LIVE_TRADE_DATE=2026-09-04 ASTOCK_LIVE_MARGIN_DATE=2026-09-03 \
      python3 -m unittest discover -s tests -v
"""

import calendar
import json
import os
import re
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd
import requests


def load_shipped_code():
    skill = (Path(__file__).resolve().parents[1] / "SKILL.md").read_text(encoding="utf-8")
    namespace = {}
    for name in ("official-data-core", "official-data-backups"):
        section = skill.split(f"<!-- {name}:start -->", 1)[1].split(f"<!-- {name}:end -->", 1)[0]
        block = re.search(r"```python\n(.*?)\n```", section, re.S).group(1)
        exec(compile(block, f"SKILL.md:{name}", "exec"), namespace)
    return namespace


class Response:
    def __init__(self, data=None, frame=None, status=200):
        self.data = data
        self.status_code = status
        self.url = "https://official.example/data"
        self.text = json.dumps(data) if data is not None else ""
        self.content = b""
        if frame is not None:
            buf = BytesIO()
            frame.to_excel(buf, index=False, engine="openpyxl")
            self.content = buf.getvalue()

    def json(self):
        return self.data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


def csi_frame():
    return pd.DataFrame({
        "日期Date": ["20260831", "20260831"], "指数代码 Index Code": ["000300", "000300"],
        "成份券代码Constituent Code": ["000001", "600519"],
        "成份券名称Constituent Name": ["平安银行", "贵州茅台"],
        "交易所Exchange": ["深圳证券交易所", "上海证券交易所"], "权重(%)weight": ["45", "55"],
    })


def sse_row():
    return {"opDate": "20260903", "stockCode": "600519", "securityAbbr": "贵州茅台",
            "rzye": 100, "rzmre": 0, "rqylje": None, "rqyl": 10, "rqmcl": 0}


def bse_row(code="920021", day="20260904"):
    row = {"hqjsrq": day, "hqzqdm": code, "hqzqjc": "样本", "hqgxsj": "153520", "hqsyl1": 8,
           "hqjrkp": 8.55, "hqzgcj": 9.99, "hqzdcj": 8.55, "hqzjcj": 9.19,
           "hqzrsp": 9.01, "hqcjsl": 63000262, "hqcjje": 586975791.9}
    for level in range(1, 6):
        for key in ("hqbjw", "hqbsl", "hqsjw", "hqssl"):
            row[f"{key}{level}"] = 0 if level == 5 else 100
    return row


def bse_response(rows, total):
    response = Response([{"content": rows, "totalElements": total}])
    response.text = "null(" + response.text + ");"
    return response


class OfficialDataTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_shipped_code()

    def call(self, name, response, *args, **kwargs):
        with patch.dict(self.ns, {"_official_get": MagicMock(return_value=response)}):
            return self.ns[name](*args, **kwargs)

    def test_index_code_and_provider_validation_before_network(self):
        get = MagicMock(side_effect=AssertionError("network should not run"))
        with patch.dict(self.ns, {"_official_get": get}):
            for code, provider in [("../000300", "csi"), ("000300.SH", "csi"), ("000300", "bad")]:
                with self.subTest(code=code, provider=provider), self.assertRaises(ValueError):
                    self.ns["index_constituents"](code, provider)

    def test_csi_leading_zeros_dates_provenance(self):
        out = self.call("index_constituents", Response(frame=csi_frame()), "000300")
        self.assertEqual(out.code.tolist(), ["000001", "600519"])
        self.assertEqual(set(out.date), {"2026-08-31"})
        self.assertEqual(out.exchange.tolist(), ["SZ", "SH"])
        self.assertEqual(set(out.source), {"csi"})
        self.assertTrue(out.fetched_at.str.endswith("+00:00").all())

    def test_weight_percent_not_fraction(self):
        out = self.call("index_weights", Response(frame=csi_frame()), "000300")
        self.assertEqual(out.weight_percent.tolist(), [45, 55])

    def test_weights_invalid_total(self):
        frame = csi_frame()
        frame["权重(%)weight"] = [0.45, 0.55]
        with self.assertRaises(RuntimeError):
            self.call("index_weights", Response(frame=frame), "000300")

    def test_malformed_and_empty_excel_fail(self):
        for response in [Response(), Response(frame=csi_frame().iloc[:0])]:
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                self.call("index_constituents", response, "000300")

    def test_index_missing_column_wrong_code_duplicate_and_mixed_dates(self):
        frames = [csi_frame().drop(columns="交易所Exchange"), pd.concat([csi_frame(), csi_frame()])]
        wrong = csi_frame(); wrong["指数代码 Index Code"] = "000905"; frames.append(wrong)
        mixed = csi_frame(); mixed.loc[0, "日期Date"] = "20260830"; frames.append(mixed)
        for frame in frames:
            with self.subTest(frame=frame.to_dict()), self.assertRaises(RuntimeError):
                self.call("index_constituents", Response(frame=frame), "000300")

    def test_cni_current_file_keeps_month_end(self):
        frame = pd.DataFrame({"日期": ["2026-08-31"], "样本代码": ["300750"],
                              "样本简称": ["宁德时代"], "权重（%）": [100]})
        out = self.call("index_weights", Response(frame=frame), "399006", "cni")
        self.assertEqual(out.iloc[0]["date"], "2026-08-31")
        self.assertEqual(out.iloc[0].exchange, "SZ")

    def test_cni_unsupported_security_fails(self):
        frame = pd.DataFrame({"日期": ["2026-08-31"], "样本代码": ["HSI"],
                              "样本简称": ["bad"], "权重（%）": [100]})
        with self.assertRaises(ValueError):
            self.call("index_weights", Response(frame=frame), "399006", "cni")

    def test_cni_hong_kong_code_is_not_padded_into_shenzhen(self):
        frame = pd.DataFrame({"日期": ["2026-08-31"], "样本代码": ["00700"],
                              "样本简称": ["腾讯控股"], "权重（%）": [100]})
        with self.assertRaises(ValueError):
            self.call("index_constituents", Response(frame=frame), "987008", "cni")

    def test_bse_code_is_not_accepted_as_shanghai_margin(self):
        with self.assertRaises(ValueError):
            self.ns["margin_trading_backup"]("2026-09-03", "SH", code="920021")

    def test_valuation_keeps_two_denominators_and_null(self):
        frame = pd.DataFrame({"日期Date": ["20260904"], "指数代码Index Code": ["000300"],
                              "市盈率1（总股本）P/E1": [14.87], "市盈率2（计算用股本）P/E2": [17.07],
                              "股息率1（总股本）D/P1": [2.58], "股息率2（计算用股本）D/P2": [None]})
        out = self.call("index_valuation", Response(frame=frame), "000300")
        self.assertEqual(out.iloc[0].pe_total, 14.87)
        self.assertEqual(out.iloc[0].pe_calculation, 17.07)
        self.assertTrue(pd.isna(out.iloc[0].dividend_yield_calculation_percent))
        self.assertNotIn("pb", out.columns)

    def calendar_rows(self):
        return [{"jyrq": f"2024-02-{day:02d}", "jybz": "0" if day == 19 else "1"}
                for day in range(1, 30)]

    def test_calendar_leap_year_and_source_flags(self):
        out = self.call("trading_calendar", Response({"data": self.calendar_rows()}), 2024, 2)
        self.assertEqual(len(out), 29)
        self.assertFalse(out.loc[out.date == "2024-02-19", "is_open"].iloc[0])

    def test_calendar_missing_duplicate_wrong_month_and_unknown_flags(self):
        rows = self.calendar_rows()
        bad_flag = [dict(x) for x in rows]; bad_flag[0]["jybz"] = "2"
        wrong_month = [dict(x) for x in rows]; wrong_month[0]["jyrq"] = "2024-01-01"
        for data in [rows[:-1], rows + [rows[0]], bad_flag, wrong_month, []]:
            with self.subTest(data=data[:1]), self.assertRaises(RuntimeError):
                self.call("trading_calendar", Response({"data": data}), 2024, 2)

    def test_calendar_invalid_parameters(self):
        for year, month in [(2026, 13), (True, 2), (2026, "9")]:
            with self.subTest(year=year, month=month), self.assertRaises(ValueError):
                self.ns["trading_calendar"](year, month)

    def test_sse_margin_preserves_missing_short_amount_and_zero_buy(self):
        out = self.call("margin_trading_backup", Response({"pageHelp": {"total": 1, "data": [sse_row()]}}),
                        "2026-09-03", "SH")
        self.assertTrue(pd.isna(out.iloc[0].short_balance))
        self.assertEqual(out.iloc[0].margin_buy, 0)

    def test_sse_incomplete_stale_or_schema_drift_fail(self):
        stale = sse_row(); stale["opDate"] = "20260902"
        missing = sse_row(); del missing["rqylje"]
        for total, rows in [(2, [sse_row()]), (0, []), (1, [stale]), (1, [missing])]:
            with self.subTest(total=total), self.assertRaises(RuntimeError):
                self.call("margin_trading_backup", Response({"pageHelp": {"total": total, "data": rows}}),
                          "2026-09-03", "SH")

    def test_margin_filter_empty_is_distinct_from_source_failure(self):
        out = self.call("margin_trading_backup", Response({"pageHelp": {"total": 1, "data": [sse_row()]}}),
                        "2026-09-03", "SH", code="600000")
        self.assertTrue(out.empty)
        self.assertIn("margin_balance", out.columns)

    def test_szse_excel_units_and_thousands_separator(self):
        frame = pd.DataFrame({"证券代码": ["000001"], "证券简称": ["平安银行"],
                              "融资余额(元)": ["4,640,385,102"], "融资买入额(元)": ["123,556,469"],
                              "融券余额(元)": ["88,293,787"], "融券余量(股/份)": ["7,432,137"],
                              "融券卖出量(股/份)": ["386,672"]})
        out = self.call("margin_trading_backup", Response(frame=frame), "2026-09-03", "SZ")
        self.assertEqual(out.iloc[0].code, "000001")
        self.assertEqual(out.iloc[0].margin_balance, 4640385102)
        with self.assertRaises(RuntimeError):
            self.call("margin_trading_backup", Response(frame=frame.iloc[:0]), "2026-09-03", "SZ")

    def test_returned_margin_security_matches_exchange(self):
        for exchange, ticker in [("SH", "920021"), ("SH", "000001"),
                                 ("SZ", "920021"), ("SZ", "600519")]:
            if exchange == "SH":
                row = {**sse_row(), "stockCode": ticker}
                response = Response({"pageHelp": {"data": [row], "total": 1}})
            else:
                record = {"证券代码": ticker, "证券简称": "错误市场"}
                record.update({key: "1" for key in ["融资余额(元)", "融资买入额(元)",
                               "融券余额(元)", "融券余量(股/份)", "融券卖出量(股/份)"]})
                response = Response(frame=pd.DataFrame([record]))
            with self.subTest(exchange=exchange, ticker=ticker), self.assertRaises(ValueError):
                self.call("margin_trading_backup", response, "2026-09-03", exchange)

    def test_malformed_pagination_totals_are_not_truncated(self):
        for total in [1.9, True, "1.9", -1, None]:
            with self.subTest(source="sse", total=total), self.assertRaises(RuntimeError):
                response = Response({"pageHelp": {"data": [sse_row()], "total": total}})
                self.call("margin_trading_backup", response, "2026-09-03", "SH")
            with self.subTest(source="bse", total=total), self.assertRaises(RuntimeError):
                self.bse_call([bse_response([bse_row()], total)])
        out = self.call("margin_trading_backup",
                        Response({"pageHelp": {"data": [sse_row()], "total": "1"}}),
                        "2026-09-03", "SH")
        self.assertEqual(len(out), 1)

    def bse_call(self, responses, code=None):
        session = MagicMock()
        session.__enter__.return_value = session
        session.get.return_value = Response(status=302)
        session.post.side_effect = responses
        with patch.object(requests, "Session", return_value=session), patch("time.sleep"):
            out = self.ns["bse_quote_backup"]("2026-09-04", code=code)
        return out, session

    def test_bse_pagination_units_and_zero_book(self):
        out, session = self.bse_call([bse_response([bse_row()], 2), bse_response([bse_row("920002")], 2)])
        self.assertEqual(len(out), 2)
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(out.iloc[0].volume, 63000262)
        self.assertEqual(out.iloc[0].amount, 586975791.9)
        self.assertEqual(out.iloc[0].bid_volume_5, 0)

    def test_bse_cookie_redirect_retried_once(self):
        out, session = self.bse_call([Response(status=302), bse_response([bse_row()], 1)], "920021")
        self.assertEqual(len(out), 1)
        self.assertEqual(session.get.call_count, 2)

    def test_bse_repeated_redirect_fails(self):
        with self.assertRaises(RuntimeError):
            self.bse_call([Response(status=302), Response(status=302)])

    def test_bse_stale_duplicate_incomplete_drift_fail(self):
        cases = [[bse_response([bse_row(day="20260903")], 1)],
                 [bse_response([bse_row(), bse_row()], 2)],
                 [bse_response([bse_row()], 2), bse_response([], 2)],
                 [bse_response([bse_row()], 2), bse_response([bse_row("920002")], 3)]]
        for responses in cases:
            with self.subTest(responses=responses), self.assertRaises(RuntimeError):
                self.bse_call(responses)

    def test_bse_wrong_code_or_missing_book_fails(self):
        missing = bse_row(); del missing["hqbjw1"]
        for row in [bse_row("600519"), missing]:
            with self.subTest(row=row), self.assertRaises(RuntimeError):
                self.bse_call([bse_response([row], 1)], "920021")

    def test_http_errors_propagate(self):
        with patch.object(requests, "get", return_value=Response(status=403)):
            with self.assertRaises(requests.HTTPError):
                self.ns["index_constituents"]("000300")


@unittest.skipUnless(os.getenv("ASTOCK_LIVE_TRADE_DATE"), "live network tests are opt-in")
class LiveOfficialDataTests(unittest.TestCase):
    def test_official_sources(self):
        ns = load_shipped_code()
        trade_date = os.environ["ASTOCK_LIVE_TRADE_DATE"]
        margin_date = os.environ.get("ASTOCK_LIVE_MARGIN_DATE", trade_date)
        year, month, _ = map(int, trade_date.split("-"))
        checks = [("index_constituents", ("000300",), {}, 300),
                  ("index_weights", ("000300",), {}, 300),
                  ("index_constituents", ("399006",), {"provider": "cni"}, 100),
                  ("index_weights", ("399006",), {"provider": "cni"}, 100),
                  ("index_valuation", ("000300",), {}, None),
                  ("trading_calendar", (year, month), {}, calendar.monthrange(year, month)[1]),
                  ("margin_trading_backup", (margin_date, "SH"), {}, None),
                  ("margin_trading_backup", (margin_date, "SZ"), {}, None),
                  ("bse_quote_backup", (trade_date,), {}, None),
                  ("bse_quote_backup", (trade_date,), {"code": "920021"}, 1)]
        for name, args, kwargs, expected in checks:
            with self.subTest(name=name, args=args, kwargs=kwargs):
                frame = ns[name](*args, **kwargs)
                self.assertFalse(frame.empty)
                if expected is not None:
                    self.assertEqual(len(frame), expected)
                print(json.dumps({"function": name, "args": args, "kwargs": kwargs, "rows": len(frame),
                                  "dates": [str(frame.date.min()), str(frame.date.max())]}, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
