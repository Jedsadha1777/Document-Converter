"""Flask routes — thin orchestration over pipelines / correct / translate"""
import json
import tempfile
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

from config import (
    APPLE_SHORTCUT_EN,
    APPLE_SHORTCUT_JA,
    APPLE_SHORTCUT_TH,
    ELEMENT_KEYS,
    GEMINI_AVAILABLE,
    GEMINI_BATCH_DELAY_MS,
    GEMINI_MODEL,
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
    get_converter,
    run_fast_pipeline,
    run_manga_pipeline,
)
from translate import (
    _GEMINI_RESPONSE_SCHEMA,
    _build_batch_system_prompt,
    _build_batch_user_msg,
    _list_shortcuts,
    _shortcuts_available,
    _translate_temp_for_attempt,
    apple_translate_text,
    apply_manual_batch,
    translate_batch,
    translate_text,
)


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True


print("[docling] pre-warming converter (kind=all, lang=auto, engine=easyocr)...", flush=True)
get_converter("all", "auto", "easyocr")
print(f"[docling] ready — ocrmac available: {OCRMAC_AVAILABLE}", flush=True)


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


@app.route("/apple-translate-status", methods=["GET"])
def apple_translate_status():
    if not _shortcuts_available():
        return jsonify({"available": False, "reason": "shortcuts CLI not found"})
    sc = _list_shortcuts()
    return jsonify({
        "available": True,
        "shortcuts": {
            "th": APPLE_SHORTCUT_TH in sc,
            "en": APPLE_SHORTCUT_EN in sc,
            "ja": APPLE_SHORTCUT_JA in sc,
        },
        "required": {"th": APPLE_SHORTCUT_TH, "en": APPLE_SHORTCUT_EN, "ja": APPLE_SHORTCUT_JA},
    })


@app.route("/apple-translate-setup")
def apple_translate_setup():
    return render_template(
        "apple_setup.html",
        sh_th=APPLE_SHORTCUT_TH,
        sh_en=APPLE_SHORTCUT_EN,
        sh_ja=APPLE_SHORTCUT_JA,
    )


@app.route("/translate", methods=["POST"])
def translate_endpoint():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text", "")
    target = payload.get("target", "th")
    engine = payload.get("engine", "qwen")  # qwen | apple

    if engine == "apple":
        translated, err = apple_translate_text(text, target)
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
    system_prompt = _build_batch_system_prompt(target, n, custom_rules, eff_chars, id_start=id_start, ids=ids)

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


@app.route("/convert", methods=["POST"])
def convert():
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

    filename = secure_filename(uploaded.filename)
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / filename
        uploaded.save(path)

        try:
            if fast:
                doc_dict, preview = run_fast_pipeline(path, filename, lang)
            elif lang == "manga":
                doc_dict, preview = run_manga_pipeline(path, filename)
            else:
                result = get_converter(kind, lang, ocr_engine).convert(str(path))
                doc = result.document
                doc_dict = doc.export_to_dict()
                preview = build_preview(doc)
        except Exception as exc:
            return jsonify({"error": f"conversion failed: {exc}"}), 500

    correction_info = None
    if correct:
        n, errs = apply_correction_to_doc(doc_dict, preview)
        correction_info = {"corrected": n, "errors": errs}

    filtered = doc_dict if (fast or lang == "manga") else filter_document(doc_dict, kind)
    return jsonify({
        "json_text": json.dumps(filtered, ensure_ascii=False, indent=2),
        "preview": preview,
        "texts": doc_dict.get("texts", []),
        "correction": correction_info,
        "ocr_engine": ocr_engine,
        "engine_fallback": engine_fallback,
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)
