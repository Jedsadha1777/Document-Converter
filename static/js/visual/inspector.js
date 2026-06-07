import { state } from "../state.js";
import { history } from "../history.js";
import { SetSpeakerCmd, SetEmotionCmd, UpdateMarkupCmd, UpdateBboxCmd, CompositeCommand } from "../commands.js";
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

const _cloneOv = (v) => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

function _dispatchClick(id) {
    $(id)?.click();
}

function _patchBboxOverrideForSelection(patch, desc) {
    const refs = [...state.selection.refs];
    if (!refs.length) return;
    const cmds = refs.map(ref => {
        const before = _cloneOv(state.bboxOverrides[ref]);
        const after = { ...(before || {}), ...patch };
        for (const k of Object.keys(after)) if (after[k] === undefined) delete after[k];
        return new UpdateBboxCmd(ref, before, after, desc);
    });
    if (!cmds.length) return;
    const cmd = cmds.length === 1 ? cmds[0] : new CompositeCommand(cmds, `${desc} (×${cmds.length})`);
    history.exec(cmd);
}

export function initInspector() {
    _wireFontSizeInput();
    _wireLineHeightInput();
    _wireColorInputs();
    $("rpAlignLeftBtn")?.addEventListener("click", () => _dispatchClick("alignLeftBtn"));
    $("rpAlignCenterBtn")?.addEventListener("click", () => _dispatchClick("alignCenterBtn"));
    $("rpAlignRightBtn")?.addEventListener("click", () => _dispatchClick("alignRightBtn"));
    $("rpValignTopBtn")?.addEventListener("click", () => _dispatchClick("valignTopBtn"));
    $("rpValignMiddleBtn")?.addEventListener("click", () => _dispatchClick("valignMiddleBtn"));
    $("rpValignBottomBtn")?.addEventListener("click", () => _dispatchClick("valignBottomBtn"));

    const fontFamEl = $("rpFontFamilySelect");
    fontFamEl?.addEventListener("change", async () => {
        const v = fontFamEl.value || undefined;
        if (v && document.fonts?.load) {
            const primary = v.replace(/,.*/, "").trim();
            const sample = "AaBb1!กฎ";
            try {
                await Promise.all([
                    document.fonts.load(`16px ${primary}`, sample),
                    document.fonts.load(`bold 16px ${primary}`, sample),
                    document.fonts.load(`italic 16px ${primary}`, sample),
                    document.fonts.load(`bold italic 16px ${primary}`, sample),
                ]);
            } catch (e) {}
        }
        _patchBboxOverrideForSelection({ fontFamily: v, fontSize: undefined }, "Set font family");
    });
    const _wireToggle = (btnId, key, desc) => {
        $(btnId)?.addEventListener("click", () => {
            const ref = state.selection.ref;
            if (!ref) return;
            const cur = !!state.bboxOverrides[ref]?.[key];
            _patchBboxOverrideForSelection({ [key]: !cur || undefined }, desc);
        });
    };
    _wireToggle("rpBoldBtn", "bold", "Toggle bold");
    _wireToggle("rpItalicBtn", "italic", "Toggle italic");
    _wireToggle("rpUnderlineBtn", "underline", "Toggle underline");
    _wireToggle("rpStrikeBtn", "strikethrough", "Toggle strikethrough");

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

    _wireMarkupControls();
    _preloadFonts();
}

function _commitFontSize(raw) {
    const v = parseFloat(String(raw).trim());
    if (!isFinite(v) || v < 3 || v > 200) return false;
    const rounded = Math.round(v * 100) / 100;
    _patchBboxOverrideForSelection({ fontSize: rounded }, "Set font size");
    return true;
}

function _wireFontSizeInput() {
    const el = $("rpFontSizeInput");
    if (!el) return;
    const commit = () => {
        const ok = _commitFontSize(el.value);
        if (!ok) _syncFontSizeInput();
    };
    el.addEventListener("change", commit);
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); el.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); _syncFontSizeInput(); el.blur(); }
    });

    const combo = $("rpFontSizeCombo");
    const arrow = $("rpFontSizeArrowBtn");
    const list = $("rpFontSizeList");
    if (!combo || !arrow || !list) return;
    const close = () => { list.style.display = "none"; };
    const open  = () => {
        list.style.display = "block";
        const cur = String(parseFloat(el.value) || "");
        for (const li of list.querySelectorAll("li")) li.style.background = "";
        const match = list.querySelector(`li[data-v="${cur}"]`);
        if (match) {
            match.style.background = "#dbeafe";
            match.scrollIntoView({ block: "nearest" });
        }
    };
    arrow.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (list.style.display === "block") close();
        else open();
    });
    list.addEventListener("mousedown", (e) => {
        const li = e.target.closest("li[data-v]");
        if (!li) return;
        e.preventDefault();   // กัน input เสีย focus ก่อน commit (Safari)
        el.value = li.dataset.v;
        commit();
        close();
    });
    list.addEventListener("mouseover", (e) => {
        const li = e.target.closest("li[data-v]");
        if (!li) return;
        for (const x of list.querySelectorAll("li")) x.style.background = "";
        li.style.background = "#f3f4f6";
    });
    document.addEventListener("click", (e) => {
        if (!combo.contains(e.target)) close();
    });
}

