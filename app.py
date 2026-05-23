"""Flask routes — thin orchestration over pipelines / correct / translate"""
import gc
import json
import tempfile
from pathlib import Path

import psutil
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

from config import (
    APPLE_SHORTCUT_EN,
    APPLE_SHORTCUT_JA,
    APPLE_SHORTCUT_TH,
    APPLE_SHORTCUT_VI,
    ELEMENT_KEYS,
    GEMINI_AVAILABLE,
    GEMINI_BATCH_DELAY_MS,
    GEMINI_MODEL,
    MIN_FREE_RAM_GB,
    OCR_ENGINES,
    OLLAMA_MODEL_TRANSLATE,
    OLLAMA_URL,
    SPEAKER_SKIP,
    TRANSLATE_BATCH_NUM_CTX,
    TRANSLATE_BATCH_SIZE_DEFAULT,
)
from correct import (
    apply_correction_to_doc,
    correct_batch,
    correct_text_with_llm,
)
from pipelines import (
    OCRMAC_AVAILABLE,
    build_preview,
    filter_document,
    filter_pages,
    flatten_xlsx_cells_to_texts,
    get_converter,
    parse_page_spec,
    run_fast_pipeline,
    run_manga_pipeline,
)
from translate import (
    _GEMINI_RESPONSE_SCHEMA,
    _build_batch_system_prompt,
    _build_batch_user_msg,
    _translate_temp_for_attempt,
    apple_translate_text,
    apply_manual_batch,
    nllb_translate_text,
    translate_batch,
    translate_text,
)
import tm


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True


def _ram_guard(min_gb: float | None = None) -> tuple[bool, float]:
    """Return (ok, available_gb).
    - Cold (ยังไม่เคยโหลด converter): ต้องการ ~MIN_FREE_RAM_GB (3 GB) — model loading peak
    - Warm (มี converter cache แล้ว): ต้องการ ~1 GB — เฉพาะ image OCR working set
      เหตุผล: Python ไม่คืน RAM ของ model ให้ OS หลัง 1st call แม้ gc.collect()
      → psutil.available ไม่ขยับ → batch ไฟล์ที่ 2+ ติด guard แม้ตัว OCR เองใช้ RAM น้อย
    """
    if min_gb is None:
        from pipelines import _converter_cache
        min_gb = 1.0 if _converter_cache else MIN_FREE_RAM_GB
    avail_gb = psutil.virtual_memory().available / (1024 ** 3)
    return (avail_gb >= min_gb, round(avail_gb, 2))


def _free_memory():
    """บังคับ gc + เคลียร์ tensor cache ของ PyTorch — เรียกหลัง OCR เพื่อกัน RAM ค้าง
    ระหว่าง batch (EasyOCR/PyTorch ไม่ปล่อย MPS/CUDA buffers เอง)"""
    gc.collect()
    try:
        import torch
        # MPS (Apple Silicon) มี empty_cache แล้วตั้งแต่ PyTorch 2.0
        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            try:
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
            except Exception:
                pass
        if hasattr(torch, "cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


print("[docling] pre-warming converter (kind=all, lang=auto, engine=easyocr)...", flush=True)
get_converter("all", "auto", "easyocr")
print(f"[docling] ready — ocrmac available: {OCRMAC_AVAILABLE}", flush=True)


@app.after_request
def _release_ram_after_ocr(response):
    """หลัง /convert จบ → บังคับคืน RAM กัน batch OCR ติด RAM guard ที่ไฟล์ถัดไป"""
    if request.endpoint == "convert":
        _free_memory()
    return response


@app.route("/")
def index():
    resp = app.make_response(render_template(
        "index.html",
        types=["all"] + ELEMENT_KEYS,
        ocrmac_available=OCRMAC_AVAILABLE,
        translate_batch_size_default=TRANSLATE_BATCH_SIZE_DEFAULT,
        gemini_available=GEMINI_AVAILABLE,
        gemini_model=GEMINI_MODEL if GEMINI_AVAILABLE else "",
        gemini_batch_delay_ms=GEMINI_BATCH_DELAY_MS,
    ))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


@app.route("/correct-batch", methods=["POST"])
def correct_batch_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        texts = payload.get("texts") or []
        engine = payload.get("engine", "qwen")
        custom_rules = payload.get("custom_rules")
        attempt = int(payload.get("attempt", 0) or 0)

        if not isinstance(texts, list) or not texts:
            return jsonify({"error": "texts must be a non-empty list"}), 400
        if engine not in ("qwen", "gemini"):
            engine = "qwen"
        if engine == "gemini" and not GEMINI_AVAILABLE:
            return jsonify({"error": "GEMINI_API_KEY is not set in .env"}), 400

        corrections, errors = correct_batch(texts, engine=engine,
                                            custom_rules=custom_rules,
                                            attempt=attempt)
        return jsonify({
            "corrected": corrections,
            "errors": errors,
            "engine": engine,
            "batch_size": len(texts),
            "attempt": attempt,
        })
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"server exception: {exc}"}), 500


