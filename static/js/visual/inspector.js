// Right-side inspector — แสดง format toolbar + OCR text + Speaker + translation textarea
// ของ selected bbox. Pattern: render เมื่อ state.selection.ref เปลี่ยน
// (caller เรียก update() หลัง mutate selection).

import { state } from "../state.js";
import { history } from "../history.js";
import { SetSpeakerCmd } from "../commands.js";
import { renderSpeakerOptions, getCharacters } from "../characters.js";

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
        const chars = getCharacters();
        const cur = state.speakerByRef[ref] || (chars[0]?.id) || "";
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
