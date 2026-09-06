export function rejectAshareTicker(ticker: string): void {
  const normalized = ticker.trim().toUpperCase()
  if (/^(?:\d{6}(?:\.(?:SS|SZ|BJ|SH))?|(?:SH|SZ|BJ)\.?\d{6})$/u.test(normalized)) {
    throw new TypeError(
      'A-share securities must use finance_cn_instrument followed by the finance_cn_* curated tools',
    )
  }
}
