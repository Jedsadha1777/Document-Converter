import { state } from "../state.js";
import { history } from "../history.js";
import { SetSpeakerCmd, SetEmotionCmd } from "../commands.js";
import { renderSpeakerOptions, getCharacters, SPEAKER_SKIP, SPEAKER_AUTO } from "../characters.js";
import { renderEmotionOptions, EMOTION_AUTO } from "../emotions.js";
import { getImageSrc } from "./image-source.js";

const _PAIR_TO_TARGET = { "jp-th": "th", "en-th": "th", "en-vn": "vi" };
function _currentEmotionTarget() {
    const pair = document.getElementById("tmPair")?.value || "";
    return _PAIR_TO_TARGET[pair] || "_default";
}

let _suppress = false;   // กัน feedback loop ตอน user พิมพ์ใน textarea
let _lastInspectorRef = null;   // detect ref change → force update textarea ถึง focus จะค้าง

const $ = (id) => document.getElementById(id);

function _dispatchClick(id) {
    $(id)?.click();
}

export function initInspector() {
    $("rpFontDecBtn")?.addEventListener("click", () => _dispatchClick("fontDecBtn"));
    $("rpFontIncBtn")?.addEventListener("click", () => _dispatchClick("fontIncBtn"));
    $("rpAlignLeftBtn")?.addEventListener("click", () => _dispatchClick("alignLeftBtn"));
    $("rpAlignCenterBtn")?.addEventListener("click", () => _dispatchClick("alignCenterBtn"));
    $("rpAlignRightBtn")?.addEventListener("click", () => _dispatchClick("alignRightBtn"));
    $("rpValignTopBtn")?.addEventListener("click", () => _dispatchClick("valignTopBtn"));
    $("rpValignMiddleBtn")?.addEventListener("click", () => _dispatchClick("valignMiddleBtn"));
    $("rpValignBottomBtn")?.addEventListener("click", () => _dispatchClick("valignBottomBtn"));

    $("rpReOcrBtn")?.addEventListener("click", _reOcrSelected);

    const spkEl = $("rpSpeakerSelect");
    spkEl?.addEventListener("change", () => {
        const ref = state.selection.ref;
        if (!ref) return;
        const before = state.speakerByRef[ref];
        const after = spkEl.value;
        if (before === after) return;
        history.exec(new SetSpeakerCmd(ref, before, after));
    });
    spkEl?.addEventListener("mouseenter", () => _showSpkTooltip(spkEl));
    spkEl?.addEventListener("mouseleave", _hideSpkTooltip);
    spkEl?.addEventListener("mousedown", _hideSpkTooltip);
    spkEl?.addEventListener("change", _hideSpkTooltip);

    const _wireEmotion = (selId, slot, mapKey) => {
        const el = $(selId);
        el?.addEventListener("change", () => {
            const ref = state.selection.ref;
            if (!ref) return;
            const before = state[mapKey][ref];
            history.exec(new SetEmotionCmd(ref, before, el.value, slot));
        });
    };
    _wireEmotion("rpEmotionSelect1", 1, "emotionByRef");
    _wireEmotion("rpEmotionSelect2", 2, "emotion2ByRef");

    const ocrEl = $("rpOcrText");
    ocrEl?.addEventListener("input", () => {
        const ref = state.selection.ref;
        if (!ref) return;
        const item = (state.lastResult?.preview?.items || []).find(it => it.self_ref === ref);
        const origText = (item?.text || "").trim();
        const v = ocrEl.value;
        if (!v.trim()) {
            // empty = user deleted intentionally → "" hides bbox; equal-to-original = drop correction (กลับไปใช้ OCR)
            state.corrections[ref] = "";
            state.manualEdits.add(ref);
        } else if (v.trim() === origText) {
            delete state.corrections[ref];
            state.manualEdits.delete(ref);
        } else {
            state.corrections[ref] = v;
            state.manualEdits.add(ref);
        }
        _suppress = true;
        window._previewWrap?._redraw?.();
        window.buildCompareTable?.(true);
        _suppress = false;
    });

    const trEl = $("rpTrText");
    trEl?.addEventListener("input", () => {
        const ref = state.selection.ref;
        if (!ref) return;
        const v = trEl.value;
        if (!v.trim()) {
            delete state.translations[ref];
            state.manualTranslations.delete(ref);
        } else {
            state.translations[ref] = v;
            state.manualTranslations.add(ref);
        }
        _suppress = true;
        window._previewWrap?._redraw?.();
        window.buildCompareTable?.(true);
        _suppress = false;
        _updateTrSourceHint(ref);
    });
}

