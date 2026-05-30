// Preview prompt — inspect/build prompt payload + manual paste apply + one-click copy/paste
// Clone modal HTML จาก <template id="previewModalTpl"> ใน index.html (ไม่มี template ใน JS)

import { state } from "./state.js";
import { getCharacters, SPEAKER_SKIP, SPEAKER_AUTO } from "./characters.js";
import { EMOTION_AUTO, combineEmotion } from "./emotions.js";
import { renderPreview } from "./preview.js";
import { COLORS } from "./colors.js";
import { escapeHtml } from "./diff.js";
import { runState, runDom, getTranslateTarget } from "./run-state.js";
import { applyTranslationSuccess, applyTranslationError } from "./translate-runner.js";

const { corrections, speakerByRef, emotionByRef, emotion2ByRef } = state;

const previewPromptBtn = document.getElementById("previewPromptBtn");
const copyPromptBtn = document.getElementById("copyPromptBtn");
const pastePromptBtn = document.getElementById("pastePromptBtn");

let previewModal = null;
let _previewSource = null;   // state จาก fetchPreview ครั้งล่าสุด — ใช้ตอน manual apply
let _lastPromptRaw = "";     // raw text (system + user, มี newline จริง) — สำหรับ paste Gemini web UI
                             // JSON.stringify จะ escape \n เป็น literal "\\n" → Gemini web อ่านไม่ออก format

// แสดงข้อความ flash บน button ชั่วคราว แล้วคืน HTML เดิม (รวม Material Symbols icon span)
function _flashBtn(btn, msg, ms) {
    if (btn.dataset.flashing) return;
    btn.dataset.flashing = "1";
    const orig = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined">check</span>${msg}`;
    setTimeout(() => {
        btn.innerHTML = orig;
        delete btn.dataset.flashing;
    }, ms || 1800);
}

function _ensureModal() {
    if (previewModal) return;
    const tpl = document.getElementById("previewModalTpl");
    previewModal = tpl.content.firstElementChild.cloneNode(true);
    document.body.appendChild(previewModal);
    previewModal.addEventListener("click", (e) => {
        if (e.target === previewModal) previewModal.classList.remove("show");
    });
    document.getElementById("previewCloseBtn").addEventListener("click", () => previewModal.classList.remove("show"));
    document.getElementById("previewCopyAllBtn").addEventListener("click", async () => {
        // copy RAW text (newline จริง) ไม่ใช่ JSON-stringified — สำหรับ paste Gemini web UI
        const btnEl = document.getElementById("previewCopyAllBtn");
        const origHTML = btnEl.innerHTML;
        try {
            await navigator.clipboard.writeText(_lastPromptRaw);
            btnEl.innerHTML = `<span class="material-symbols-outlined">check</span>Copied`;
            setTimeout(() => { btnEl.innerHTML = origHTML; }, 1500);
        } catch (_) {}
    });
    document.getElementById("previewApplyManualBtn").addEventListener("click", applyManualResponse);

    const reloadFromInputs = () => {
        const size = parseInt(document.getElementById("previewChunkSize").value, 10);
        const idx = parseInt(document.getElementById("previewChunkIdx").value, 10);
        fetchPreview(
            Number.isFinite(size) && size > 0 ? size : null,
            Number.isFinite(idx) && idx > 0 ? idx : 1
        );
    };
    document.getElementById("previewRefreshBtn").addEventListener("click", reloadFromInputs);
    document.getElementById("previewPrevBtn").addEventListener("click", () => {
        const cur = parseInt(document.getElementById("previewChunkIdx").value, 10) || 1;
        if (cur <= 1) return;
        document.getElementById("previewChunkIdx").value = cur - 1;
        reloadFromInputs();
    });
    document.getElementById("previewNextBtn").addEventListener("click", () => {
        const cur = parseInt(document.getElementById("previewChunkIdx").value, 10) || 1;
        const totalChunks = parseInt(document.getElementById("previewChunkTotal").textContent, 10) || 1;
        if (cur >= totalChunks) return;
        document.getElementById("previewChunkIdx").value = cur + 1;
        reloadFromInputs();
    });
    document.getElementById("previewChunkSize").addEventListener("change", () => {
        document.getElementById("previewChunkIdx").value = 1;
        reloadFromInputs();
    });
    document.getElementById("previewChunkIdx").addEventListener("change", reloadFromInputs);
    document.getElementById("previewLoadFailedBtn").addEventListener("click", () => {
        fetchPreview(null, 1, "failed");
    });
}

