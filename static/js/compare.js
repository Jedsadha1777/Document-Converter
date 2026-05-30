// Compare table — build/edit table + diff render + CSV + speaker dropdown
// LLM run logic แยกไป translate-runner.js / correct-runner.js / preview-prompt.js / tm.js

import { state } from "./state.js";
import { history } from "./history.js";
import { SetSpeakerCmd, SetEmotionCmd } from "./commands.js";
import { escapeHtml, diffChars, renderDiffSide } from "./diff.js";
import { getCharacters, renderSpeakerOptions, SPEAKER_AUTO } from "./characters.js";
import { renderEmotionOptions, EMOTION_AUTO } from "./emotions.js";
import { setStatus } from "./status.js";
import { renderPreview } from "./preview.js";
import {
    runState, runDom,
    applyRunConfig, updateRetryButton,
} from "./run-state.js";

const { corrections, translations, speakerByRef, emotionByRef, emotion2ByRef, manualEdits, manualTranslations } = state;

// target ของ tmPair → emotion list ที่ใช้ใน dropdown (jp-th/en-th → th, en-vn → vi)
const _PAIR_TO_TARGET = { "jp-th": "th", "en-th": "th", "en-vn": "vi" };
function _currentEmotionTarget() {
    const pair = document.getElementById("tmPair")?.value || "";
    return _PAIR_TO_TARGET[pair] || "_default";
}

const compareArea = document.getElementById("compareArea");