function _syncFontSizeInput() {
    const el = $("rpFontSizeInput");
    if (!el || document.activeElement === el) return;
    const refs = [...(state.selection?.refs || [])];
    if (!refs.length) { el.value = ""; return; }
    const sizes = refs.map(ref => {
        const ov = state.bboxOverrides[ref];
        if (ov?.fontSize != null) return ov.fontSize;
        const drawn = (window._previewWrap?._drawn || []).find(d => d.item?.self_ref === ref);
        return drawn?.fontSize ?? null;
    });
    const first = sizes[0];
    const uniform = sizes.every(s => s != null && Math.abs(s - first) < 0.01);
    el.value = uniform && first != null ? String(Math.round(first * 10) / 10) : "";
}

function _commitLineHeight(raw) {
    const v = parseFloat(String(raw).trim());
    if (!isFinite(v) || v < 6 || v > 300) return false;
    const rounded = Math.round(v * 100) / 100;
    _patchBboxOverrideForSelection({ lineHeight: rounded }, "Set line height");
    return true;
}

function _wireLineHeightInput() {
    const el = $("rpLineHeightInput");
    if (!el) return;
    const commit = () => {
        const ok = _commitLineHeight(el.value);
        if (!ok) _syncLineHeightInput();
    };
    el.addEventListener("change", commit);
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); el.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); _syncLineHeightInput(); el.blur(); }
    });

    const combo = $("rpLineHeightCombo");
    const arrow = $("rpLineHeightArrowBtn");
    const list = $("rpLineHeightList");
    if (!combo || !arrow || !list) return;
    const close = () => { list.style.display = "none"; };
    const open  = () => {
        list.style.display = "block";
        const cur = String(parseFloat(el.value) || "");
        for (const li of list.querySelectorAll("li")) li.style.background = "";
        const match = list.querySelector(`li[data-v="${cur}"]`);
        if (match) {
            match.style.background = "#dbeafe";
            match.scrollIntoView({ block: "nearest" });
        }
    };
    arrow.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (list.style.display === "block") close();
        else open();
    });
    list.addEventListener("mousedown", (e) => {
        const li = e.target.closest("li[data-v]");
        if (!li) return;
        e.preventDefault();
        el.value = li.dataset.v;
        commit();
        close();
    });
    list.addEventListener("mouseover", (e) => {
        const li = e.target.closest("li[data-v]");
        if (!li) return;
        for (const x of list.querySelectorAll("li")) x.style.background = "";
        li.style.background = "#f3f4f6";
    });
    document.addEventListener("click", (e) => {
        if (!combo.contains(e.target)) close();
    });
}

function _wireColorInputs() {
    const textEl = $("rpTextColor");
    const bgEl = $("rpBgColor");
    const resetEl = $("rpResetColorsBtn");
    textEl?.addEventListener("input", () => {
        _patchBboxOverrideForSelection({ textColor: textEl.value }, "Set text color");
    });
    bgEl?.addEventListener("input", () => {
        _patchBboxOverrideForSelection({ bgColor: bgEl.value }, "Set bg color");
    });
    resetEl?.addEventListener("click", () => {
        // undefined → ลบ key ออกจาก override (กลับไปใช้ OCR-detected colors)
        _patchBboxOverrideForSelection({ textColor: undefined, bgColor: undefined }, "Reset colors");
    });
}

function _syncColorInputs() {
    const textEl = $("rpTextColor");
    const bgEl = $("rpBgColor");
    if (!textEl && !bgEl) return;
    const refs = [...(state.selection?.refs || [])];
    const ref = refs[0];
    if (!ref) return;
    const ov = state.bboxOverrides[ref] || {};
    const item = (state.lastResult?.preview?.items || []).find(it => it.self_ref === ref);
    if (textEl) textEl.value = ov.textColor || item?.text_color || "#000000";
    if (bgEl) bgEl.value = ov.bgColor || item?.bg_color || "#ffffff";
}

function _syncLineHeightInput() {
    const el = $("rpLineHeightInput");
    if (!el || document.activeElement === el) return;
    const refs = [...(state.selection?.refs || [])];
    if (!refs.length) { el.value = ""; return; }
    const vals = refs.map(ref => {
        const ov = state.bboxOverrides[ref];
        if (ov?.lineHeight != null) return ov.lineHeight;
        // ไม่ override → ใช้ pixel ที่ render จริงจาก drawn (font metrics)
        const drawn = (window._previewWrap?._drawn || []).find(d => d.item?.self_ref === ref);
        return drawn?.lineHeight ?? null;
    });
    const first = vals[0];
    const uniform = vals.every(v => v != null && Math.abs(v - first) < 0.01);
    el.value = uniform && first != null ? String(Math.round(first)) : "";
}