function _openModal(data, sourceState, totalRows) {
    _ensureModal();
    const meta = document.getElementById("previewMeta");
    meta.innerHTML = `
        <strong>engine:</strong> ${escapeHtml(data.engine)}
        &nbsp;·&nbsp; <strong>target:</strong> ${escapeHtml(data.target)}
        &nbsp;·&nbsp; <strong>total:</strong> ${data.n_total}
        &nbsp;·&nbsp; <strong>sent to LLM:</strong> ${data.n_sent}
        &nbsp;·&nbsp; <strong>skipped (empty):</strong> ${data.skipped_empty}
        &nbsp;·&nbsp; <strong>skipped (🚫 don't translate):</strong> ${data.skipped_user}
        &nbsp;·&nbsp; <strong>speakers in this batch:</strong> ${(data.speakers_used || []).join(", ") || "(none)"}
    `;
    document.getElementById("previewEndpoint").textContent = "POST " + (data.request_endpoint || "");
    document.getElementById("previewBody").textContent = JSON.stringify(data.request_body || {}, null, 2);
    document.getElementById("previewChars").textContent = JSON.stringify(data.characters_used || [], null, 2);
    document.getElementById("previewSystem").textContent = data.system_prompt || "(empty)";
    document.getElementById("previewUser").textContent = data.user_message || "(empty)";
    // raw text สำหรับ paste Gemini web UI — system + user คั่นด้วย blank line
    _lastPromptRaw = [data.system_prompt || "", data.user_message || ""].filter(Boolean).join("\n\n");
    _previewSource = sourceState || null;
    document.getElementById("previewManualResponse").value = "";
    document.getElementById("previewManualStatus").textContent = "";
    document.getElementById("previewManualStatus").style.color = COLORS.textMuted;

    const sizeInput = document.getElementById("previewChunkSize");
    const idxInput = document.getElementById("previewChunkIdx");
    const totalSpan = document.getElementById("previewChunkTotal");
    const rangeNote = document.getElementById("previewRangeNote");
    const failedNote = document.getElementById("previewFailedNote");
    const failedBtn = document.getElementById("previewLoadFailedBtn");
    const failedMode = document.getElementById("previewFailedMode");
    const failedCount = runState.lastFailedIndexes ? runState.lastFailedIndexes.length : 0;
    if (failedNote) {
        failedNote.textContent = failedCount
            ? `${failedCount} rows from the last translate-all`
            : "— No failed rows yet";
    }
    if (failedBtn) failedBtn.disabled = failedCount === 0;
    if (failedMode) failedMode.textContent = (sourceState && sourceState.mode === "failed") ? "← viewing retry fail" : "";

    const isFailed = sourceState && sourceState.mode === "failed";
    const total = (typeof totalRows === "number") ? totalRows : data.n_total;
    const size = (sourceState && sourceState.chunkSize) || data.n_total || total;
    const idx = (sourceState && sourceState.chunkIdx) || 1;
    const totalChunks = Math.max(1, Math.ceil(total / Math.max(1, size)));
    if (sizeInput) { sizeInput.value = size; sizeInput.max = total; sizeInput.disabled = !!isFailed; }
    if (idxInput)  { idxInput.value = idx; idxInput.max = totalChunks; idxInput.disabled = !!isFailed; }
    if (totalSpan) totalSpan.textContent = totalChunks;

    const prevBtn = document.getElementById("previewPrevBtn");
    const nextBtn = document.getElementById("previewNextBtn");
    const refreshBtn = document.getElementById("previewRefreshBtn");
    if (prevBtn) prevBtn.disabled = !!isFailed;
    if (nextBtn) nextBtn.disabled = !!isFailed;
    if (refreshBtn) refreshBtn.disabled = !!isFailed;
    if (rangeNote) {
        if (isFailed) {
            rangeNote.textContent = `(retry fail: ${total} rows)`;
        } else {
            const start = (idx - 1) * size + 1;
            const end = Math.min(idx * size, total);
            rangeNote.textContent = `(rows ${start}–${end} / ${total})`;
        }
    }
    const refreshStatus = document.getElementById("previewRefreshStatus");
    if (refreshStatus) refreshStatus.textContent = "";
    previewModal.classList.add("show");
}

