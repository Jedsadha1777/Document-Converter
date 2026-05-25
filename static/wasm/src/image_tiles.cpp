// image_tiles — WASM module (C++ via emscripten, embind).
// Pattern เดียวกับ reference/Ketchup/core/wasm/spatial_grid.cpp:
// คอมไพล์เป็น ES6 module (MODULARIZE=1, EXPORT_ES6=1).
//
// Pipeline:
//   1. JS pass PNG bytes (Uint8Array) → decode_png_to_rgba() → returns {w, h, ptr}
//      ภายใน decode ผ่าน stb_image (single-header, no PNG deps)
//   2. JS เก็บ ptr+dims เป็น handle (per level image) — load PNG ครั้งเดียวต่อ level
//   3. crop_rgba(ptr, srcW, srcH, x, y, w, h) → คืน buffer ที่ crop แล้ว
//      (resampling: bilinear scaling ทำใน drawImage ฝั่ง JS ตอน render — WASM crop = native pixel copy)
//   4. JS free(ptr) ตอนเปลี่ยน level/page

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#include "stb_image.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>

using namespace emscripten;

// Decode PNG bytes → RGBA in heap. Returns handle {ptr, w, h}.
// JS responsibility: call free_buffer(ptr) เมื่อไม่ใช้แล้ว.
val decode_png(uintptr_t src_ptr, int src_len) {
    const auto* src = reinterpret_cast<const stbi_uc*>(src_ptr);
    int w = 0, h = 0, channels = 0;
    stbi_uc* rgba = stbi_load_from_memory(src, src_len, &w, &h, &channels, 4);
    val out = val::object();
    if (!rgba) {
        out.set("ptr", 0);
        out.set("w", 0);
        out.set("h", 0);
        out.set("err", std::string(stbi_failure_reason() ? stbi_failure_reason() : "decode failed"));
        return out;
    }
    out.set("ptr", reinterpret_cast<uintptr_t>(rgba));
    out.set("w", w);
    out.set("h", h);
    return out;
}

// Crop rectangle (x, y, w, h) จาก source RGBA buffer.
// Returns Uint8Array view (typed_memory_view) ของ allocated heap buffer.
// JS ใช้ buffer copy หรือ ImageData.set โดยตรง → แล้ว call free_buffer().
val crop_rgba(uintptr_t src_ptr, int src_w, int src_h, int x, int y, int w, int h) {
    auto* src = reinterpret_cast<const uint8_t*>(src_ptr);
    auto* dst = static_cast<uint8_t*>(std::malloc(static_cast<size_t>(w) * h * 4));
    if (!dst) {
        return val::null();
    }
    // bounds clip
    const int clip_x = (x < 0) ? -x : 0;
    const int clip_y = (y < 0) ? -y : 0;
    const int clip_r = (x + w > src_w) ? (x + w - src_w) : 0;
    const int clip_b = (y + h > src_h) ? (y + h - src_h) : 0;
    // ส่วนนอก src → fill transparent
    std::memset(dst, 0, static_cast<size_t>(w) * h * 4);
    const int copy_w = w - clip_x - clip_r;
    const int copy_h = h - clip_y - clip_b;
    if (copy_w > 0 && copy_h > 0) {
        for (int j = 0; j < copy_h; j++) {
            const int sy = y + clip_y + j;
            const int dy = clip_y + j;
            const uint8_t* src_row = src + (sy * src_w + (x + clip_x)) * 4;
            uint8_t* dst_row = dst + (dy * w + clip_x) * 4;
            std::memcpy(dst_row, src_row, static_cast<size_t>(copy_w) * 4);
        }
    }
    val out = val::object();
    out.set("ptr", reinterpret_cast<uintptr_t>(dst));
    out.set("byte_len", w * h * 4);
    return out;
}

// JS gets typed_memory_view of buffer → can copy into Uint8ClampedArray for ImageData.
val view_bytes(uintptr_t ptr, int byte_len) {
    return val(typed_memory_view(byte_len, reinterpret_cast<uint8_t*>(ptr)));
}

void free_buffer(uintptr_t ptr) {
    if (ptr) std::free(reinterpret_cast<void*>(ptr));
}

EMSCRIPTEN_BINDINGS(image_tiles_module) {
    function("decode_png", &decode_png);
    function("crop_rgba", &crop_rgba);
    function("view_bytes", &view_bytes);
    function("free_buffer", &free_buffer);
}
