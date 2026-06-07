# Smart Guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Ketchup's Smart Guides (Figma-style alignment hints with snap correction) into docling's SelectTool — separately for the subtitle (bbox) layer and the markup (shape) layer, with no cross-layer guide interaction.

**Architecture:**
- Single pure module `visual/utils/smart-guides.js` (port of `reference/Ketchup/utils/SmartGuides.js`) — takes a moving bbox + array of stationary bboxes + threshold, returns `{ dx, dy, guides }`.
- SelectTool calls it from the two existing drag paths (`onPointerMove` for bbox, `_markupPointerMove` for markup). Each path supplies only its OWN layer's stationary objects, so guides per-layer is enforced by source, not by filtering.
- `activeGuides` stored as instance field on SelectTool, drawn in `drawOverlay()` (already runs per-frame). Cleared on `onPointerUp`.

**Tech Stack:** Vanilla JS, Canvas 2D, existing `viewport.getZoom()` for screen-px → world unit conversion.

---

## File Structure

| File | Responsibility |
|---|---|
| `static/js/visual/utils/smart-guides.js` (new) | Pure `computeGuides()` function. Port of Ketchup. |
| `static/js/visual/tools/SelectTool.js` (modify) | Call `computeGuides` from bbox move path + markup move path. Store + render `activeGuides`. |

---

## Task 1: Port `smart-guides.js` from Ketchup

**Files:**
- Create: `static/js/visual/utils/smart-guides.js`

- [ ] **Step 1: Create the utility file as 1:1 port of Ketchup's SmartGuides.js**

```js
// Smart Guides — Figma/Sketch-style alignment hints. Given a moving bbox and a
// list of stationary bboxes, find which edges/centers are within threshold and
// return both the snap correction (dx/dy) and visual guide line segments.
// Caller converts threshold (CSS px) to world units before calling.

function lines(b) {
    return {
        left:    b.x,
        centerX: b.x + b.width / 2,
        right:   b.x + b.width,
        top:     b.y,
        centerY: b.y + b.height / 2,
        bottom:  b.y + b.height,
    };
}

const X_KEYS = ["centerX", "left", "right"];
const Y_KEYS = ["centerY", "top",  "bottom"];

function isCenterX(mKey, oKey) { return mKey === "centerX" || oKey === "centerX"; }
function isCenterY(mKey, oKey) { return mKey === "centerY" || oKey === "centerY"; }

export function computeGuides(movingBbox, others, threshold) {
    if (!others || others.length === 0) return { dx: 0, dy: 0, guides: [] };

    const m = lines(movingBbox);
    let bestX = null, bestY = null;

    const better = (cur, cand) => {
        if (!cur) return true;
        if (cand.isCenter && !cur.isCenter) return true;
        if (!cand.isCenter && cur.isCenter) return false;
        return Math.abs(cand.diff) < Math.abs(cur.diff);
    };

    for (const o of others) {
        const ol = lines(o);
        for (const mKey of X_KEYS) {
            for (const oKey of X_KEYS) {
                const diff = ol[oKey] - m[mKey];
                if (Math.abs(diff) > threshold) continue;
                const cand = { diff, position: ol[oKey], mKey, oKey, isCenter: isCenterX(mKey, oKey), o };
                if (better(bestX, cand)) bestX = cand;
            }
        }
        for (const mKey of Y_KEYS) {
            for (const oKey of Y_KEYS) {
                const diff = ol[oKey] - m[mKey];
                if (Math.abs(diff) > threshold) continue;
                const cand = { diff, position: ol[oKey], mKey, oKey, isCenter: isCenterY(mKey, oKey), o };
                if (better(bestY, cand)) bestY = cand;
            }
        }
    }

    const dx = bestX ? bestX.diff : 0;
    const dy = bestY ? bestY.diff : 0;
    const snappedM = lines({
        x: movingBbox.x + dx, y: movingBbox.y + dy,
        width: movingBbox.width, height: movingBbox.height,
    });
    const tol = 0.5;
    const guides = [];

    if (bestX) {
        let min = Math.min(snappedM.top, snappedM.bottom);
        let max = Math.max(snappedM.top, snappedM.bottom);
        for (const o of others) {
            const ol = lines(o);
            for (const oKey of X_KEYS) {
                if (Math.abs(ol[oKey] - bestX.position) <= tol) {
                    if (ol.top < min) min = ol.top;
                    if (ol.bottom > max) max = ol.bottom;
                    break;
                }
            }
        }
        guides.push({ axis: "x", position: bestX.position, min, max });
    }

    if (bestY) {
        let min = Math.min(snappedM.left, snappedM.right);
        let max = Math.max(snappedM.left, snappedM.right);
        for (const o of others) {
            const ol = lines(o);
            for (const oKey of Y_KEYS) {
                if (Math.abs(ol[oKey] - bestY.position) <= tol) {
                    if (ol.left < min) min = ol.left;
                    if (ol.right > max) max = ol.right;
                    break;
                }
            }
        }
        guides.push({ axis: "y", position: bestY.position, min, max });
    }

    if (bestX && bestY && bestX.o === bestY.o
        && bestX.mKey === "centerX" && bestX.oKey === "centerX"
        && bestY.mKey === "centerY" && bestY.oKey === "centerY") {
        guides.push({ kind: "absoluteCenter", x: bestX.position, y: bestY.position, target: bestX.o });
    }

    return { dx, dy, guides };
}
```