// apply manual-pasted LLM response → ใช้ row-helpers ที่ translate-runner export
async function applyManualResponse() {
    const status = document.getElementById("previewManualStatus");
    if (!_previewSource) {
        status.style.color = COLORS.error;
        status.textContent = "No preview state — open the preview again";
        return;
    }
    const raw = document.getElementById("previewManualResponse").value.trim();
    if (!raw) {
        status.style.color = COLORS.error;
        status.textContent = "Paste a response first";
        return;
    }
    status.style.color = COLORS.textMuted;
    status.textContent = "Processing...";
    try {
        const res = await fetch("/translate-batch/apply-manual", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                texts: _previewSource.texts,
                target: _previewSource.target,
                speakers: _previewSource.speakers,
                characters: _previewSource.characters,
                raw_response: raw,
                id_start: _previewSource.id_start || 1,
                ids: _previewSource.ids || null,
                content_type: runDom.contentTypeSel?.value || "dialogue",
            }),
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 200);
            throw new Error(`HTTP ${res.status}: ${body}`);
        }
        const data = await res.json();
        if (data.error) {
            status.style.color = COLORS.error;
            status.textContent = "Error: " + data.error;
            return;
        }
        const tArr = data.translated || [];
        const errors = data.errors || [];
        const compareArea = document.getElementById("compareArea");
        const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
        const indices = _previewSource.indices || [];
        let ok = 0, warn = 0, fail = 0, skip = 0, notInResp = 0;
        for (let i = 0; i < tArr.length && i < indices.length; i++) {
            const row = rows[indices[i]];
            if (!row) break;
            const ref = row.dataset.ref;
            const isUserSkip = ref && speakerByRef[ref] === SPEAKER_SKIP;
            const isEmptySource = !((_previewSource.texts[i] || "").trim());
            const tr = tArr[i];
            const er = errors[i];
            if (isUserSkip || isEmptySource) {
                skip++;
            } else if (tr && er) {
                applyTranslationSuccess(row, tr, er);
                warn++;
            } else if (tr) {
                applyTranslationSuccess(row, tr);
                ok++;
            } else if (er) {
                applyTranslationError(row, er);
                fail++;
            } else {
                notInResp++;
            }
        }
        status.style.color = (ok + warn) > 0 ? COLORS.success : COLORS.error;
        const parts = [`applied ${ok}`];
        if (warn) parts.push(`warn ${warn}`);
        if (fail) parts.push(`fail ${fail}`);
        if (skip) parts.push(`skipped ${skip}`);
        if (notInResp) parts.push(`not in response ${notInResp}`);
        status.textContent = parts.join(", ");
        if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
    } catch (e) {
        status.style.color = COLORS.error;
        status.textContent = "Error: " + e.message;
    }
}