@app.route("/correct", methods=["POST"])
def correct_endpoint():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text", "")
    before = payload.get("context_before") or payload.get("context") or []
    after = payload.get("context_after") or []
    engine = payload.get("engine", "qwen")
    custom_rules = payload.get("custom_rules")
    if not isinstance(before, list):
        before = [str(before)] if before else []
    if not isinstance(after, list):
        after = [str(after)] if after else []
    if engine == "gemini" and not GEMINI_AVAILABLE:
        return jsonify({"corrected": text, "error": "GEMINI_API_KEY is not set in .env"}), 200
    corrected, err = correct_text_with_llm(
        text,
        context_before=[str(s) for s in before],
        context_after=[str(s) for s in after],
        engine=engine,
        custom_rules=custom_rules,
    )
    if err:
        return jsonify({"corrected": text, "error": err}), 200
    return jsonify({"corrected": corrected, "original": text})


@app.route("/apple-translate-setup")
def apple_translate_setup():
    return render_template(
        "apple_setup.html",
        sh_th=APPLE_SHORTCUT_TH,
        sh_en=APPLE_SHORTCUT_EN,
        sh_ja=APPLE_SHORTCUT_JA,
        sh_vi=APPLE_SHORTCUT_VI,
    )


@app.route("/translate", methods=["POST"])
def translate_endpoint():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text", "")
    target = payload.get("target", "th")
    engine = payload.get("engine", "qwen")  # qwen | apple | nllb

    if engine == "apple":
        translated, err = apple_translate_text(text, target)
    elif engine == "nllb":
        translated, err = nllb_translate_text(text, target)
    else:
        translated, err = translate_text(text, target)
    if err:
        return jsonify({"translated": text, "error": err}), 200
    return jsonify({"translated": translated, "target": target, "engine": engine})


@app.route("/translate-batch/preview", methods=["POST"])
def translate_batch_preview():
    """ดู prompt + payload ที่จะส่งไป LLM โดยไม่เรียก LLM จริง"""
    payload = request.get_json(silent=True) or {}
    texts = payload.get("texts") or []
    target = payload.get("target", "th")
    engine = payload.get("engine", "qwen")
    custom_rules = payload.get("custom_rules")
    speakers = payload.get("speakers") if isinstance(payload.get("speakers"), list) else None
    characters = payload.get("characters") if isinstance(payload.get("characters"), list) else None
    id_start = int(payload.get("id_start", 1) or 1)
    payload_ids = payload.get("ids") if isinstance(payload.get("ids"), list) else None

    if not isinstance(texts, list) or not texts:
        return jsonify({"error": "texts must be a non-empty list"}), 400

    n = len(texts)
    sp_list = list(speakers) if isinstance(speakers, list) else [None] * n
    if len(sp_list) < n:
        sp_list += [None] * (n - len(sp_list))
    if payload_ids and len(payload_ids) == n:
        ids = [int(x) for x in payload_ids]
    else:
        ids = [id_start + i for i in range(n)]

    skipped_user = 0
    skipped_empty = 0
    skipped_indexes: list[int] = []
    for i, t in enumerate(texts):
        sp = sp_list[i]
        if sp == SPEAKER_SKIP:
            skipped_user += 1
            skipped_indexes.append(i)
        elif not (t and t.strip()):
            skipped_empty += 1
            skipped_indexes.append(i)

    has_real_speaker = any(s for s in sp_list if s and s != SPEAKER_SKIP)
    has_skip = any(s == SPEAKER_SKIP for s in sp_list)
    # pass speakers ถ้ามี real speaker หรือ skip — เพื่อให้ _build_batch_user_msg ตัด content ของ SKIP
    eff_speakers = sp_list if (has_real_speaker or has_skip) else None
    if has_real_speaker and characters:
        used_ids = {s for s in sp_list if s and s != SPEAKER_SKIP}
        eff_chars = [c for c in characters if c.get("id") in used_ids]
    else:
        eff_chars = None

    user_msg, _ = _build_batch_user_msg(texts, eff_speakers, id_start=id_start, ids=ids)
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, eff_chars,
                                               id_start=id_start, ids=ids, texts=texts)

    speakers_used = sorted(set(s for s in sp_list if s and s != SPEAKER_SKIP))
    attempt = int(payload.get("attempt", 0) or 0)

    if engine == "gemini":
        request_body = {
            "model": GEMINI_MODEL,
            "contents": [user_msg],
            "config": {
                "system_instruction": system_prompt,
                "response_mime_type": "application/json",
                "response_schema": _GEMINI_RESPONSE_SCHEMA,
                "temperature": _translate_temp_for_attempt(attempt),
            },
        }
        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    else:
        request_body = {
            "model": OLLAMA_MODEL_TRANSLATE,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            "options": {
                "temperature": _translate_temp_for_attempt(attempt),
                "num_ctx": TRANSLATE_BATCH_NUM_CTX,
            },
        }
        endpoint = f"{OLLAMA_URL}/api/chat"

    return jsonify({
        "engine": engine,
        "target": target,
        "n_total": n,
        "n_sent": n,
        "skipped_empty": skipped_empty,
        "skipped_user": skipped_user,
        "skipped_indexes": skipped_indexes,
        "speakers_used": speakers_used,
        "characters_used": eff_chars or [],
        "system_prompt": system_prompt,
        "user_message": user_msg,
        "request_endpoint": endpoint,
        "request_body": request_body,
    })


