// WASM image tile processor — single fetch ของ original ต่อ (docId, page),
// แล้ว WASM downsample (stb_image_resize2) ไป level ที่ pickLevel เลือก.
// ลด HTTP request เหลือ 1 ครั้งต่อหน้า (ก่อนหน้าเรียก /levels/.../{N}.png ทุก zoom level).
//
// Architecture:
//   1. fetch original PNG (`/levels/{doc}/p{N}/0.png`) ครั้งเดียวต่อหน้า
//   2. WASM decode_png → RGBA buffer ใน heap (cached ใน originalCache)
//   3. peekLevel(level) → ถ้า level cache hit คืน bitmap; ไม่งั้น resize_rgba สังเคราะห์ขึ้น
//   4. createImageBitmap → drawImage on canvas (native, fast)
//
// ⚠ MEMORY SAFETY:
//   typed_memory_view = window เข้า WASM heap. ALLOW_MEMORY_GROWTH อาจย้าย heap → view detach.
//   ทุก call copy ทันที: `new Uint8ClampedArray(view.length).set(view)` ก่อน WASM call อื่น.

import createImageTilesModule from "/static/wasm/build/image_tiles.js";

let _modulePromise = null;
async function _ensureModule() {
    if (!_modulePromise) _modulePromise = createImageTilesModule();
    return _modulePromise;
}

// originalCache: "docId/page" → {ptr, w, h, mod, lastUsed} — RGBA buffer ใน WASM heap
// levelCache:    "docId/page/level" → {bitmap, w, h, lastUsed} — downsampled ImageBitmap (GPU-backed)
const originalCache = new Map();
const levelCache = new Map();
const failedCache = new Set();   // "docId/page" decode/fetch ล้มเหลว → skip
const _origPending = new Map();  // dedupe in-flight fetches per (docId, page)
const MAX_ORIGINALS = 8;        // จำกัด originals ใน heap (24MB/ภาพ × 8 ≈ 200MB)
const MAX_LEVELS = 64;          // bitmaps อยู่บน GPU, จำกัดเผื่อ accumulator leak

function _origKey(docId, page) { return `${docId}/${page}`; }
function _levelKey(docId, page, level) { return `${docId}/${page}/${level}`; }
function _origUrl(docId, page) { return `/levels/${docId}/p${page}/0.png`; }

function _loadOriginal(docId, page) {
    const key = _origKey(docId, page);
    if (failedCache.has(key)) return Promise.resolve(null);
    const cached = originalCache.get(key);
    if (cached) { cached.lastUsed = Date.now(); return Promise.resolve(cached); }
    const inflight = _origPending.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
        let bytes;
        try {
            const resp = await fetch(_origUrl(docId, page));
            if (!resp.ok) { failedCache.add(key); return null; }
            bytes = new Uint8Array(await resp.arrayBuffer());
        } catch {
            failedCache.add(key);
            return null;
        }
        const mod = await _ensureModule();
        const srcPtr = mod._malloc(bytes.length);
        mod.HEAPU8.set(bytes, srcPtr);
        const result = mod.decode_png(srcPtr, bytes.length);
        mod._free(srcPtr);
        const ptr = result.ptr, w = result.w, h = result.h;
        if (!ptr || w <= 0 || h <= 0) {
            failedCache.add(key);
            return null;
        }
        const handle = { ptr, w, h, mod, lastUsed: Date.now() };
        originalCache.set(key, handle);
        _enforceOriginalLru();
        return handle;
    })().finally(() => _origPending.delete(key));

    _origPending.set(key, promise);
    return promise;
}