async function fetchPreview(chunkSize, chunkIdx, mode) {
    const compareArea = document.getElementById("compareArea");
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) {
        alert("No rows in the table — upload a file first");
        return;
    }
    if (mode === "failed" && (!runState.lastFailedIndexes || !runState.lastFailedIndexes.length)) {
        alert("No failed rows yet");
        return;
    }
    const target = getTranslateTarget();
    if (!target) { alert("Select a TM pair first — target language is derived from it."); return; }
    const engine = runDom.translateEngineSel.value;
    const customRules = (runDom.customRulesEl.value || "").trim();
    const defaultId = SPEAKER_AUTO;

    let indices, id_start, size, idx, totalChunks, offset, totalShown;
    if (mode === "failed") {
        indices = runState.lastFailedIndexes.slice();
        id_start = 1;
        size = indices.length;
        idx = 1;
        totalChunks = 1;
        offset = 0;
        totalShown = indices.length;
    } else {
        const totalRows = rows.length;
        size = (typeof chunkSize === "number" && chunkSize > 0) ? Math.min(chunkSize, totalRows) : totalRows;
        totalChunks = Math.max(1, Math.ceil(totalRows / size));
        idx = (typeof chunkIdx === "number" && chunkIdx > 0) ? chunkIdx : 1;
        if (idx > totalChunks) idx = totalChunks;
        offset = (idx - 1) * size;
        indices = [];
        for (let i = offset; i < Math.min(offset + size, totalRows); i++) indices.push(i);
        id_start = offset + 1;
        totalShown = totalRows;
    }
    // filter SKIP + empty ออกจาก preview payload — ตรงกับที่ Translate/Copy ส่งจริง
    // (ก่อนหน้านี้ preview ส่งทั้งหมด เห็น `[N] ` ของ SKIP อยู่ใน user_msg → confusing + ไม่ตรงกับของจริง)
    const filteredIndices = [];
    const texts = [];
    const speakerArr = [];
    const emotionArr = [];
    const idsArr = [];
    for (const i of indices) {
        const r = rows[i];
        const ref = r.dataset.ref;
        if (ref && speakerByRef[ref] === SPEAKER_SKIP) continue;
        const orig = r.dataset.orig || "";
        const t = (corrections[ref] !== undefined) ? corrections[ref] : orig;
        if (!t || !t.trim()) continue;
        filteredIndices.push(i);
        texts.push(t);
        speakerArr.push(speakerByRef[ref] || defaultId);
        emotionArr.push(combineEmotion(emotionByRef[ref], emotion2ByRef[ref]));
        idsArr.push(i + 1);   // global row id (1-based)
    }
    indices = filteredIndices;  // overwrite — _previewSource เก็บ indices หลัง filter

    const refreshStatus = document.getElementById("previewRefreshStatus");
    if (refreshStatus) refreshStatus.textContent = "Loading...";
    try {
        const res = await fetch("/translate-batch/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                texts, target, engine,
                custom_rules: customRules,
                speakers: speakerArr,
                emotions: emotionArr,
                characters: getCharacters(),
                id_start, ids: idsArr,
                content_type: runDom.contentTypeSel?.value || "dialogue",
            }),
        });
        const data = await res.json();
        if (data.error) {
            if (refreshStatus) refreshStatus.textContent = "";
            alert("Error: " + data.error);
            return;
        }
        _openModal(
            data,
            { texts, target, speakers: speakerArr, emotions: emotionArr, characters: getCharacters(),
              indices, ids: idsArr, id_start, mode: mode || "chunk", chunkSize: size, chunkIdx: idx },
            totalShown
        );
    } catch (e) {
        if (refreshStatus) refreshStatus.textContent = "";
        alert("Error: " + e.message);
    }
}

previewPromptBtn.addEventListener("click", () => fetchPreview());

// ── One-click Copy prompt / Paste LLM response ──

async function copyPromptOneClick() {
    const compareArea = document.getElementById("compareArea");
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) { alert("No rows in the table — upload a file first"); return; }
    const target = getTranslateTarget();
    if (!target) { alert("Select a TM pair first — target language is derived from it."); return; }
    const engine = runDom.translateEngineSel.value;
    const customRules = (runDom.customRulesEl.value || "").trim();
    const defaultId = SPEAKER_AUTO;

    // filter SKIP + empty ออก — ส่ง LLM เฉพาะที่ต้องแปลจริง (sparse ids ตาม row index จริง)
    const indices = [];
    const texts = [];
    const speakerArr = [];
    const emotionArr = [];
    const idsArr = [];
    rows.forEach((r, i) => {
        const ref = r.dataset.ref;
        if (ref && speakerByRef[ref] === SPEAKER_SKIP) return;
        const orig = r.dataset.orig || "";
        const t = (corrections[ref] !== undefined) ? corrections[ref] : orig;
        if (!t || !t.trim()) return;
        indices.push(i);
        texts.push(t);
        speakerArr.push(speakerByRef[ref] || defaultId);
        emotionArr.push(combineEmotion(emotionByRef[ref], emotion2ByRef[ref]));
        idsArr.push(i + 1);
    });
    if (!texts.length) { alert("Nothing to translate — all rows are SKIP or empty"); return; }

    runDom.correctProgress.textContent = "⏳ Building prompt...";
    try {
        const res = await fetch("/translate-batch/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                texts, target, engine,
                custom_rules: customRules,
                speakers: speakerArr,
                emotions: emotionArr,
                characters: getCharacters(),
                id_start: 1, ids: idsArr,
                content_type: runDom.contentTypeSel?.value || "dialogue",
            }),
        });
        const data = await res.json();
        if (data.error) { runDom.correctProgress.textContent = "Error: " + data.error; return; }
        // copy RAW text (newline จริง) สำหรับ paste Gemini web UI
        // ไม่ใช้ JSON.stringify(request_body) เพราะจะ escape \n เป็น literal "\\n" → web UI อ่านไม่ออก
        const raw = [data.system_prompt || "", data.user_message || ""].filter(Boolean).join("\n\n");
        await navigator.clipboard.writeText(raw);
        runDom.correctProgress.textContent = `✓ Copied prompt (${rows.length} rows) → paste into LLM`;
        _flashBtn(copyPromptBtn, "Copied");
    } catch (e) {
        runDom.correctProgress.textContent = "Error: " + e.message;
    }
}