function _resolveBboxImgCoords(item) {
    const b = item.bbox || {};
    const isBL = (b.coord_origin || "").toUpperCase() === "BOTTOMLEFT";
    let x = b.l, y, w = b.r - b.l, h;
    if (isBL) {
        const page = (state.lastResult?.preview?.pages || []).find(p => p.page_no === item.page_no);
        const pageH = page?.img_height || page?.height || 0;
        y = pageH - b.t;
        h = b.t - b.b;
    } else {
        y = b.t;
        h = b.b - b.t;
    }
    const ov = state.bboxOverrides[item.self_ref] || {};
    if (typeof ov.x === "number") x = ov.x;
    if (typeof ov.y === "number") y = ov.y;
    if (typeof ov.w === "number") w = ov.w;
    if (typeof ov.h === "number") h = ov.h;
    const rotation = (typeof ov.rotation === "number") ? ov.rotation : 0;
    return { x, y, w, h, rotation };
}

async function _cropBboxToPngBlob(item) {
    const { x, y, w, h, rotation } = _resolveBboxImgCoords(item);
    if (w <= 0 || h <= 0) throw new Error("bbox มีขนาด ≤ 0 ไม่ valid");
    const page = (state.lastResult?.preview?.pages || []).find(p => p.page_no === item.page_no);
    if (!page) throw new Error(`page ${item.page_no} หาไม่เจอ`);
    const src = getImageSrc(page);
    if (!src) throw new Error("source image ไม่พบ (page ไม่มี imageData/blob)");

    const img = await new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("โหลด source image ไม่สำเร็จ"));
        im.src = src;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    const ctx = canvas.getContext("2d");
    // de-rotate: bbox center → origin, rotate -θ, origin → canvas center
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-rotation * Math.PI / 180);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    ctx.drawImage(img, 0, 0);
    return await new Promise(res => canvas.toBlob(res, "image/png"));
}

async function _reOcrSelected() {
    const ref = state.selection.ref;
    const statusEl = $("rpReOcrStatus");
    const btn = $("rpReOcrBtn");
    if (!ref || !state.lastResult) {
        if (statusEl) statusEl.textContent = "เลือก textbox ก่อน";
        return;
    }
    const item = (state.lastResult.preview?.items || []).find(it => it.self_ref === ref);
    if (!item) {
        if (statusEl) statusEl.textContent = "หา item ใน lastResult ไม่เจอ";
        return;
    }
    const lang = document.getElementById("lang")?.value || "auto";
    const engine = document.getElementById("ocr_engine")?.value || "easyocr";

    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = "cropping…";
    try {
        const blob = await _cropBboxToPngBlob(item);
        if (statusEl) statusEl.textContent = "OCR…";
        const form = new FormData();
        form.append("image", blob, "bbox.png");
        form.append("lang", lang);
        form.append("engine", engine);
        const res = await fetch("/ocr-bbox", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const text = (data.text || "").trim();
        if (text) {
            state.corrections[ref] = text;
        } else {
            delete state.corrections[ref];
        }
        const ocrEl = $("rpOcrText");
        if (ocrEl) ocrEl.value = text || (item.text || "");
        window.buildCompareTable?.(true);
        window._previewWrap?._redraw?.();
        if (statusEl) statusEl.textContent = `✓ ${data.engine_used || "ok"} — ${text.length} chars`;
    } catch (e) {
        if (statusEl) statusEl.textContent = "error: " + e.message;
    } finally {
        if (btn) btn.disabled = false;
    }
}

function _updateTrSourceHint(ref) {
    const el = $("rpTrSource");
    if (!el) return;
    const tr = state.translations[ref];
    if (!tr) { el.textContent = ""; return; }
    el.textContent = state.manualTranslations.has(ref) ? "(manual)" : "(LLM)";
}

let _spkTooltip = null;
const _escTip = (s) => String(s ?? "").replace(/[<>&]/g, ch => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[ch]));

function _ensureSpkTooltip() {
    if (_spkTooltip) return _spkTooltip;
    _spkTooltip = document.createElement("div");
    _spkTooltip.id = "rpSpeakerTooltip";
    _spkTooltip.style.cssText = [
        "position:fixed",
        "background:#fff",
        "border:1px solid #d1d5db",
        "border-radius:6px",
        "padding:10px 12px",
        "font-size:12px",
        "line-height:1.5",
        "color:#1f2937",
        "box-shadow:0 4px 12px rgba(0,0,0,0.12)",
        "max-width:280px",
        "z-index:9999",
        "display:none",
        "pointer-events:none",
    ].join(";");
    document.body.appendChild(_spkTooltip);
    return _spkTooltip;
}