- [ ] **Step 2: Commit**

```bash
git add static/js/visual/utils/smart-guides.js
git commit -m "feat: port Ketchup Smart Guides utility (computeGuides)"
```

---

## Task 2: Bbox layer — snap + collect guides during drag

**Files:**
- Modify: `static/js/visual/tools/SelectTool.js` (top imports + `onPointerMove` `move` branch + constructor + `onPointerUp`)

- [ ] **Step 1: Add import + constant near top of SelectTool.js**

After existing imports (around line 12), add:

```js
import { computeGuides } from "../utils/smart-guides.js";

const SMART_GUIDE_THRESHOLD_PX = 6;   // screen-px tolerance, matches Ketchup default
```

- [ ] **Step 2: Initialize `activeGuides` in constructor**

In `SelectTool` constructor (line ~139):

```js
constructor() {
    super("select", "Select", { cursor: "default" });
    this.activeGuides = [];
}
```

- [ ] **Step 3: Replace bbox `move` branch with snap-aware version**

In `onPointerMove`, locate the `if (dr.mode === "move")` block (around line 291-295) and replace with:

```js
if (dr.mode === "move") {
    const dxScreen = px - dr.startX;
    const dyScreen = py - dr.startY;
    // candidate moving bbox at proposed position
    const movingBbox = { x: sb.x + dxScreen, y: sb.y + dyScreen, width: sb.w, height: sb.h };
    // others = other bboxes on same page from drawn[]; exclude selected refs
    const selectedRefs = ctx.sel.refs;
    const others = [];
    for (const d of ctx.drawn) {
        if (!d.item?.self_ref) continue;
        if (selectedRefs.has(d.item.self_ref)) continue;
        others.push({ x: d.x, y: d.y, width: d.w, height: d.h });
    }
    const threshold = SMART_GUIDE_THRESHOLD_PX / (viewport.getZoom() || 1);
    const g = ev.shiftKey ? { dx: 0, dy: 0, guides: [] } : computeGuides(movingBbox, others, threshold);
    ov.x = sb.x + dxScreen + g.dx;
    ov.y = sb.y + dyScreen + g.dy;
    ov.w = sb.w;
    ov.h = sb.h;
    this.activeGuides = g.guides;
}
```

- [ ] **Step 4: Clear guides on bbox pointer up**

At end of `onPointerUp` (after `wrap.classList.remove("dragging");` line ~393), before final `doDraw()`:

```js
this.activeGuides = [];
```

- [ ] **Step 5: Commit**

```bash
git add static/js/visual/tools/SelectTool.js
git commit -m "feat: smart guide snap for bbox layer drag"
```

---

## Task 3: Markup layer — snap + collect guides during drag

**Files:**
- Modify: `static/js/visual/tools/SelectTool.js` (`_markupPointerMove` `move` branch + `_markupPointerUp`)

- [ ] **Step 1: Replace markup `move` branch with snap-aware version**

In `_markupPointerMove`, locate `if (dr.mode === "move")` (around line 606-609) and replace with:

```js
if (dr.mode === "move") {
    const movingBbox = { x: sb.x + dx, y: sb.y + dy, width: sb.w, height: sb.h };
    const pageNo = _currentPageNo();
    // others = other shapes on same page, excluding selected
    const selectedIds = state.markupSelection.ids || new Set();
    const others = [];
    for (const s of state.markup) {
        if (selectedIds.has(s.id)) continue;
        if (s.pageNo && s.pageNo !== pageNo) continue;
        others.push({ x: s.x, y: s.y, width: s.w, height: s.h });
    }
    const threshold = SMART_GUIDE_THRESHOLD_PX / (viewport.getZoom() || 1);
    const g = ev.shiftKey ? { dx: 0, dy: 0, guides: [] } : computeGuides(movingBbox, others, threshold);
    shape.x = sb.x + dx + g.dx;
    shape.y = sb.y + dy + g.dy;
    this.activeGuides = g.guides;
}
```

