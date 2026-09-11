# 拉当日强势股 reason
df_hot = ths_hot_reason()

# 词频统计 reason 列里的题材关键词
from collections import Counter
all_tags = []
for r in df_hot["题材归因"].dropna():
    tags = [t.strip() for t in str(r).split("+") if t.strip()]
    all_tags.extend(tags)

cnt = Counter(all_tags)
print("当日 TOP 10 题材热度:")
for tag, n in cnt.most_common(10):
    print(f"  {tag}: {n} 只")

# 同时拉北向当日流向，看资金流方向是否对应题材
df_north = hsgt_realtime()
hgt_close = df_north["hgt_yi"].dropna().iloc[-1] if not df_north.empty else 0
sgt_close = df_north["sgt_yi"].dropna().iloc[-1] if not df_north.empty else 0
print(f"\n北向收盘累计: 沪股通 {hgt_close} 亿 / 深股通 {sgt_close} 亿")

# V3.0: 叠加行业对比，看哪些行业资金在流入
comp = industry_comparison(10)
print("\n行业涨幅 TOP 5:")
for r in comp["top"][:5]:
    print(f"  {r['name']}: {r['change_pct']}% 涨{r['up_count']}跌{r['down_count']}")