function _showSpkTooltip(selEl) {
    if (!selEl) return;
    const charId = selEl.value;
    if (!charId || charId === SPEAKER_SKIP) {
        _hideSpkTooltip();
        return;
    }
    const c = getCharacters().find(c => c.id === charId);
    if (!c) {
        _hideSpkTooltip();
        return;
    }
    const tip = _ensureSpkTooltip();
    tip.innerHTML = `
        <div style="font-weight:600; margin-bottom:6px; color:#111827;">
            <span style="color:#6b7280; font-weight:400; margin-right:4px;">#${_escTip(c.id)}</span>${_escTip(c.name || "(unnamed)")}
        </div>
        <div style="color:#6b7280; margin-bottom:6px;">
            <span style="display:inline-block; min-width:40px;">sex:</span> ${_escTip(c.gender || "—")}<br>
            <span style="display:inline-block; min-width:40px;">age:</span> ${_escTip(c.age || "—")}
        </div>
        <div style="color:#374151; white-space:pre-wrap; border-top:1px solid #f3f4f6; padding-top:6px;">${_escTip(c.persona || "(no personality set)")}</div>
    `;
    const r = selEl.getBoundingClientRect();
    tip.style.display = "block";
    const tr = tip.getBoundingClientRect();
    let left = r.left - tr.width - 8;
    if (left < 8) {
        // ไม่พอที่ทางซ้าย → fallback ไปวางใต้ select
        left = Math.max(8, r.left);
        tip.style.left = left + "px";
        tip.style.top = (r.bottom + 6) + "px";
    } else {
        tip.style.left = left + "px";
        tip.style.top = r.top + "px";
    }
    requestAnimationFrame(() => {
        const tr2 = tip.getBoundingClientRect();
        if (tr2.bottom > window.innerHeight - 8) {
            tip.style.top = Math.max(8, window.innerHeight - tr2.height - 8) + "px";
        }
    });
}

function _hideSpkTooltip() {
    if (_spkTooltip) _spkTooltip.style.display = "none";
}

export function updateInspector() {
    if (_suppress) return;
    const empty = $("rightPanelEmpty");
    const content = $("rightPanelContent");
    if (!empty || !content) return;
    const ref = state.selection.ref;
    if (!ref || !state.lastResult) {
        empty.style.display = "";
        content.style.display = "none";
        return;
    }
    const item = (state.lastResult.preview?.items || []).find(it => it.self_ref === ref);
    if (!item) {
        empty.style.display = "";
        content.style.display = "none";
        return;
    }
    empty.style.display = "none";
    content.style.display = "";

    // ห้าม overwrite ขณะ user พิมพ์ — ยกเว้น ref เปลี่ยน (คลิก bbox อื่น)
    const refChanged = ref !== _lastInspectorRef;
    const ocrEl = $("rpOcrText");
    if (ocrEl && (refChanged || document.activeElement !== ocrEl)) {
        ocrEl.value = state.corrections[ref] ?? item.text ?? "";
    }

    const spkEl = $("rpSpeakerSelect");
    if (spkEl) {
        const cur = state.speakerByRef[ref] || SPEAKER_AUTO;
        spkEl.innerHTML = renderSpeakerOptions()(cur);
    }

    const e1El = $("rpEmotionSelect1");
    const e2El = $("rpEmotionSelect2");
    if (e1El || e2El) {
        const tgt = _currentEmotionTarget();
        if (e1El) {
            const cur1 = state.emotionByRef[ref] || EMOTION_AUTO;
            e1El.innerHTML = renderEmotionOptions(tgt, false)(cur1);
        }
        if (e2El) {
            const cur2 = state.emotion2ByRef[ref] ?? "";
            e2El.innerHTML = renderEmotionOptions(tgt, true)(cur2);
        }
    }

    const trEl = $("rpTrText");
    if (refChanged || document.activeElement !== trEl) {
        trEl.value = state.translations[ref] || "";
    }
    _updateTrSourceHint(ref);
    _lastInspectorRef = ref;

    const ov = state.bboxOverrides[ref] || {};
    const hMap = { left: "rpAlignLeftBtn", center: "rpAlignCenterBtn", right: "rpAlignRightBtn" };
    const vMap = { top: "rpValignTopBtn", middle: "rpValignMiddleBtn", bottom: "rpValignBottomBtn" };
    Object.values(hMap).forEach(id => $(id)?.classList.remove("active"));
    Object.values(vMap).forEach(id => $(id)?.classList.remove("active"));
    if (hMap[ov.align]) $(hMap[ov.align])?.classList.add("active");
    if (vMap[ov.valign]) $(vMap[ov.valign])?.classList.add("active");
}
