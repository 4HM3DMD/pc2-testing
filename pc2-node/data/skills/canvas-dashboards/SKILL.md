---
name: Canvas Dashboards
description: Teaches the agent to create rich visual dashboards, tables, and data displays as desktop windows using the A2UI canvas tools
version: 1.0.0
author: Elacity
tools:
  - canvas_create
  - canvas_update
  - canvas_remove
permissions: []
---

# Canvas Dashboards

You can create live desktop windows with rich HTML content using the canvas tools. Use these to show dashboards, data tables, comparisons, status panels, and any visual information that works better as a window than as chat text.

## When to Use

Create a canvas window when:
- The user asks for a dashboard, overview, or summary that would benefit from visual layout
- Data has multiple columns or rows (tables, comparisons, portfolios)
- The response would be long and structured (system status, multi-chain balances)
- The user explicitly asks you to "show me" or "display" something
- You want to present a side-by-side comparison

Do NOT create a canvas for:
- Simple text answers or short responses
- Single values or quick facts
- Conversational replies

## HTML Best Practices

The canvas window has dark-theme base styles pre-applied. Your HTML should work within that context.

### Layout Patterns

**Data table** (most common):
```html
<h2>Portfolio Overview</h2>
<table>
  <thead><tr><th>Token</th><th>Balance</th><th>Value</th><th>Chain</th></tr></thead>
  <tbody>
    <tr><td>ETH</td><td>2.45</td><td style="color:#34c759">$4,890.00</td><td>Ethereum</td></tr>
    <tr><td>USDC</td><td>1,500.00</td><td>$1,500.00</td><td>Base</td></tr>
  </tbody>
</table>
```

**Stat cards** (for key metrics):
```html
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
  <div style="background:#2a2a3e;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:24px;font-weight:700;color:#34c759">$6,390</div>
    <div style="font-size:11px;color:#8e8e93;margin-top:4px">Total Value</div>
  </div>
  <div style="background:#2a2a3e;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:24px;font-weight:700;color:#007aff">3</div>
    <div style="font-size:11px;color:#8e8e93;margin-top:4px">Active Chains</div>
  </div>
  <div style="background:#2a2a3e;padding:16px;border-radius:8px;text-align:center">
    <div style="font-size:24px;font-weight:700;color:#ff9f0a">5</div>
    <div style="font-size:11px;color:#8e8e93;margin-top:4px">Tokens Held</div>
  </div>
</div>
```

**Side-by-side comparison**:
```html
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
  <div style="background:#2a2a3e;padding:16px;border-radius:8px">
    <h3>Option A</h3>
    <p>Details here...</p>
  </div>
  <div style="background:#2a2a3e;padding:16px;border-radius:8px">
    <h3>Option B</h3>
    <p>Details here...</p>
  </div>
</div>
```

### Color Palette

Use these semantic colors for consistency with the PC2 desktop:
- **Green** (positive/success): `#34c759`
- **Blue** (primary/info): `#007aff`
- **Red** (negative/error): `#ff3b30`
- **Yellow** (warning/caution): `#ffcc00`
- **Orange** (highlight): `#ff9f0a`
- **Purple** (accent): `#5856d6`
- **Muted text**: `#8e8e93`
- **Card background**: `#2a2a3e`
- **Border**: `#333`

### Status Badges

```html
<span class="badge badge-green">Active</span>
<span class="badge badge-blue">Pending</span>
<span class="badge badge-red">Error</span>
<span class="badge badge-yellow">Warning</span>
```

### Sizing Guidelines

- **Small panel** (single metric, status): `width: 400, height: 300`
- **Standard dashboard** (table + summary): `width: 600, height: 400`
- **Wide comparison** (side-by-side): `width: 800, height: 450`
- **Large dashboard** (multiple sections): `width: 900, height: 600`

## Updating Windows

Use `canvas_update` to refresh data in an existing window. Common patterns:
- Periodic data refresh (wallet balances, system status)
- Progressive loading (show skeleton first, then populate)
- User-triggered refresh ("update my dashboard")

Always keep the `canvas_id` from `canvas_create` to update later.

## Important Constraints

- Use inline styles only — external CSS/JS files will not load (sandboxed iframe)
- Keep HTML concise — very large HTML may hit token limits
- Do not include `<script>` tags — they work but increase attack surface
- The window body background is `#1e1e2e` with `#e0e0e0` text by default
- Tables, headings, links, code blocks, and badges have pre-applied base styles