function _preloadFonts() {
    if (!document.fonts?.load) return;
    const families = ["'Google Sans'", "'Noto Sans Thai'"];
    const styles = ["", "bold ", "italic ", "bold italic "];
    const sample = "AaBb1!กฎ";
    for (const f of families) {
        for (const s of styles) {
            document.fonts.load(`${s}16px ${f}`, sample).catch(() => {});
        }
    }
}

function _wireMarkupControls() {
    const fillEl = $("rpMarkupFill");
    const borderOnEl = $("rpMarkupBorderOn");
    const borderColorEl = $("rpMarkupBorderColor");
    const borderWidthEl = $("rpMarkupBorderWidth");

    const apply = (patchAfter, desc) => {
        const ids = [...(state.markupSelection?.ids || [])];
        if (!ids.length) return;
        const cmds = ids.map(id => {
            const shape = state.markup.find(s => s.id === id);
            if (!shape) return null;
            const before = { fillColor: shape.fillColor, strokeColor: shape.strokeColor, strokeWidth: shape.strokeWidth };
            const after = { ...before, ...patchAfter };
            return new UpdateMarkupCmd(id, before, after, desc);
        }).filter(Boolean);
        if (!cmds.length) return;
        const cmd = cmds.length === 1 ? cmds[0] : new CompositeCommand(cmds, `${desc} (×${cmds.length})`);
        history.exec(cmd);
    };

    fillEl?.addEventListener("input", () => {
        state.markupDefaults.fillColor = fillEl.value;
        apply({ fillColor: fillEl.value }, "Set markup fill");
    });
    borderOnEl?.addEventListener("change", () => {
        if (borderOnEl.checked) {
            apply({ strokeColor: borderColorEl?.value || "#000000", strokeWidth: parseInt(borderWidthEl?.value, 10) || 2 }, "Set markup border");
        } else {
            apply({ strokeColor: null, strokeWidth: 0 }, "Set markup border");
        }
        if (borderColorEl) borderColorEl.disabled = !borderOnEl.checked;
        if (borderWidthEl) borderWidthEl.disabled = !borderOnEl.checked;
    });
    borderColorEl?.addEventListener("input", () => {
        if (!borderOnEl?.checked) return;
        apply({ strokeColor: borderColorEl.value }, "Set markup border");
    });
    borderWidthEl?.addEventListener("input", () => {
        if (!borderOnEl?.checked) return;
        const w = parseInt(borderWidthEl.value, 10);
        if (!isNaN(w) && w > 0) apply({ strokeWidth: w }, "Set markup border");
    });
}

function _syncMarkupPanel(shape) {
    const fillEl = $("rpMarkupFill");
    const borderOnEl = $("rpMarkupBorderOn");
    const borderColorEl = $("rpMarkupBorderColor");
    const borderWidthEl = $("rpMarkupBorderWidth");
    if (fillEl) fillEl.value = shape.fillColor || "#dc2626";
    const hasBorder = shape.strokeColor != null;
    if (borderOnEl) borderOnEl.checked = hasBorder;
    if (borderColorEl) {
        borderColorEl.value = shape.strokeColor || "#000000";
        borderColorEl.disabled = !hasBorder;
    }
    if (borderWidthEl) {
        borderWidthEl.value = shape.strokeWidth || 2;
        borderWidthEl.disabled = !hasBorder;
    }
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
    const markupPanel = $("rpMarkupPanel");
    if (!empty || !content) return;

    const markupIds = state.markupSelection?.ids;
    if (markupIds?.size) {
        const shape = state.markup.find(s => s.id === state.markupSelection.id);
        if (shape) {
            empty.style.display = "none";
            content.style.display = "none";
            if (markupPanel) markupPanel.style.display = "";
            _syncMarkupPanel(shape);
            return;
        }
    }
    if (markupPanel) markupPanel.style.display = "none";

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

    const fontFamEl = $("rpFontFamilySelect");
    if (fontFamEl) fontFamEl.value = ov.fontFamily || "";
    $("rpBoldBtn")?.classList.toggle("active", !!ov.bold);
    $("rpItalicBtn")?.classList.toggle("active", !!ov.italic);
    $("rpUnderlineBtn")?.classList.toggle("active", !!ov.underline);
    $("rpStrikeBtn")?.classList.toggle("active", !!ov.strikethrough);
    _syncFontSizeInput();
    _syncLineHeightInput();
    _syncColorInputs();
}
