// Right-side inspector — แสดง format toolbar + OCR text + Speaker + translation textarea
// ของ selected bbox. Pattern: render เมื่อ state.selection.ref เปลี่ยน
// (caller เรียก update() หลัง mutate selection).

import { state } from "../state.js";
import { history } from "../history.js";
import { SetSpeakerCmd } from "../commands.js";
import { renderSpeakerOptions, getCharacters, SPEAKER_SKIP, SPEAKER_AUTO } from "../characters.js";

let _suppress = false;   // กัน feedback loop ตอน user พิมพ์ใน textarea

const $ = (id) => document.getElementById(id);

function _dispatchClick(id) {
    $(id)?.click();
}

export function initInspector() {
    // Format buttons → re-dispatch click ไปยังปุ่ม editToolbar ที่มี logic อยู่แล้ว
    // (DRY — ใช้ logic ตัวเดียวกับ toolbar บน ภายในตัว top, รวม history command, sync, redraw)
    $("rpFontDecBtn")?.addEventListener("click", () => _dispatchClick("fontDecBtn"));
    $("rpFontIncBtn")?.addEventListener("click", () => _dispatchClick("fontIncBtn"));
    $("rpAlignLeftBtn")?.addEventListener("click", () => _dispatchClick("alignLeftBtn"));
    $("rpAlignCenterBtn")?.addEventListener("click", () => _dispatchClick("alignCenterBtn"));
    $("rpAlignRightBtn")?.addEventListener("click", () => _dispatchClick("alignRightBtn"));
    $("rpValignTopBtn")?.addEventListener("click", () => _dispatchClick("valignTopBtn"));
    $("rpValignMiddleBtn")?.addEventListener("click", () => _dispatchClick("valignMiddleBtn"));
    $("rpValignBottomBtn")?.addEventListener("click", () => _dispatchClick("valignBottomBtn"));

    // Speaker dropdown — exec SetSpeakerCmd ผ่าน history (= undo/redo + canvas/compare sync)
    const spkEl = $("rpSpeakerSelect");
    spkEl?.addEventListener("change", () => {
        const ref = state.selection.ref;
        if (!ref) return;
        const before = state.speakerByRef[ref];
        const after = spkEl.value;
        if (before === after) return;
        history.exec(new SetSpeakerCmd(ref, before, after));
    });
    // hover tooltip — แสดง name/sex/age/personality ของ character ที่เลือก
    spkEl?.addEventListener("mouseenter", () => _showSpkTooltip(spkEl));
    spkEl?.addEventListener("mouseleave", _hideSpkTooltip);
    spkEl?.addEventListener("mousedown", _hideSpkTooltip);
    spkEl?.addEventListener("change", _hideSpkTooltip);

    // Translation textarea — write back ลง state.translations + mark manual
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
        // redraw canvas + sync compare table
        _suppress = true;
        window._previewWrap?._redraw?.();
        window.buildCompareTable?.(true);
        _suppress = false;
        _updateTrSourceHint(ref);
    });
}

function _updateTrSourceHint(ref) {
    const el = $("rpTrSource");
    if (!el) return;
    const tr = state.translations[ref];
    if (!tr) { el.textContent = ""; return; }
    el.textContent = state.manualTranslations.has(ref) ? "(manual)" : "(LLM)";
}

// ── speaker hover tooltip — light box แสดง name / sex / age / personality ──

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
    // position: ทางซ้ายของ select (right panel อยู่ด้านขวาจอ → tooltip ออกซ้าย)
    const r = selEl.getBoundingClientRect();
    tip.style.display = "block";
    // measure แล้วจัด — left ของ tooltip = select.left - tip.width - 8
    const tr = tip.getBoundingClientRect();
    let left = r.left - tr.width - 8;
    if (left < 8) {
        // ไม่พอที่ทางซ้าย → ลองวางด้านล่างของ select
        left = Math.max(8, r.left);
        tip.style.left = left + "px";
        tip.style.top = (r.bottom + 6) + "px";
    } else {
        tip.style.left = left + "px";
        // align ด้านบนกับ select
        tip.style.top = r.top + "px";
    }
    // overflow ล่าง → ดึงขึ้น
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

    // OCR text — แสดง corrected ถ้ามี, ไม่งั้น original (readonly — แก้ผ่าน compare table)
    $("rpOcrText").value = state.corrections[ref] ?? item.text ?? "";

    // Speaker dropdown — rebuild option list ทุก update (characters เปลี่ยนได้)
    // ถ้า ref ไม่มี speaker → default = chars[0] (เหมือน bbox popup เดิม)
    // ไม่อย่างนั้น browser จะ pick option แรก = SPEAKER_SKIP โดยอัตโนมัติ → bug ที่ user รายงาน
    const spkEl = $("rpSpeakerSelect");
    if (spkEl) {
        const cur = state.speakerByRef[ref] || SPEAKER_AUTO;
        spkEl.innerHTML = renderSpeakerOptions()(cur);
    }

    // Translation
    const trEl = $("rpTrText");
    if (document.activeElement !== trEl) {
        // อย่า overwrite ตอน user กำลังพิมพ์อยู่
        trEl.value = state.translations[ref] || "";
    }
    _updateTrSourceHint(ref);

    // sync align/valign active state
    const ov = state.bboxOverrides[ref] || {};
    const hMap = { left: "rpAlignLeftBtn", center: "rpAlignCenterBtn", right: "rpAlignRightBtn" };
    const vMap = { top: "rpValignTopBtn", middle: "rpValignMiddleBtn", bottom: "rpValignBottomBtn" };
    Object.values(hMap).forEach(id => $(id)?.classList.remove("active"));
    Object.values(vMap).forEach(id => $(id)?.classList.remove("active"));
    if (hMap[ov.align]) $(hMap[ov.align])?.classList.add("active");
    if (vMap[ov.valign]) $(vMap[ov.valign])?.classList.add("active");
}
