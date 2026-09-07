from datetime import date, timedelta   # 本块单独拷贝也能跑；勿写成 import datetime（会被 §3+ 的
                                       # `from datetime import datetime` 遮蔽掉模块名）

def eastmoney_industry_reports(industry_code: str = "*", max_pages: int = 5,
                               begin: str = "") -> list[dict]:
    """拉取行业研报列表（qType=1）。
    industry_code="*" = 全行业；传东财行业码（如 "1238"=IT服务Ⅱ）= 单行业。
    行业名 / 行业码在每条 record 的 industryName / industryCode 字段。
    begin 留空 = 近两年（相对今天算，避免硬编码日期越用越旧）。"""
    if not begin:
        begin = (date.today() - timedelta(days=730)).isoformat()
    all_records = []
    for page in range(1, max_pages + 1):
        params = {
            "industryCode": industry_code, "pageSize": "100", "industry": "*",
            "rating": "*", "ratingChange": "*",
            "beginTime": begin, "endTime": "2030-01-01",
            "pageNo": str(page), "fields": "", "qType": "1",
        }
        r = em_get(REPORT_API, params=params,
                   headers={"Referer": "https://data.eastmoney.com/"}, timeout=30)  # 已内置限流
        d = r.json()
        rows = d.get("data") or []
        if not rows:
            break
        all_records.extend(rows)
        if page >= (d.get("TotalPage", 1) or 1):
            break
    return all_records

# 用法
# 1) 全行业最新研报
reports = eastmoney_industry_reports("*", max_pages=2)
print(f"共 {len(reports)} 篇行业研报")
for r in reports[:5]:
    print(f"  {r.get('publishDate','')[:10]} | {r.get('industryName')} | {r.get('orgSName')} | {r.get('title','')[:50]}")

# 2) 单行业（IT服务Ⅱ，行业码 1238）+ 下载首篇 PDF（复用 2.1 的 download_pdf）
it = eastmoney_industry_reports("1238", max_pages=1)
if it:
    download_pdf(it[0])
