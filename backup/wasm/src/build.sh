#!/bin/bash
# Build image_tiles.wasm — เรียกผ่าน:
#   source /Users/jedsadha/Documents/www/docling/emsdk/emsdk_env.sh && ./build.sh
# Pattern อิงจาก reference/Ketchup/core/wasm/build.sh

set -e
cd "$(dirname "$0")"

OUT_DIR=../build
mkdir -p "$OUT_DIR"

EMCC="${EMCC:-/Users/jedsadha/Documents/www/docling/emsdk/upstream/emscripten/em++}"

"$EMCC" image_tiles.cpp \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createImageTilesModule" \
  -s EXPORT_ES6=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16MB \
  -s MAXIMUM_MEMORY=2GB \
  -s ENVIRONMENT='web' \
  -s SINGLE_FILE=0 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
  --bind \
  -o "$OUT_DIR/image_tiles.js"

echo "✓ Built: $OUT_DIR/image_tiles.js + image_tiles.wasm"
ls -lh "$OUT_DIR"/image_tiles.*