function _enforceOriginalLru() {
    if (originalCache.size <= MAX_ORIGINALS) return;
    const entries = [...originalCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const evictN = originalCache.size - MAX_ORIGINALS;
    for (let i = 0; i < evictN; i++) {
        const [k, h] = entries[i];
        if (h.mod && h.ptr) h.mod.free_stbi(h.ptr);
        originalCache.delete(k);
        // ลบ level cache ที่ derive จาก original ตัวนี้ด้วย (มี prefix เดียวกัน)
        const prefix = k + "/";
        for (const lk of [...levelCache.keys()]) {
            if (lk.startsWith(prefix)) {
                const lh = levelCache.get(lk);
                if (lh?.bitmap?.close) lh.bitmap.close();
                levelCache.delete(lk);
            }
        }
    }
}

function _enforceLevelLru() {
    if (levelCache.size <= MAX_LEVELS) return;
    const entries = [...levelCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const evictN = levelCache.size - MAX_LEVELS;
    for (let i = 0; i < evictN; i++) {
        const [k, h] = entries[i];
        if (h.bitmap?.close) h.bitmap.close();
        levelCache.delete(k);
    }
}

// Synthesize level N bitmap from cached original via WASM resize.
// level 0 = full size (no resize, use original bytes directly).
async function _buildLevel(originalHandle, level) {
    const { ptr, w, h, mod } = originalHandle;
    const dstW = Math.max(1, w >> level);   // == floor(w / 2^level)
    const dstH = Math.max(1, h >> level);

    let bytes;
    let resizedPtr = 0;
    if (level === 0) {
        // level 0 = original buffer direct
        const view = mod.view_bytes(ptr, w * h * 4);
        if (!view) return null;
        bytes = new Uint8ClampedArray(view.length);
        bytes.set(view);
    } else {
        const result = mod.resize_rgba(ptr, w, h, dstW, dstH);
        if (!result || !result.ptr) return null;
        resizedPtr = result.ptr;
        const view = mod.view_bytes(resizedPtr, result.byte_len);
        if (!view) { mod.free_malloc(resizedPtr); return null; }
        // copy ทันทีก่อน WASM call ถัดไป (memory growth = view detach)
        bytes = new Uint8ClampedArray(view.length);
        bytes.set(view);
        mod.free_malloc(resizedPtr);
    }
    let bitmap = null;
    try {
        const imgData = new ImageData(bytes, dstW, dstH);
        bitmap = await createImageBitmap(imgData);
    } catch (e) {
        console.warn("createImageBitmap failed at level", level, e);
        return null;
    }
    return { bitmap, w: dstW, h: dstH, lastUsed: Date.now() };
}

async function _loadLevelHandle(docId, page, level) {
    const lkey = _levelKey(docId, page, level);
    const cached = levelCache.get(lkey);
    if (cached) { cached.lastUsed = Date.now(); return cached; }
    const orig = await _loadOriginal(docId, page);
    if (!orig) return null;
    const handle = await _buildLevel(orig, level);
    if (!handle) return null;
    levelCache.set(lkey, handle);
    _enforceLevelLru();
    return handle;
}

// Sync peek — return cached level handle ทันที + trigger async load ถ้ายังไม่มี.
const _pending = new Map();
export function peekLevel(docId, page, level, onReady) {
    if (failedCache.has(_origKey(docId, page))) return null;
    const lkey = _levelKey(docId, page, level);
    const h = levelCache.get(lkey);
    if (h) { h.lastUsed = Date.now(); return h; }
    if (!_pending.has(lkey)) {
        _pending.set(lkey, _loadLevelHandle(docId, page, level).then(handle => {
            _pending.delete(lkey);
            if (handle && onReady) onReady(handle);
            return handle;
        }));
    } else if (onReady) {
        _pending.get(lkey).then(handle => { if (handle) onReady(handle); });
    }
    return null;
}

export async function requestLevel(docId, page, level) {
    return _loadLevelHandle(docId, page, level);
}

// Pure-WASM crop path — ใช้ผ่าน putImageData (no transform). Caller fallback ถ้า null.
export async function cropTileImageData(docId, page, level, x, y, w, h) {
    const lvlH = await _loadLevelHandle(docId, page, level);
    if (!lvlH) return null;
    // crop_rgba ต้องการ src RGBA ใน WASM heap — เราเก็บแค่ ImageBitmap ใน level cache.
    // สำหรับ tile-crop fallback ขนาดเล็ก: re-decode original + resize ก็ overhead สูง.
    // ดังนั้น crop เร็วๆ จาก original โดยตรง (skip ผ่าน level intermediate).
    const orig = await _loadOriginal(docId, page);
    if (!orig) return null;
    const mod = orig.mod;
    // scale crop coords ตาม level (input ของ caller คือ level coords)
    const scale = 1 << level;
    const srcX = x * scale, srcY = y * scale;
    const srcW = w * scale, srcH = h * scale;
    const cropped = mod.crop_rgba(orig.ptr, orig.w, orig.h, srcX, srcY, srcW, srcH);
    if (!cropped || !cropped.ptr) return null;
    let outBytes;
    if (level === 0) {
        const view = mod.view_bytes(cropped.ptr, cropped.byte_len);
        if (!view) { mod.free_malloc(cropped.ptr); return null; }
        outBytes = new Uint8ClampedArray(view.length);
        outBytes.set(view);
        mod.free_malloc(cropped.ptr);
    } else {
        // resize cropped → level-dim
        const resized = mod.resize_rgba(cropped.ptr, srcW, srcH, w, h);
        mod.free_malloc(cropped.ptr);
        if (!resized || !resized.ptr) return null;
        const view = mod.view_bytes(resized.ptr, resized.byte_len);
        if (!view) { mod.free_malloc(resized.ptr); return null; }
        outBytes = new Uint8ClampedArray(view.length);
        outBytes.set(view);
        mod.free_malloc(resized.ptr);
    }
    return new ImageData(outBytes, w, h);
}

export function clearCache() {
    for (const h of levelCache.values()) {
        if (h.bitmap?.close) h.bitmap.close();
    }
    levelCache.clear();
    for (const h of originalCache.values()) {
        if (h.mod && h.ptr) h.mod.free_stbi(h.ptr);
    }
    originalCache.clear();
    failedCache.clear();
}

/** เลือก level จาก zoom — เหมือนเดิม (powers of 2). */
export function pickLevel(zoom, maxLevel) {
    const lvl = Math.round(-Math.log2(Math.max(0.001, zoom)));
    return Math.max(0, Math.min(maxLevel, lvl));
}
