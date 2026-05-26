// image_tiles — PNG decode + RGBA crop ผ่าน C++ → WASM (emscripten embind).
//
// API contract สำหรับ JS caller:
//   - decode_png → returns {ptr, w, h, kind:"stbi"}. Free via free_stbi (stb_image allocator).
//   - crop_rgba  → returns {ptr, byte_len, kind:"malloc"}. Free via free_malloc (std::malloc allocator).
//     ⚠ allocator ของ 2 ฟังก์ชันต่างกัน — ห้ามใช้ free ผิด path.
//   - view_bytes คืน typed_memory_view (ไม่ copy). JS ต้อง copy ทันทีก่อน WASM call ถัดไป
//     เพราะ ALLOW_MEMORY_GROWTH อาจย้าย heap → view detach.
// All inputs ผ่าน null/range/overflow guards; output bytes capped ที่ 1 GB.

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

static const int MAX_DIM = 1 << 24;
static const size_t MAX_BYTES = static_cast<size_t>(1) << 30;

static val _error_obj(const char* msg) {
    val out = val::object();
    out.set("ptr", 0);
    out.set("w", 0);
    out.set("h", 0);
    out.set("err", std::string(msg ? msg : "unknown"));
    return out;
}

static size_t _checked_bytes(int w, int h) {
    if (w <= 0 || h <= 0) return 0;
    const size_t wu = static_cast<size_t>(w);
    const size_t hu = static_cast<size_t>(h);
    const size_t bytes = wu * hu * 4u;
    if (hu != 0 && bytes / 4u / hu != wu) return 0;
    if (bytes > MAX_BYTES) return 0;
    return bytes;
}

val decode_png(uintptr_t src_ptr, int src_len) {
    if (src_ptr == 0 || src_len <= 0) {
        return _error_obj("invalid input (null ptr or non-positive length)");
    }
    const auto* src = reinterpret_cast<const stbi_uc*>(src_ptr);
    int w = 0, h = 0, channels = 0;
    stbi_uc* rgba = stbi_load_from_memory(src, src_len, &w, &h, &channels, 4);
    if (!rgba) {
        return _error_obj(stbi_failure_reason() ? stbi_failure_reason() : "decode failed");
    }
    if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) {
        stbi_image_free(rgba);
        return _error_obj("decoded dims out of range");
    }
    val out = val::object();
    out.set("ptr", reinterpret_cast<uintptr_t>(rgba));
    out.set("w", w);
    out.set("h", h);
    out.set("kind", std::string("stbi"));
    return out;
}

val crop_rgba(uintptr_t src_ptr, int src_w, int src_h, int x, int y, int w, int h) {
    if (src_ptr == 0 || src_w <= 0 || src_h <= 0 || w <= 0 || h <= 0) {
        return val::null();
    }
    // range cap → กัน int overflow ที่ x_end / y_end ใน 32-bit signed
    if (src_w > MAX_DIM || src_h > MAX_DIM || w > MAX_DIM || h > MAX_DIM ||
        x < -MAX_DIM || x > MAX_DIM || y < -MAX_DIM || y > MAX_DIM) {
        return val::null();
    }
    const size_t bytes = _checked_bytes(w, h);
    if (bytes == 0) return val::null();

    auto* dst = static_cast<uint8_t*>(std::malloc(bytes));
    if (!dst) return val::null();

    const auto* src = reinterpret_cast<const uint8_t*>(src_ptr);

    // bounds compare ใน 64-bit → กัน int overflow ที่ x+w ใกล้ INT_MAX
    const long long x_end = static_cast<long long>(x) + static_cast<long long>(w);
    const long long y_end = static_cast<long long>(y) + static_cast<long long>(h);
    const int clip_x = (x < 0) ? -x : 0;
    const int clip_y = (y < 0) ? -y : 0;
    const int clip_r = (x_end > src_w) ? static_cast<int>(x_end - src_w) : 0;
    const int clip_b = (y_end > src_h) ? static_cast<int>(y_end - src_h) : 0;
    const int copy_w_signed = w - clip_x - clip_r;
    const int copy_h_signed = h - clip_y - clip_b;

    std::memset(dst, 0, bytes);

    // crop rect นอก src ทั้งหมด → output คือ transparent ทั้งบัฟเฟอร์ (memset done above).
    // explicit signed-check ก่อน cast เป็น size_t — กัน negative wrap (-1 → 18446744073709551615)
    if (copy_w_signed > 0 && copy_h_signed > 0) {
        const size_t copy_w = static_cast<size_t>(copy_w_signed);
        const size_t copy_h = static_cast<size_t>(copy_h_signed);
        const size_t src_w_st = static_cast<size_t>(src_w);
        const size_t dst_w_st = static_cast<size_t>(w);
        const size_t src_x0_st = static_cast<size_t>(x + clip_x);
        // dst_x0_st = clip_x: output[i] = src[x+i] เสมอ — clip_x ชดเชยเฉพาะเคส x<0
        //   x=80, src_w=100, w=50 → clip_x=0, output[0..19] = src[80..99], output[20..49] transparent
        //   x=-30, src_w=100, w=50 → clip_x=30, output[30..49] = src[0..19], output[0..29] transparent
        const size_t dst_x0_st = static_cast<size_t>(clip_x);
        const size_t copy_w_bytes = copy_w * 4u;
        for (size_t j = 0; j < copy_h; j++) {
            const size_t sy = static_cast<size_t>(y + clip_y) + j;
            const size_t dy = static_cast<size_t>(clip_y) + j;
            const uint8_t* src_row = src + (sy * src_w_st + src_x0_st) * 4u;
            uint8_t* dst_row = dst + (dy * dst_w_st + dst_x0_st) * 4u;
            std::memcpy(dst_row, src_row, copy_w_bytes);
        }
    }
    val out = val::object();
    out.set("ptr", reinterpret_cast<uintptr_t>(dst));
    out.set("byte_len", static_cast<double>(bytes));
    out.set("kind", std::string("malloc"));
    return out;
}

val view_bytes(uintptr_t ptr, size_t byte_len) {
    if (ptr == 0 || byte_len == 0 || byte_len > MAX_BYTES) return val::null();
    return val(typed_memory_view(byte_len, reinterpret_cast<uint8_t*>(ptr)));
}

void free_stbi(uintptr_t ptr) {
    if (ptr) stbi_image_free(reinterpret_cast<void*>(ptr));
}

void free_malloc(uintptr_t ptr) {
    if (ptr) std::free(reinterpret_cast<void*>(ptr));
}

EMSCRIPTEN_BINDINGS(image_tiles_module) {
    function("decode_png", &decode_png);
    function("crop_rgba", &crop_rgba);
    function("view_bytes", &view_bytes);
    function("free_stbi", &free_stbi);
    function("free_malloc", &free_malloc);
}
