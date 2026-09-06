"""
Convert a macro analysis markdown report to a self-contained HTML page,
and optionally to PDF via weasyprint.

Usage:
    python md_to_pdf.py <input.md> [--pdf] [--output-dir <dir>]

Output:
    - Always: a self-contained HTML file with warm paper styling
    - With --pdf: also a PDF file (requires weasyprint)
"""
import argparse
import re
import sys
from pathlib import Path


def md_to_html(md_text: str, title: str = "") -> str:
    """Basic markdown-to-HTML converter using only stdlib."""

    # Escape HTML entities
    def escape(text: str) -> str:
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    lines = md_text.split("\n")
    html_lines = []
    in_table = False
    in_thead = False
    table_lines = []
    in_code_block = False
    code_lines = []
    code_lang = ""
    list_stack: list[str] = []  # track open list tags

    def close_lists(level: int = 0):
        nonlocal list_stack
        while len(list_stack) > level:
            tag = list_stack.pop()
            html_lines.append(f"</{tag}>")

    def flush_table():
        nonlocal in_table, in_thead, table_lines
        if not table_lines:
            return
        html_lines.append('<table class="data-table">')
        for i, row in enumerate(table_lines):
            cells = [c.strip() for c in row.split("|")[1:-1]]
            tag = "th" if i == 0 else "td"
            html_lines.append("<tr>")
            for c in cells:
                html_lines.append(f"<{tag}>{c}</{tag}>")
            html_lines.append("</tr>")
        html_lines.append("</table>")
        table_lines = []
        in_table = False
        in_thead = False

    for line in lines:
        # Code blocks
        if line.startswith("```"):
            if in_code_block:
                html_lines.append(f'<pre><code class="language-{code_lang}">{escape(chr(10).join(code_lines))}</code></pre>')
                code_lines = []
                in_code_block = False
            else:
                in_code_block = True
                code_lang = line[3:].strip()
            continue

        if in_code_block:
            code_lines.append(line)
            continue

        # Tables
        if "|" in line and line.strip().startswith("|"):
            if not in_table:
                close_lists()
                in_table = True
            if "---" in line and "|" in line:
                in_thead = True
                continue
            table_lines.append(line)
            continue
        elif in_table:
            flush_table()

        # Headings
        if line.startswith("# "):
            close_lists()
            text = line[2:].strip()
            id_slug = re.sub(r"[^a-zA-Z0-9一-鿿]+", "-", text).strip("-")
            html_lines.append(f'<h1 id="{id_slug}">{text}</h1>')
            continue
        if line.startswith("## "):
            close_lists()
            text = line[3:].strip()
            id_slug = re.sub(r"[^a-zA-Z0-9一-鿿]+", "-", text).strip("-")
            html_lines.append(f'<h2 id="{id_slug}">{text}</h2>')
            continue
        if line.startswith("### "):
            close_lists()
            text = line[4:].strip()
            id_slug = re.sub(r"[^a-zA-Z0-9一-鿿]+", "-", text).strip("-")
            html_lines.append(f'<h3 id="{id_slug}">{text}</h3>')
            continue

        # Horizontal rules
        if line.strip() == "---" or line.strip() == "***":
            close_lists()
            html_lines.append("<hr>")
            continue

        # Blockquotes
        if line.startswith("> "):
            close_lists()
            content = line[2:].strip()
            # Process inline formatting in blockquote
            content = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", content)
            content = re.sub(r"`([^`]+)`", r"<code>\1</code>", content)
            html_lines.append(f"<blockquote><p>{content}</p></blockquote>")
            continue

        # Unordered lists
        if re.match(r"^\s*[-*+]\s", line):
            if not list_stack or list_stack[-1] != "ul":
                html_lines.append("<ul>")
                list_stack.append("ul")
            content = line.strip()[2:]
            content = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", content)
            content = re.sub(r"`([^`]+)`", r"<code>\1</code>", content)
            html_lines.append(f"<li>{content}</li>")
            continue

        # Ordered lists
        if re.match(r"^\s*\d+\.\s", line):
            if not list_stack or list_stack[-1] != "ol":
                html_lines.append("<ol>")
                list_stack.append("ol")
            content = re.sub(r"^\s*\d+\.\s", "", line)
            content = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", content)
            content = re.sub(r"`([^`]+)`", r"<code>\1</code>", content)
            html_lines.append(f"<li>{content}</li>")
            continue

        # Empty line: close lists
        if line.strip() == "":
            close_lists()
            continue

        # Regular paragraph text
        close_lists()
        content = line.strip()
        if content:
            content = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", content)
            content = re.sub(r"`([^`]+)`", r"<code>\1</code>", content)
            # Inline links: [text](url)
            content = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', content)
            html_lines.append(f"<p>{content}</p>")

    # Flush remaining state
    flush_table()
    close_lists()

    body = "\n    ".join(html_lines)
    title_tag = title or "宏观分析报告"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title_tag}</title>
