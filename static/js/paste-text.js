// Paste-text mode — แปลตรงๆ จาก text ที่ paste ไม่ต้อง upload file
// แต่ละบรรทัด = 1 row ใน Compare table (skip บรรทัดว่าง)
// build synthetic state.lastResult schema ขั้นต่ำให้ buildCompareTable ใช้ได้

import { state } from "./state.js";
import { buildCompareTable } from "./compare.js";

let _modal = null;

function _openModal() {
    if (!_modal) {
        _modal = document.createElement("div");
        _modal.className = "modal-backdrop";
        _modal.innerHTML = `
            <div class="modal-card" role="dialog" style="max-width:760px;">
                <h2><span class="material-symbols-outlined">edit_note</span>Paste text directly</h2>
                <div style="font-size:13px; color:#6b7280; margin-bottom:10px;">
                    Each line becomes a row in the Compare table — no file upload needed.<br>
                    Blank lines are skipped. Click <strong>Apply</strong> to build the table and switch to Compare tab.
                </div>
                <textarea id="pasteTextInput" rows="14" placeholder="Paste text here, one line per row..."
                          style="width:100%; box-sizing:border-box; padding:8px 10px; font-family:inherit; font-size:13px; color:#111827; background:#fff; border:1px solid #d1d5db; border-radius:6px; resize:vertical; min-height:200px;"></textarea>
                <div class="modal-foot" style="margin-top:10px;">
                    <span id="pasteTextHint" style="font-size:12px; color:#6b7280;"></span>
                    <div style="display:flex; gap:6px;">
                        <button type="button" id="pasteTextClearBtn" class="ghost">Clear</button>
                        <button type="button" id="pasteTextCancelBtn" class="ghost">Cancel</button>
                        <button type="button" id="pasteTextApplyBtn">Apply</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_modal);
        _modal.addEventListener("click", (e) => { if (e.target === _modal) _closeModal(); });
        document.getElementById("pasteTextCancelBtn").addEventListener("click", _closeModal);
        document.getElementById("pasteTextApplyBtn").addEventListener("click", _apply);
        document.getElementById("pasteTextClearBtn").addEventListener("click", () => {
            const ta = document.getElementById("pasteTextInput");
            if (ta) { ta.value = ""; ta.focus(); }
            _updateHint();
        });
        document.getElementById("pasteTextInput").addEventListener("input", _updateHint);
    }
    _modal.classList.add("show");
    setTimeout(() => document.getElementById("pasteTextInput")?.focus(), 50);
    _updateHint();
}

function _closeModal() {
    if (_modal) _modal.classList.remove("show");
}

function _updateHint() {
    const v = document.getElementById("pasteTextInput")?.value || "";
    const lines = v.split(/\r?\n/).filter(l => l.trim()).length;
    const hint = document.getElementById("pasteTextHint");
    if (hint) hint.textContent = lines ? `${lines} non-empty line(s) → row(s)` : "";
}

function _apply() {
    const v = document.getElementById("pasteTextInput")?.value || "";
    const lines = v.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
        alert("Paste at least one non-empty line of text first");
        return;
    }
    // build synthetic state.lastResult ขั้นต่ำให้ compare.js / runner ใช้ได้
    // self_ref ตามรูปแบบของ docling — "#/texts/N"
    const texts = lines.map((text, i) => ({
        text,
        self_ref: `#/texts/${i}`,
        label: "text",
    }));
    state.lastResult = {
        texts,
        preview: { pages: [], items: texts.map(t => ({ ...t, bbox: [0, 0, 0, 0] })) },
        json_text: JSON.stringify({ texts }, null, 2),
    };
    // reset per-doc overrides — ต้อง clear in-place (delete keys) เพราะ compare.js destructure
    // reference ตอน import → ถ้า reassign state.X = {} compare จะยังเห็น object ตัวเก่า
    Object.keys(state.bboxOverrides).forEach(k => delete state.bboxOverrides[k]);
    Object.keys(state.speakerByRef).forEach(k => delete state.speakerByRef[k]);
    Object.keys(state.emotionByRef).forEach(k => delete state.emotionByRef[k]);
    Object.keys(state.emotion2ByRef).forEach(k => delete state.emotion2ByRef[k]);
    Object.keys(state.corrections).forEach(k => delete state.corrections[k]);
    Object.keys(state.translations).forEach(k => delete state.translations[k]);
    state.manualEdits.clear();
    state.manualTranslations.clear();

    _closeModal();
    // switch ไปยัง Compare tab + force rebuild
    document.querySelector('.tab[data-tab="compare"]')?.click();
    buildCompareTable(true);
}

export function initPasteText() {
    const btn = document.getElementById("pasteTextBtn");
    btn?.addEventListener("click", _openModal);
}
