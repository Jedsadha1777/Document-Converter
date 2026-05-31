export const HANDLE_SIZE = 8;

export function _worldToBoxLocal(box, rotDeg, px, py) {
    if (!rotDeg) return { x: px, y: py };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const rad = -rotDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export function _boxLocalToWorld(box, rotDeg, lx, ly) {
    if (!rotDeg) return { x: lx, y: ly };
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const rad = rotDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = lx - cx, dy = ly - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export function _aabbOfRotated(box, rotDeg) {
    if (!rotDeg) return { x: box.x, y: box.y, w: box.w, h: box.h };
    const corners = [
        [box.x, box.y], [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx, ly] of corners) {
        const w = _boxLocalToWorld(box, rotDeg, lx, ly);
        if (w.x < minX) minX = w.x;
        if (w.y < minY) minY = w.y;
        if (w.x > maxX) maxX = w.x;
        if (w.y > maxY) maxY = w.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function _hitRotatedBox(box, rotDeg, px, py) {
    const lp = _worldToBoxLocal(box, rotDeg, px, py);
    return lp.x >= box.x && lp.x <= box.x + box.w &&
           lp.y >= box.y && lp.y <= box.y + box.h;
}

export function _hitHandle(box, px, py, zoom = 1, rotDeg = 0) {
    const hs = HANDLE_SIZE / Math.max(0.01, zoom);
    const lp = _worldToBoxLocal(box, rotDeg, px, py);
    const halves = [
        { name: "nw", cx: box.x,             cy: box.y },
        { name: "n",  cx: box.x + box.w / 2, cy: box.y },
        { name: "ne", cx: box.x + box.w,     cy: box.y },
        { name: "e",  cx: box.x + box.w,     cy: box.y + box.h / 2 },
        { name: "se", cx: box.x + box.w,     cy: box.y + box.h },
        { name: "s",  cx: box.x + box.w / 2, cy: box.y + box.h },
        { name: "sw", cx: box.x,             cy: box.y + box.h },
        { name: "w",  cx: box.x,             cy: box.y + box.h / 2 },
    ];
    for (const h of halves) {
        if (Math.abs(lp.x - h.cx) <= hs && Math.abs(lp.y - h.cy) <= hs) return h.name;
    }
    return null;
}

export function _rotationHandleLocalPos(box, zoom) {
    const offset = 28 / Math.max(0.01, zoom);
    return { x: box.x + box.w / 2, y: box.y + box.h + offset };
}

export function _rotationHandleWorldPos(box, rotDeg, zoom) {
    const local = _rotationHandleLocalPos(box, zoom);
    return _boxLocalToWorld(box, rotDeg, local.x, local.y);
}

export function _hitRotationHandle(box, rotDeg, px, py, zoom) {
    const z = Math.max(0.01, zoom);
    const pos = _rotationHandleWorldPos(box, rotDeg, z);
    const r = 11 / z;
    return Math.hypot(px - pos.x, py - pos.y) <= r;
}
