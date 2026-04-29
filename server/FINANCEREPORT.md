# Financial Report Structure Guide

Use this template when generating an investment analysis HTML report. Every section below is required. Maintain the exact section order.

---

## Output Format

Produce a **complete, standalone HTML document** (`<!DOCTYPE html>` through `</html>`).
- Embed all CSS in a `<style>` tag in `<head>` — no external stylesheets.
- Dark theme: background `#0a0a0f`, primary text `#e0e0e0`, accent blue `#6495ed`.
- Font stack: `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`.
- No JavaScript required.
- Output **only** the HTML — no markdown fences, no explanation text.

---

## Required Sections (in order)

### 1. Header
- Company full name as `<h1>`
- Ticker symbol in a pill badge (blue background)
- Sector / exchange in a secondary pill badge
- One-line subtitle: "Investment Analysis · Based on SEC Filings"

### 2. KPI Grid
A responsive card grid (CSS `grid`, `repeat(auto-fit, minmax(220px, 1fr))`). Each card contains:
- **Label** (e.g. "FY Revenue", "Gross Profit", "Net Income")
- **Value** in large bold text (e.g. "$601.8M")
- **Change indicator**: green for positive YoY, red for negative (e.g. "▲ 38.0% YoY")
- Required KPIs: Latest Revenue, Gross Profit, Gross Margin %, Operating Income, Net Income, Cash & Equivalents, Total Debt (or "Near debt-free"), Shares Outstanding (if available)

### 3. Annual Financial Summary Table
Full-width HTML `<table>` with one row per year. Columns:
| Metric | FY-4 | FY-3 | FY-2 | FY-1 | Latest |
Required rows:
- Revenue (with YoY growth % on a sub-row)
- Gross Profit + Gross Margin %
- Operating Income
- Net Income
- Operating Cash Flow
- CapEx (if available)
- Free Cash Flow (Operating CF - CapEx, if both available)
- Cash & Equivalents
- Total Assets
- Total Liabilities

Color code values: green for positive, red for negative, neutral otherwise.

### 4. Quarterly Revenue Trend
Horizontal bar chart using only HTML/CSS (`div` bars, `flex` layout). Show last 6–8 quarters. Each row:
- Quarter label (e.g. "Q3 FY25")
- Proportional bar (green gradient, width = % of max quarter revenue)
- Value label on the right

### 5. Balance Sheet Snapshot
Metric-value pairs in a clean two-column layout:
- Cash & Equivalents
- Total Debt
- Net Cash (Cash - Debt)
- Total Assets
- Total Liabilities
- Stockholders' Equity (Assets - Liabilities)
- Inventory (if available)
- Accounts Receivable (if available)

### 6. Key Financial Ratios
Two-column metric list:
- Revenue Growth (YoY, latest full year)
- Gross Margin (latest)
- Operating Margin (latest)
- Net Margin (latest)
- R&D as % of Revenue (if available)
- Operating Cash Flow (latest year)
- Free Cash Flow (latest year)
- Current Ratio (est., if data allows)
- Debt-to-Equity (est.)
- Cash Runway (Cash / annual FCF burn, only if FCF is negative)

### 7. Bull Case / Bear Case
Side-by-side two-column card layout.

**Bull Case** (green border `rgba(74,222,128,0.2)`):
- 6–8 bullet points
- Each starts with "✓" in green
- Focus on: revenue growth trajectory, margin expansion, balance sheet strength, market opportunity, competitive moats, contract visibility

**Bear Case** (red border `rgba(248,113,113,0.2)`):
- 6–8 bullet points
- Each starts with "✗" in red
- Focus on: profitability timeline, cash burn rate, competitive threats, execution risks, market concentration, macro sensitivity

### 8. Bottom Line Verdict
A highlighted callout box (amber/yellow border `rgba(255,193,7,0.3)`):
- Bold heading: "⚡ Bottom Line"
- 3 paragraphs:
  1. **Summary**: What kind of company is this? Growth stage, mature, turnaround?
  2. **Key tension**: The central risk vs. reward trade-off (e.g. "gross margins expanding but losses widening due to R&D investment")
  3. **Investor takeaway**: For what type of investor / time horizon is this suitable? What is the single most important metric to watch?

### 9. Footer
- Data source: "Data sourced from SEC EDGAR filings via XBRL API · data.sec.gov"
- Generation note: "Generated [date] · Not investment advice"

---

## Styling Rules

- All monetary values formatted with suffix: `$601.8M`, `$1.7B`, `-$198.2M`
- Positive values: `color: #4ade80`
- Negative values: `color: #f87171`
- Neutral values: `color: #e0e0e0`
- Table headers: `background: #1a1a2e`, `color: #6495ed`
- Cards: `background: #141420`, `border: 1px solid #2a2a3a`, `border-radius: 10px`
- Section headers (`h2`): `color: #6495ed`, with a bottom border separator
- Hover effects on table rows and cards for interactivity

---

## If Data Is Missing

- If a metric is unavailable, display `—` (em dash), not "N/A" or blank.
- If fewer than 3 years of revenue data are available, skip the annual table and note "Insufficient historical data" in its place.
- If no quarterly data is available, skip section 4.
- Still generate all other sections using whatever data is present, and supplement with qualitative analysis where numbers are absent.