async function pastePromptOneClick() {
    const compareArea = document.getElementById("compareArea");
    const allRows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!allRows.length) { alert("No rows in the table — upload a file first"); return; }

    let raw;
    try { raw = await navigator.clipboard.readText(); }
    catch (e) { runDom.correctProgress.textContent = "Cannot read clipboard: " + e.message; return; }
    if (!raw || !raw.trim()) { runDom.correctProgress.textContent = "Clipboard is empty"; return; }

    // build state จาก table ปัจจุบัน — กรอง SKIP + empty (ตรงกับที่ copyPrompt ส่งไป)
    const target = getTranslateTarget();
    if (!target) { alert("Select a TM pair first — target language is derived from it."); return; }
    const defaultId = SPEAKER_AUTO;
    const indices = [];
    const texts = [];
    const speakerArr = [];
    const emotionArr = [];
    const idsArr = [];
    allRows.forEach((r, i) => {
        const ref = r.dataset.ref;
        if (ref && speakerByRef[ref] === SPEAKER_SKIP) return;
        const orig = r.dataset.orig || "";
        const t = (corrections[ref] !== undefined) ? corrections[ref] : orig;
        if (!t || !t.trim()) return;
        indices.push(i);
        texts.push(t);
        speakerArr.push(speakerByRef[ref] || defaultId);
        emotionArr.push(combineEmotion(emotionByRef[ref], emotion2ByRef[ref]));
        idsArr.push(i + 1);
    });
    if (!texts.length) { runDom.correctProgress.textContent = "Nothing to apply — all rows are SKIP or empty"; return; }

    runDom.correctProgress.textContent = "⏳ Applying response...";
    try {
        const res = await fetch("/translate-batch/apply-manual", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                texts, target,
                speakers: speakerArr,
                emotions: emotionArr,
                characters: getCharacters(),
                raw_response: raw,
                id_start: 1, ids: idsArr,
                content_type: runDom.contentTypeSel?.value || "dialogue",
            }),
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 200);
            throw new Error(`HTTP ${res.status}: ${body}`);
        }
        const data = await res.json();
        if (data.error) { runDom.correctProgress.textContent = "Error: " + data.error; return; }

        const tArr = data.translated || [];
        const errors = data.errors || [];
        // SKIP + empty ถูก filter ออกตั้งแต่ก่อน POST แล้ว — นับจาก allRows ที่ไม่ได้อยู่ใน indices
        const skip = allRows.length - indices.length;
        let ok = 0, warn = 0, fail = 0, notInResp = 0;
        for (let i = 0; i < tArr.length && i < indices.length; i++) {
            const row = allRows[indices[i]];
            if (!row) break;
            const tr = tArr[i];
            const er = errors[i];
            if (tr && er) { applyTranslationSuccess(row, tr, er); warn++; }
            else if (tr) { applyTranslationSuccess(row, tr); ok++; }
            else if (er) { applyTranslationError(row, er); fail++; }
            else notInResp++;
        }
        const parts = [`applied ${ok}`];
        if (warn) parts.push(`warn ${warn}`);
        if (fail) parts.push(`fail ${fail}`);
        if (skip) parts.push(`skipped ${skip}`);
        if (notInResp) parts.push(`not in response ${notInResp}`);
        runDom.correctProgress.textContent = parts.join(", ");
        _flashBtn(pastePromptBtn, "Applied");
        if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
    } catch (e) {
        runDom.correctProgress.textContent = "Error: " + e.message;
    }
}

copyPromptBtn.addEventListener("click", copyPromptOneClick);
pastePromptBtn.addEventListener("click", pastePromptOneClick);