<style>
  :root {{
    --bg: #fdf6ec;
    --card-bg: #fffef9;
    --text: #3d3226;
    --accent: #8b5e3c;
    --border: #d4c5a9;
    --highlight: #f0e6d3;
    --muted: #7a6e5e;
    --red: #a0523b;
    --green: #4a7c59;
  }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: "Noto Serif SC", "Songti SC", "SimSun", "Source Han Serif SC", Georgia, serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.85;
    max-width: 800px;
    margin: 0 auto;
    padding: 48px 32px 96px;
  }}
  h1 {{
    font-size: 1.8em;
    color: var(--accent);
    border-bottom: 2px solid var(--border);
    padding-bottom: 12px;
    margin: 48px 0 20px;
    letter-spacing: 0.04em;
  }}
  h1:first-child {{ margin-top: 0; }}
  h2 {{
    font-size: 1.35em;
    color: var(--accent);
    margin: 36px 0 14px;
    letter-spacing: 0.03em;
  }}
  h3 {{
    font-size: 1.1em;
    color: #5a4a32;
    margin: 24px 0 10px;
    font-weight: 600;
  }}
  p {{ margin: 10px 0; text-align: justify; }}
  strong {{ color: #5a3a1a; }}
  blockquote {{
    margin: 16px 0;
    padding: 10px 18px;
    border-left: 3px solid var(--accent);
    background: var(--highlight);
    color: var(--muted);
    font-style: italic;
  }}
  blockquote p {{ margin: 4px 0; }}
  code {{
    background: #f5efe0;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.9em;
  }}
  pre {{
    background: #2b2420;
    color: #e8dcc8;
    padding: 16px 20px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 14px 0;
  }}
  pre code {{ background: none; padding: 0; font-size: 0.85em; }}
  hr {{
    border: none;
    border-top: 1px solid var(--border);
    margin: 32px 0;
  }}
  table.data-table {{
    width: 100%;
    border-collapse: collapse;
    margin: 18px 0;
    font-size: 0.92em;
    background: var(--card-bg);
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }}
  table.data-table th {{
    background: var(--accent);
    color: #fffef9;
    padding: 10px 12px;
    text-align: left;
    font-weight: 600;
    font-size: 0.9em;
    letter-spacing: 0.03em;
  }}
  table.data-table td {{
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }}
  table.data-table tr:nth-child(even) td {{
    background: #fdfaf3;
  }}
  table.data-table tr:hover td {{
    background: #f7f0e0;
  }}
  ol, ul {{
    margin: 10px 0 10px 24px;
  }}
  li {{ margin: 5px 0; }}
  .badge-benefit {{
    display: inline-block;
    background: #d4edda;
    color: #2d5a3b;
    padding: 1px 8px;
    border-radius: 3px;
    font-size: 0.85em;
    font-weight: 600;
  }}
  .badge-pressure {{
    display: inline-block;
    background: #fce4e4;
    color: #8b3a3a;
    padding: 1px 8px;
    border-radius: 3px;
    font-size: 0.85em;
    font-weight: 600;
  }}
  @media print {{
    body {{ background: white; padding: 24px 40px; }}
    table.data-table {{ box-shadow: none; border: 1px solid #ccc; }}
    @page {{ margin: 20mm 18mm; size: A4; }}
  }}
</style>
</head>
<body>
    {body}
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description="Convert markdown report to HTML/PDF")
    parser.add_argument("input", type=str, help="Input markdown file")
    parser.add_argument("--pdf", action="store_true", help="Also generate PDF (requires weasyprint)")
    parser.add_argument("--output-dir", type=str, default=None, help="Output directory (default: same as input)")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    md_text = input_path.read_text(encoding="utf-8")
    title = input_path.stem

    output_dir = Path(args.output_dir) if args.output_dir else input_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)

    html = md_to_html(md_text, title)

    html_path = output_dir / f"{input_path.stem}.html"
    html_path.write_text(html, encoding="utf-8")
    print(f"[OK] HTML: {html_path}")

    if args.pdf:
        pdf_path = output_dir / f"{input_path.stem}.pdf"
        pdf_ok = False

        # Method 1: weasyprint (cross-platform, needs system libs)
        try:
            from weasyprint import HTML
            HTML(string=html).write_pdf(str(pdf_path))
            print(f"[OK] PDF (weasyprint): {pdf_path}")
            pdf_ok = True
        except (ImportError, OSError):
            pass

        # Method 2: Microsoft Edge headless (Windows built-in)
        if not pdf_ok:
            import shutil
            edge = (
                shutil.which("msedge") or
                shutil.which("microsoft-edge") or
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" or
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
            )
            if edge and Path(edge).exists():
                import subprocess
                result = subprocess.run(
                    [edge, "--headless", f"--print-to-pdf={pdf_path}",
                     f"file:///{html_path.resolve()}"],
                    capture_output=True, timeout=30,
                    encoding="utf-8", errors="replace"
                )
                if result.returncode == 0 and pdf_path.exists():
                    print(f"[OK] PDF (Edge): {pdf_path}")
                    pdf_ok = True
                else:
                    print(f"[WARN] Edge PDF failed (rc={result.returncode})")

        # Method 3: Google Chrome headless
        if not pdf_ok:
            import shutil
            chrome = shutil.which("chrome") or shutil.which("google-chrome")
            if chrome:
                import subprocess
                result = subprocess.run(
                    [chrome, "--headless", "--disable-gpu",
                     f"--print-to-pdf={pdf_path}",
                     f"file:///{html_path.resolve()}"],
                    capture_output=True, timeout=30,
                    encoding="utf-8", errors="replace"
                )
                if result.returncode == 0 and pdf_path.exists():
                    print(f"[OK] PDF (Chrome): {pdf_path}")
                    pdf_ok = True

        if not pdf_ok:
            print("[WARN] No PDF engine available.")
            print("  - For weasyprint: install GTK runtime, then pip install weasyprint")
            print("  - Or open HTML in any browser and Print → Save as PDF (Ctrl+P)")
            print(f"  - HTML file: {html_path}")

    print("\nDone.")


if __name__ == "__main__":
    main()
