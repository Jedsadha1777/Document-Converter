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

// Center alignment trumps edge alignment when both within threshold — user
// aiming at "center" shouldn't lose to an edge with marginally smaller diff.
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

    // Span the drawn guide across every stationary bbox sitting on the same line
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

    // Absolute Center: both axes snap to same target's center → crosshair
    if (bestX && bestY && bestX.o === bestY.o
        && bestX.mKey === "centerX" && bestX.oKey === "centerX"
        && bestY.mKey === "centerY" && bestY.oKey === "centerY") {
        guides.push({ kind: "absoluteCenter", x: bestX.position, y: bestY.position, target: bestX.o });
    }

    return { dx, dy, guides };
}
