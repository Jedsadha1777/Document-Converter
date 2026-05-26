// WASM image tile processor — decode PNG + crop ผ่าน C++ (compiled to WASM via emscripten).
// Pattern เดียวกับ reference/Ketchup/core/SpatialGrid.js ที่ wrap WASM module.
//
// Architecture:
//   1. fetch level PNG ครั้งเดียวต่อ (docId, page, level) — single HTTP request
//   2. WASM decode_png → returns ptr to RGBA buffer ใน heap (cached per handle)
//   3. WASM crop_rgba(ptr, x, y, w, h) → returns ptr ของ cropped buffer
//   4. JS view เป็น Uint8ClampedArray → ImageData → putImageData on canvas
//
// ⚠ MEMORY SAFETY contract (typed_memory_view + ALLOW_MEMORY_GROWTH):
//   view_bytes() คืน typed_memory_view = หน้าต่างส่องตรงเข้า WASM heap (ไม่ copy).
//   ถ้า WASM heap ขยาย (memory growth) ระหว่างที่ JS ถือ view อยู่ → view detach ทันที.
//   ทุก call ต้อง copy ทันทีก่อน call WASM อื่นใด: `const c = new Uint8ClampedArray(view.length); c.set(view);`
//   pattern นี้ใช้ทุกที่ที่เรียก view_bytes() ในไฟล์นี้.

import createImageTilesModule from "/static/wasm/build/image_tiles.js";

let _modulePromise = null;

async function _ensureModule() {
    if (!_modulePromise) {
        _modulePromise = createImageTilesModule();
    }
    return _modulePromise;
}

// Cache decoded levels: key = "docId/page/level" → handle {ptr, w, h, bitmap?}
// LRU eviction บน level handles
const levelCache = new Map();
const failedCache = new Set();   // "docId/page/level" ที่ 404 / decode failed → skip
const MAX_LEVELS = 32;

function _key(docId, page, level) {
    return `${docId}/${page}/${level}`;
}
function _levelUrl(docId, page, level) {
    return `/levels/${docId}/p${page}/${level}.png`;
}

async function _loadLevelHandle(docId, page, level) {
    const key = _key(docId, page, level);
    if (failedCache.has(key)) return null;
    const cached = levelCache.get(key);
    if (cached) {
        cached.lastUsed = Date.now();
        return cached;
    }
    let bytes;
    try {
        const resp = await fetch(_levelUrl(docId, page, level));
        if (!resp.ok) { failedCache.add(key); return null; }
        const buf = await resp.arrayBuffer();
        bytes = new Uint8Array(buf);
    } catch (e) {
        failedCache.add(key);
        return null;
    }
    const mod = await _ensureModule();
    // copy PNG bytes into WASM heap
    const srcPtr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, srcPtr);
    const result = mod.decode_png(srcPtr, bytes.length);
    mod._free(srcPtr);
    const ptr = result.ptr;
    const w = result.w, h = result.h;
    if (!ptr || w <= 0 || h <= 0) {
        failedCache.add(key);
        return null;
    }
    // also create ImageBitmap สำหรับ render ผ่าน native drawImage (เร็วกว่า putImageData)
    let bitmap = null;
    try {
        // overflow-checked byte length (w,h เพิ่ง validate > 0 ด้านบน)
        const byteLen = w * h * 4;
        const view = mod.view_bytes(ptr, byteLen);
        if (!view) throw new Error("view_bytes returned null");
        // ⚠ copy ทันที — view เป็น typed_memory_view ที่อาจ detach ถ้า WASM memory grow
        const copy = new Uint8ClampedArray(view.length);
        copy.set(view);
        const imgData = new ImageData(copy, w, h);
        bitmap = await createImageBitmap(imgData);
    } catch (e) {
        console.warn("createImageBitmap failed; fallback to WASM crop+putImageData", e);
    }
    const handle = { ptr, w, h, bitmap, mod, lastUsed: Date.now() };
    levelCache.set(key, handle);
    _enforceLru();
    return handle;
}

function _enforceLru() {
    if (levelCache.size <= MAX_LEVELS) return;
    const entries = [...levelCache.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed
    );
    const evictN = levelCache.size - MAX_LEVELS;
    for (let i = 0; i < evictN; i++) {
        const [k, h] = entries[i];
        if (h.bitmap?.close) h.bitmap.close();
        // decode_png buffer = stb_image allocator → free_stbi (matches stbi_image_free)
        if (h.mod && h.ptr) h.mod.free_stbi(h.ptr);
        levelCache.delete(k);
    }
}

/** Get level handle (load + decode if needed). Returns null on fail. */
export async function requestLevel(docId, page, level) {
    return _loadLevelHandle(docId, page, level);
}

// Sync peek — return cached handle ทันที + trigger async load ถ้ายังไม่มี.
// Callback onReady() เรียกหลัง load สำเร็จ (ใช้ trigger redraw).
const _pending = new Map();
export function peekLevel(docId, page, level, onReady) {
    const key = _key(docId, page, level);
    if (failedCache.has(key)) return null;
    const h = levelCache.get(key);
    if (h) { h.lastUsed = Date.now(); return h; }
    // not cached — trigger async load (dedupe pending)
    if (!_pending.has(key)) {
        _pending.set(key, _loadLevelHandle(docId, page, level).then(handle => {
            _pending.delete(key);
            if (handle && onReady) onReady(handle);
            return handle;
        }));
    } else if (onReady) {
        _pending.get(key).then(handle => { if (handle) onReady(handle); });
    }
    return null;
}

/** Pure-WASM path: crop RGBA + return ImageData. ใช้ผ่าน ctx.putImageData (no transform).
 *  Returns null ถ้า input invalid (ผ่าน WASM-side validation) — caller fallback */
export async function cropTileImageData(docId, page, level, x, y, w, h) {
    const handle = await _loadLevelHandle(docId, page, level);
    if (!handle) return null;
    const mod = handle.mod;
    const result = mod.crop_rgba(handle.ptr, handle.w, handle.h, x, y, w, h);
    // WASM returns val::null() (= JS null) บน invalid input / overflow / OOM
    if (!result || !result.ptr) return null;
    const view = mod.view_bytes(result.ptr, result.byte_len);
    if (!view) { mod.free_malloc(result.ptr); return null; }
    // ⚠ ต้อง copy ทันทีก่อน WASM call ถัดไป — memory growth จะ detach view
    const copy = new Uint8ClampedArray(view.length);
    copy.set(view);
    // crop_rgba buffer = std::malloc allocator → free_malloc (matches std::free)
    mod.free_malloc(result.ptr);
    return new ImageData(copy, w, h);
}

export function clearCache() {
    for (const h of levelCache.values()) {
        if (h.bitmap?.close) h.bitmap.close();
        // decode_png buffer = stb_image allocator
        if (h.mod && h.ptr) h.mod.free_stbi(h.ptr);
    }
    levelCache.clear();
    failedCache.clear();
}

/** เลือก level จาก zoom — เหมือน tile-loader.js เดิม */
export function pickLevel(zoom, maxLevel) {
    const lvl = Math.round(-Math.log2(Math.max(0.001, zoom)));
    return Math.max(0, Math.min(maxLevel, lvl));
}
