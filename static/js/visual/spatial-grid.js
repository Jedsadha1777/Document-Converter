// Uniform spatial grid — JS port ของ Ketchup core/wasm/spatial_grid.cpp.
// แต่ละ object ใส่ลงทุก cell ที่ AABB ของมันคลุม. Query (point/rect) → return ids ใน cells ที่ overlap.
// สำหรับ 100 boxes/page linear scan ก็เร็วพอ — grid pays off ที่ 1000+ objects per visible.

const DEFAULT_CELL_SIZE = 200;       // pixel — ตาม Ketchup default

export class SpatialGrid {
    constructor(cellSize = DEFAULT_CELL_SIZE) {
        this.cellSize = cellSize;
        this.cells = new Map();       // "cx,cy" → Set<id>
        this.objects = new Map();     // id → {x, y, w, h}
    }

    _floorDiv(a, b) { return Math.floor(a / b); }

    _cellsFor(x, y, w, h) {
        const cs = this.cellSize;
        const sx = this._floorDiv(x, cs);
        const sy = this._floorDiv(y, cs);
        const ex = this._floorDiv(x + Math.max(0, w - 1), cs);
        const ey = this._floorDiv(y + Math.max(0, h - 1), cs);
        return { sx, sy, ex, ey };
    }

    insert(id, x, y, w, h) {
        if (this.objects.has(id)) this.remove(id);
        this.objects.set(id, { x, y, w, h });
        const { sx, sy, ex, ey } = this._cellsFor(x, y, w, h);
        for (let cy = sy; cy <= ey; cy++) {
            for (let cx = sx; cx <= ex; cx++) {
                const key = cx + "," + cy;
                let s = this.cells.get(key);
                if (!s) { s = new Set(); this.cells.set(key, s); }
                s.add(id);
            }
        }
    }

    remove(id) {
        const obj = this.objects.get(id);
        if (!obj) return;
        const { sx, sy, ex, ey } = this._cellsFor(obj.x, obj.y, obj.w, obj.h);
        for (let cy = sy; cy <= ey; cy++) {
            for (let cx = sx; cx <= ex; cx++) {
                const key = cx + "," + cy;
                const s = this.cells.get(key);
                if (s) {
                    s.delete(id);
                    if (s.size === 0) this.cells.delete(key);
                }
            }
        }
        this.objects.delete(id);
    }

    clear() { this.cells.clear(); this.objects.clear(); }

    /** Query objects with AABB containing (px, py). Returns array of ids — caller filter precisely. */
    queryAt(px, py) {
        const cs = this.cellSize;
        const key = this._floorDiv(px, cs) + "," + this._floorDiv(py, cs);
        const s = this.cells.get(key);
        if (!s) return [];
        const out = [];
        for (const id of s) {
            const o = this.objects.get(id);
            if (o && px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h) {
                out.push(id);
            }
        }
        return out;
    }

    /** Query objects with AABB overlapping rect (x, y, w, h). Returns Set of ids (unique). */
    queryRect(x, y, w, h) {
        const { sx, sy, ex, ey } = this._cellsFor(x, y, w, h);
        const seen = new Set();
        const out = new Set();
        for (let cy = sy; cy <= ey; cy++) {
            for (let cx = sx; cx <= ex; cx++) {
                const s = this.cells.get(cx + "," + cy);
                if (!s) continue;
                for (const id of s) {
                    if (seen.has(id)) continue;
                    seen.add(id);
                    const o = this.objects.get(id);
                    if (!o) continue;
                    // AABB overlap test
                    if (o.x + o.w >= x && o.x <= x + w &&
                        o.y + o.h >= y && o.y <= y + h) {
                        out.add(id);
                    }
                }
            }
        }
        return out;
    }

    get size() { return this.objects.size; }
}
