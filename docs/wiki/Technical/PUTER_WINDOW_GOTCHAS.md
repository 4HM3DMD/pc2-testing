# Puter UIWindow Gotchas

> Known quirks when building apps that run inside PC2/Puter UIWindow iframes.

---

## Bottom Clipping (~3-4px)

**Discovered:** Mar 16, 2026 — Media Runtime player controls bar

**Issue:** The Puter UIWindow's content area (`.window-body-app`) clips the bottom ~3-4px of the iframe content. Elements positioned at the very bottom of the viewport will have their lower portion cut off.

**Root cause:** The `.window-body-app` height is `calc(100% - 30px)` (accounting for the 30px window title bar). This calculation appears to be slightly short of the actual available content height, possibly due to sub-pixel rounding, window chrome borders, or the title bar being slightly taller than 30px.

**Evidence:** Adding debug borders (`border-top: 2px solid lime; border-bottom: 2px solid red`) to a bottom-anchored element showed the green top border clearly, but the red bottom border was clipped/invisible at the window edge.

**Fix:** Add extra bottom padding to compensate. Typical values:

```css
/* Instead of symmetric padding: */
padding: 6px 16px;        /* ❌ Bottom appears clipped */

/* Add 3-4px extra to the bottom: */
padding: 6px 16px 10px;   /* ✅ Visually centered */
```

**Affected scenarios:**
- Any app with a fixed bottom bar (controls, status bar, toolbar)
- Apps that rely on `height: 100%` to fill the window
- Content that should sit flush against the window bottom edge

**Does NOT affect:**
- Fullscreen mode (no window chrome, no clipping)
- Content that doesn't extend to the very bottom of the viewport

**Debug technique:** Add colored borders to the element you suspect is being clipped:

```css
.my-bottom-bar {
  border-top: 2px solid lime;    /* top edge — should be visible */
  border-bottom: 2px solid red;  /* bottom edge — will be clipped if issue present */
}
```

If the green line is visible but the red line is not, the window is clipping the bottom.

---

## Relevant CSS Selectors (Puter GUI)

From `src/gui/src/css/style.css`:

| Selector | Role |
|----------|------|
| `.window-body` | Generic window content area: `height: calc(100% - 77px)` |
| `.window-body-app` | App-specific content area: `height: calc(100% - 30px)` |
| `.window-app-iframe` | The iframe itself: `width: 100%; height: 100%; border: none; margin: 0` |

The iframe has no padding or margin. The clipping comes from the parent `.window-body-app` height calculation.