@app.route("/translate-batch/apply-manual", methods=["POST"])
def translate_batch_apply_manual():
    """รับ raw response ที่ user paste จาก LLM web UI — parse + post-process ผ่าน guard เดียวกับ batch ปกติ"""
    try:
        payload = request.get_json(silent=True) or {}
        texts = payload.get("texts") or []
        target = payload.get("target", "th")
        raw_response = payload.get("raw_response", "")
        speakers = payload.get("speakers") if isinstance(payload.get("speakers"), list) else None
        characters = payload.get("characters") if isinstance(payload.get("characters"), list) else None
        id_start = int(payload.get("id_start", 1) or 1)
        ids_payload = payload.get("ids") if isinstance(payload.get("ids"), list) else None

        if not isinstance(texts, list) or not texts:
            return jsonify({"error": "texts must be a non-empty list"}), 400
        if not raw_response or not str(raw_response).strip():
            return jsonify({"error": "raw_response is empty"}), 400

        ids_arg = [int(x) for x in ids_payload] if ids_payload else None
        translations, errors = apply_manual_batch(
            texts, target, raw_response,
            speakers=speakers, characters=characters,
            id_start=id_start, ids=ids_arg,
        )
        return jsonify({
            "translated": translations,
            "errors": errors,
            "target": target,
            "batch_size": len(texts),
        })
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"server exception: {exc}"}), 500


@app.route("/translate-batch", methods=["POST"])
def translate_batch_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        texts = payload.get("texts") or []
        target = payload.get("target", "th")
        engine = payload.get("engine", "qwen")
        custom_rules = payload.get("custom_rules")
        attempt = int(payload.get("attempt", 0) or 0)
        id_start = int(payload.get("id_start", 1) or 1)
        ids_payload = payload.get("ids") if isinstance(payload.get("ids"), list) else None
        speakers = payload.get("speakers") if isinstance(payload.get("speakers"), list) else None
        characters = payload.get("characters") if isinstance(payload.get("characters"), list) else None

        if not isinstance(texts, list) or not texts:
            return jsonify({"error": "texts must be a non-empty list"}), 400
        if engine not in ("qwen", "gemini"):
            return jsonify({"error": f"batch is not supported for engine={engine}"}), 400
        if engine == "gemini" and not GEMINI_AVAILABLE:
            return jsonify({"error": "GEMINI_API_KEY is not set in .env"}), 400

        ids_arg = [int(x) for x in ids_payload] if ids_payload else None
        translations, errors = translate_batch(
            texts, target=target, engine=engine,
            custom_rules=custom_rules, attempt=attempt,
            speakers=speakers, characters=characters,
            id_start=id_start, ids=ids_arg,
        )
        return jsonify({
            "translated": translations,
            "errors": errors,
            "target": target,
            "engine": engine,
            "batch_size": len(texts),
            "attempt": attempt,
        })
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"server exception: {exc}"}), 500


@app.route("/tm/build", methods=["POST"])
def tm_build():
    try:
        manifests = tm.build_all_indexes()
        return jsonify({"ok": True, "manifests": manifests})
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"tm.build: {exc}"}), 500


@app.route("/tm/suggest", methods=["POST"])
def tm_suggest():
    payload = request.get_json(silent=True) or {}
    texts = payload.get("texts") or []
    pair = (payload.get("pair") or "en-vn").strip()
    top_k_per_query = int(payload.get("top_k_per_query") or 0) or None
    final_k = int(payload.get("final_k") or 0) or None
    auto_build = bool(payload.get("auto_build", True))
    if not isinstance(texts, list) or not texts:
        return jsonify({"error": "texts must be a non-empty list"}), 400
    kwargs = {"pair": pair, "auto_build": auto_build}
    if top_k_per_query:
        kwargs["top_k_per_query"] = top_k_per_query
    if final_k:
        kwargs["final_k"] = final_k
    try:
        return jsonify(tm.suggest([str(t) for t in texts], **kwargs))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"tm.suggest: {exc}"}), 500