export function buildCompareTable(force = false) {
    if (!state.lastResult) {
        compareArea.innerHTML = '<div class="empty">Upload a file first, then click a button to have the LLM correct it.</div>';
        return;
    }
    if (!force && compareArea.querySelector("table.compare")) return;

    const texts = (state.lastResult && state.lastResult.texts) || [];
    if (!texts.length) {
        compareArea.innerHTML = '<div class="empty">No text found in the current JSON.</div>';
        return;
    }

    const speakerOptions = renderSpeakerOptions();
    const emotionTarget = _currentEmotionTarget();
    const emotion1Options = renderEmotionOptions(emotionTarget, false);  // primary — มี Auto, ไม่มี (none)
    const emotion2Options = renderEmotionOptions(emotionTarget, true);   // secondary — มี Auto + (none)
    const rows = texts.map((t, i) => {
        const orig = t.text || '';
        const ref = t.self_ref || '';
        const cached = ref && corrections[ref];
        const tr = ref && translations[ref];
        const editAttrs = 'contenteditable="true" spellcheck="false" title="Click to edit manually"';
        let corrCell = `<td class="col-corrected col-text pending" ${editAttrs}>—</td>`;
        let origCellInner = escapeHtml(orig);
        let rowCls = '';
        if (cached !== undefined) {
            const isManual = manualEdits.has(ref);
            const cls = "col-corrected col-text" + (isManual ? " manual" : "");
            if (cached.trim() !== orig.trim()) {
                const ops = diffChars(orig, cached);
                origCellInner = renderDiffSide(ops, "orig");
                corrCell = `<td class="${cls}" ${editAttrs}>${renderDiffSide(ops, "corr")}</td>`;
                rowCls = "changed";
            } else {
                corrCell = `<td class="${cls}" ${editAttrs}>${escapeHtml(cached)}</td>`;
                rowCls = "same";
            }
        }
        const trEditAttrs = 'contenteditable="true" spellcheck="false" title="Click to edit the translation"';
        const trIsManual = manualTranslations.has(ref);
        const trBaseCls = "col-translated col-text" + (trIsManual ? " manual" : "");
        const trCell = (tr !== undefined)
            ? `<td class="${trBaseCls}" ${trEditAttrs}>${escapeHtml(tr)}</td>`
            : `<td class="col-translated col-text pending" ${trEditAttrs}>—</td>`;
        const curSpeaker = speakerByRef[ref] || SPEAKER_AUTO;
        const speakerCell = `<td class="col-speaker">
            <select class="speaker-select" data-ref="${escapeHtml(ref)}">${speakerOptions(curSpeaker)}</select>
        </td>`;
        const curE1 = emotionByRef[ref] || EMOTION_AUTO;
        const curE2 = emotion2ByRef[ref] ?? "";
        const emotionCell = `<td class="col-emotion">
            <select class="emotion-select" data-ref="${escapeHtml(ref)}" data-slot="1" title="Primary emotion">${emotion1Options(curE1)}</select>
            <select class="emotion-select" data-ref="${escapeHtml(ref)}" data-slot="2" title="Secondary emotion (combined with primary as 'A+B' when sent to LLM)">${emotion2Options(curE2)}</select>
        </td>`;
        return `
            <tr data-idx="${i}" data-ref="${escapeHtml(ref)}" data-orig="${escapeHtml(orig)}" class="${rowCls}">
                <td class="col-no">${i + 1}</td>
                ${speakerCell}
                ${emotionCell}
                <td class="col-text col-original">${origCellInner}</td>
                ${corrCell}
                ${trCell}
            </tr>
        `;
    }).join("");

    compareArea.innerHTML = `
        <table class="compare">
            <thead><tr>
                <th class="col-no">#</th>
                <th class="col-speaker">Speaker</th>
                <th class="col-emotion">Emotion</th>
                <th>OCR (original)</th>
                <th>Corrected by LLM</th>
                <th>Translation</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
    runDom.correctProgress.textContent = `${texts.length} items`;
}

// อัปเดต diff display ของ row หลังแก้ไข — call site: focusout listener
function updateRowDiff(row, orig, corrected) {
    const origCell = row.querySelector(".col-original");
    const cell = row.querySelector(".col-corrected");
    row.classList.remove("changed", "same", "active");
    cell.classList.remove("pending", "error");
    if (corrected.trim() === orig.trim()) {
        origCell.textContent = orig;
        cell.textContent = corrected;
        row.classList.add("same");
    } else {
        const ops = diffChars(orig, corrected);
        origCell.innerHTML = renderDiffSide(ops, "orig");
        cell.innerHTML = renderDiffSide(ops, "corr");
        row.classList.add("changed");
    }
}

// ── inline editing (focusin/out + Enter/Esc) ──
compareArea.addEventListener("focusin", (e) => {
    const cell = e.target.closest("td.col-corrected, td.col-translated");
    if (!cell) return;
    if (cell.classList.contains("pending")) {
        cell.textContent = "";
        cell.classList.remove("pending");
    } else {
        // ถอด HTML diff ออก ให้เหลือ plain text เพื่อแก้ง่าย
        cell.textContent = cell.textContent;
    }
});
compareArea.addEventListener("focusout", (e) => {
    const cell = e.target.closest("td.col-corrected, td.col-translated");
    if (!cell) return;
    const row = cell.closest("tr");
    if (!row) return;
    const ref = row.dataset.ref;
    const orig = row.dataset.orig || "";
    const newVal = (cell.textContent || "").replace(/\s+$/g, "");
    const isCorrected = cell.classList.contains("col-corrected");

    if (!newVal.trim()) {
        if (ref) {
            if (isCorrected) { delete corrections[ref]; manualEdits.delete(ref); }
            else { delete translations[ref]; manualTranslations.delete(ref); }
        }
        cell.textContent = "—";
        cell.classList.add("pending");
        cell.classList.remove("manual");
        if (isCorrected) {
            row.classList.remove("changed", "same");
            row.querySelector(".col-original").textContent = orig;
        }
    } else {
        if (ref) {
            if (isCorrected) {
                corrections[ref] = newVal;
                manualEdits.add(ref);
                updateRowDiff(row, orig, newVal);
            } else {
                translations[ref] = newVal;
                manualTranslations.add(ref);
                cell.textContent = newVal;
            }
            cell.classList.add("manual");
        }
    }

    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});
compareArea.addEventListener("keydown", (e) => {
    const cell = e.target.closest && e.target.closest("td.col-corrected, td.col-translated");
    if (!cell) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); cell.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cell.blur(); }
});

// ── speaker dropdown — undo/redo-able ──
compareArea.addEventListener("change", (e) => {
    const selEl = e.target.closest("select.speaker-select");
    if (!selEl) return;
    const ref = selEl.dataset.ref;
    if (!ref) return;
    const before = speakerByRef[ref];
    history.exec(new SetSpeakerCmd(ref, before, selEl.value));
    if (document.querySelector(".tab.active").dataset.tab === "visual") {
        (window._previewWrap?._redraw || renderPreview)();
    }
});

// ── emotion dropdowns (primary + secondary slot) — undo/redo-able ──
compareArea.addEventListener("change", (e) => {
    const selEl = e.target.closest("select.emotion-select");
    if (!selEl) return;
    const ref = selEl.dataset.ref;
    if (!ref) return;
    const slot = parseInt(selEl.dataset.slot, 10) === 2 ? 2 : 1;
    const map = slot === 2 ? emotion2ByRef : emotionByRef;
    const before = map[ref];
    history.exec(new SetEmotionCmd(ref, before, selEl.value, slot));
});

// ── CSV export ──
function _csvField(v) {
    const s = (v == null) ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
document.getElementById("exportCsvBtn").addEventListener("click", () => {
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) {
        setStatus("Nothing to export — convert a file first", "error");
        return;
    }
    const header = ["#", "Speaker", "OCR (original)", "Corrected by LLM", "Translation"];
    const lines = [header.map(_csvField).join(",")];
    rows.forEach((row, i) => {
        const ref = row.dataset.ref;
        const orig = row.dataset.orig || "";
        const speaker = speakerByRef[ref] || "";
        const corrected = (ref && corrections[ref] !== undefined) ? corrections[ref] : "";
        const tr = (ref && translations[ref] !== undefined) ? translations[ref] : "";
        lines.push([i + 1, speaker, orig, corrected, tr].map(_csvField).join(","));
    });
    // BOM so Excel opens utf-8 correctly
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `compare-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// resize → ถ้าอยู่ Visual ให้ redraw (Preview ไม่กระตุก)
window.addEventListener("resize", () => {
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});

// ── public API ──

// initCompare — เซ็ต config Jinja-rendered ลง run-state
export function initCompare(config) {
    applyRunConfig(config);
}

// resetCompareUI — เรียกตอน upload ไฟล์ใหม่
export function resetCompareUI() {
    runState.lastFailedIndexes = [];
    compareArea.innerHTML = '<div class="empty">Processing...</div>';
    runDom.correctProgress.textContent = "";
    updateRetryButton();
}