- [ ] **Step 2: Clear guides on markup pointer up**

At end of `_markupPointerUp` (after `wrap.classList.remove("dragging");` line ~658), before final `doDraw()`:

```js
this.activeGuides = [];
```

- [ ] **Step 3: Commit**

```bash
git add static/js/visual/tools/SelectTool.js
git commit -m "feat: smart guide snap for markup layer drag"
```

---

## Task 4: Render guides in `drawOverlay`

**Files:**
- Modify: `static/js/visual/tools/SelectTool.js` (`drawOverlay`)

- [ ] **Step 1: Update `drawOverlay` to always draw `activeGuides` (regardless of layer)**

Current `drawOverlay` returns early if layer !== "markup" (line 399). Refactor so it always draws guides if any, then conditionally draws markup-selection chrome:

```js
drawOverlay(canvasCtx, opts) {
    const z = opts.zoom;

    // Smart guides — drawn for whichever layer is currently dragging
    if (this.activeGuides?.length) {
        canvasCtx.save();
        canvasCtx.strokeStyle = COLORS.primary || "#2563eb";
        canvasCtx.lineWidth = 1 / z;
        canvasCtx.setLineDash([]);
        for (const g of this.activeGuides) {
            if (g.kind === "absoluteCenter") {
                const r = 6 / z;
                canvasCtx.beginPath();
                canvasCtx.moveTo(g.x - r, g.y); canvasCtx.lineTo(g.x + r, g.y);
                canvasCtx.moveTo(g.x, g.y - r); canvasCtx.lineTo(g.x, g.y + r);
                canvasCtx.stroke();
                continue;
            }
            canvasCtx.beginPath();
            if (g.axis === "x") {
                canvasCtx.moveTo(g.position, g.min);
                canvasCtx.lineTo(g.position, g.max);
            } else {
                canvasCtx.moveTo(g.min, g.position);
                canvasCtx.lineTo(g.max, g.position);
            }
            canvasCtx.stroke();
        }
        canvasCtx.restore();
    }

    if (getLayer() !== "markup") return;
    // ... existing markup selection chrome (unchanged) ...
}
```

The existing markup chrome code from line 400 onwards stays as-is; only the early return is moved AFTER the guide-drawing block.

- [ ] **Step 2: Commit**

```bash
git add static/js/visual/tools/SelectTool.js
git commit -m "feat: render active smart guides during drag"
```

---

## Task 5: Manual verification

**Files:** none

- [ ] **Step 1: Run the app and verify each layer's guides independently**

Per `superpowers:verification-before-completion`: claim verified only after observing.

Test cases:
1. **bbox layer**: select 1 bbox, drag near another bbox — blue guide line appears + snap to edge/center. Press Shift while dragging → no guide, no snap.
2. **markup layer**: switch layer, draw 2 rectangles, drag one near the other — guides appear + snap. Shift disables.
3. **cross-layer isolation**: in bbox layer, drag a bbox near a markup shape's edge — NO guide should appear (markup shapes not in candidate set). And vice versa.
4. **absoluteCenter**: center-align a small box inside a big one → crosshair appears at center.
5. **pointer up**: release → guides disappear immediately.

Capture: short note of what passed and what didn't. If any case fails, return to the relevant task and fix at the source.

---

## Self-Review

- ✅ Spec coverage: per-layer (Tasks 2 + 3 with separate code paths, no cross-layer query); Shift disables snap (Tasks 2 + 3); guides render (Task 4); cleanup on pointer up (Tasks 2 + 3).
- ✅ Type consistency: `movingBbox` shape `{x, y, width, height}` everywhere; `g.guides` is array; `activeGuides` is `this.activeGuides` consistently.
- ✅ No placeholders.
- Move mode: snap = position only (`ov.x, ov.y`). ไม่แตะ `w/h/rotation`.
- Rotation: ใช้ storage `{x,y,w,h}` align กับ storage อื่น (ตรง Ketchup pattern).
- OCR placement ไม่ snap — snap ทำงานเฉพาะตอน user drag.
- **Scope = move snap เท่านั้น** — ตรงกับ Ketchup baseline (verified: Ketchup's resize path ใน SelectTool.js:376 ไม่เรียก `computeGuides`). ถ้าอยากได้ resize snap ด้วย = **extension เหนือ Ketchup** — ผม implement ได้ แต่ user ต้องบอกชัด ๆ ก่อน เพราะไม่ใช่ "port" อีกแล้ว.