@app.route("/convert", methods=["POST"])
def convert():
    from pipelines import _converter_cache as _cc
    required = 1.0 if _cc else MIN_FREE_RAM_GB
    ok, avail = _ram_guard()
    if not ok:
        return jsonify({
            "error": f"Not enough free RAM to start OCR — {avail} GB available, "
                     f"need ≥{required} GB. Close other apps/tabs and retry.",
            "available_gb": avail,
            "required_gb": required,
        }), 503
    if "file" not in request.files:
        return jsonify({"error": "no uploaded file found"}), 400

    uploaded = request.files["file"]
    if not uploaded.filename:
        return jsonify({"error": "Please choose a file"}), 400

    kind = request.form.get("type", "all")
    lang = request.form.get("lang", "auto")
    fast = request.form.get("fast", "0") in ("1", "true", "on", "yes")
    correct = request.form.get("correct", "0") in ("1", "true", "on", "yes")
    ocr_engine = request.form.get("ocr_engine", "easyocr")
    pages_spec = (request.form.get("pages") or "").strip()
    try:
        selected_pages = parse_page_spec(pages_spec)
    except ValueError as exc:
        return jsonify({"error": f"invalid pages: {exc}"}), 400
    if ocr_engine not in OCR_ENGINES:
        ocr_engine = "easyocr"
    engine_fallback = None
    if ocr_engine == "ocrmac" and not OCRMAC_AVAILABLE:
        engine_fallback = "ocrmac → easyocr (ocrmac is macOS-only)"
        ocr_engine = "easyocr"
    if fast and not OCRMAC_AVAILABLE:
        fast = False
        engine_fallback = (engine_fallback + "; " if engine_fallback else "") + \
            "fast mode disabled automatically (requires ocrmac)"

    page_range = (min(selected_pages), max(selected_pages)) if selected_pages else None
    pages_warning = None
    if selected_pages and (fast or lang == "manga"):
        pages_warning = "page selection ignored (fast/manga modes are single-page)"
        selected_pages = None
        page_range = None

    filename = secure_filename(uploaded.filename)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / filename
        uploaded.save(path)

        def _run_docling(scale: float):
            converter = get_converter(kind, lang, ocr_engine, images_scale=scale)
            if page_range:
                result = converter.convert(str(path), page_range=page_range)
            else:
                result = converter.convert(str(path))
            doc = result.document
            d = doc.export_to_dict()
            pv = build_preview(doc)
            if path.suffix.lower() in (".xlsx", ".xls"):
                flatten_xlsx_cells_to_texts(d, pv)
            return d, pv

        try:
            if fast:
                doc_dict, preview = run_fast_pipeline(path, filename, lang)
            elif lang == "manga":
                doc_dict, preview = run_manga_pipeline(path, filename)
            else:
                # Retry ladder: 2.0 → 1.5 → 1.0 → 0.75 → 0.5 (เริ่ม 144 DPI, ย่อลงเมื่อ OOM)
                # หมายเหตุ: ถ้า process ถูก Windows kill จาก native bad_alloc จะ catch ไม่ได้
                # ต้องการ subprocess isolation ถ้ายังพังอีก
                last_exc = None
                for scale in (2.0, 1.5, 1.0, 0.75, 0.5):
                    try:
                        doc_dict, preview = _run_docling(scale)
                        last_exc = None
                        break
                    except (MemoryError, RuntimeError) as exc:
                        msg = str(exc).lower()
                        if "bad_alloc" in msg or "memory" in msg or "alloc" in msg:
                            print(f"[docling] OOM at scale={scale}, retrying lower", flush=True)
                            last_exc = exc
                            continue
                        raise
                if last_exc is not None:
                    raise last_exc
        except Exception as exc:
            return jsonify({"error": f"conversion failed: {exc}"}), 500

    if selected_pages:
        filter_pages(doc_dict, preview, selected_pages)

    correction_info = None
    if correct:
        n, errs = apply_correction_to_doc(doc_dict, preview)
        correction_info = {"corrected": n, "errors": errs}

    filtered = doc_dict if (fast or lang == "manga") else filter_document(doc_dict, kind)
    resp = {
        "json_text": json.dumps(filtered, ensure_ascii=False, indent=2),
        "preview": preview,
        "texts": doc_dict.get("texts", []),
        "correction": correction_info,
        "ocr_engine": ocr_engine,
        "engine_fallback": engine_fallback,
    }
    if pages_warning:
        resp["pages_warning"] = pages_warning
    return jsonify(resp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)
