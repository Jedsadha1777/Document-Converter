// Compare tab — LLM correct/translate, table, retry, TM, preview prompt, copy/paste
// 1 feature = 1 file (อ้าง Ketchup SelectTool); state อ่าน/เขียนผ่าน state.js
// initCompare รับ config Jinja-rendered (batchSizeDefault/geminiDelayMs/geminiModel)

import { state } from "./state.js";
import { history } from "./history.js";
import { SetSpeakerCmd } from "./commands.js";
import { escapeHtml, diffChars, renderDiffSide } from "./diff.js";
import { getCharacters, renderSpeakerOptions, SPEAKER_SKIP } from "./characters.js";
import { setStatus } from "./status.js";
import { renderPreview } from "./preview.js";
import { COLORS } from "./colors.js";

// shortcuts สำหรับ state dicts/Sets — เป็น reference เดียวกัน, mutations sync
const { corrections, translations, speakerByRef, manualEdits, manualTranslations } = state;

// config จาก Jinja (initCompare เซ็ตทับตอน boot)
const _config = { batchSizeDefault: 5, geminiDelayMs: 0 };

// ── DOM refs (Compare tab) ──
const compareArea = document.getElementById("compareArea");
const runCorrectBtn = document.getElementById("runCorrectBtn");
const stopCorrectBtn = document.getElementById("stopCorrectBtn");
const clearCorrectBtn = document.getElementById("clearCorrectBtn");
const correctProgress = document.getElementById("correctProgress");

let correctRunning = false;
let correctAbort = false;

function buildCompareTable(force = false) {
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
        const curSpeaker = speakerByRef[ref] || (getCharacters()[0] && getCharacters()[0].id) || "";
        const speakerCell = `<td class="col-speaker">
            <select class="speaker-select" data-ref="${escapeHtml(ref)}">${speakerOptions(curSpeaker)}</select>
        </td>`;
        return `
            <tr data-idx="${i}" data-ref="${escapeHtml(ref)}" data-orig="${escapeHtml(orig)}" class="${rowCls}">
                <td class="col-no">${i + 1}</td>
                ${speakerCell}
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
                <th>OCR (original)</th>
                <th>Corrected by LLM</th>
                <th>Translation</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
    correctProgress.textContent = `${texts.length} items`;
}

async function correctOne(text, before, after, engine, customRules) {
    const res = await fetch("/correct", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            text,
            context_before: before || [],
            context_after: after || [],
            engine: engine || "qwen",
            custom_rules: customRules || "",
        }),
    });
    return res.json();
}

async function correctBatchCall(texts, engine, customRules, attempt) {
    const res = await fetch("/correct-batch", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            texts,
            engine: engine || "qwen",
            custom_rules: customRules || "",
            attempt: attempt || 0,
        }),
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
    }
    return res.json();
}

// helper สำหรับแสดง diff บน row ที่แก้แล้ว
function _applyCorrectResult(row, orig, corrected) {
    const origCell = row.querySelector(".col-original");
    const cell = row.querySelector(".col-corrected");
    cell.classList.remove("pending", "error");
    cell.removeAttribute("title");
    row.classList.remove("active");
    let changed = false;
    if (corrected.trim() !== orig.trim()) {
        const ops = diffChars(orig, corrected);
        origCell.innerHTML = renderDiffSide(ops, "orig");
        cell.innerHTML = renderDiffSide(ops, "corr");
        row.classList.add("changed");
        changed = true;
    } else {
        cell.textContent = corrected;
        row.classList.add("same");
    }
    const ref = row.dataset.ref;
    if (ref) corrections[ref] = corrected;
    return changed;
}
function _applyCorrectError(row, errMsg) {
    const origCell = row.querySelector(".col-original");
    const cell = row.querySelector(".col-corrected");
    cell.classList.remove("pending");
    cell.classList.add("error");
    // คืน original ลง col-corrected (ถือว่า "ไม่มีการแก้") + reset diff display
    const orig = row.dataset.orig || "";
    cell.textContent = orig;
    cell.title = "❌ " + errMsg;
    origCell.textContent = orig;
    row.classList.remove("active", "changed", "same");
}
function _markCorrectPending(row) {
    const cell = row.querySelector(".col-corrected");
    cell.classList.add("pending");
    cell.classList.remove("error");
    cell.removeAttribute("title");
    cell.textContent = "Correcting...";
    row.classList.add("active");
}

// ส่ง correct batch สำหรับ index list — return list ของ index ที่ยัง fail
async function _processCorrectBatch(rows, indexes, batchSz, engine, customRules, attempt, label) {
    // pre-filter: empty source → set corrected = "" ทันที ไม่ส่ง LLM
    const workIndexes = [];
    let skippedEmpty = 0;
    for (const idx of indexes) {
        const orig = rows[idx].dataset.orig || "";
        if (!orig || !orig.trim()) {
            _applyCorrectResult(rows[idx], orig, orig);
            skippedEmpty++;
        } else {
            workIndexes.push(idx);
        }
    }
    indexes = workIndexes;
    if (skippedEmpty > 0) {
        console.log(`[correct] skipped ${skippedEmpty} empty rows`);
    }

    const stillFailed = [];
    const total = rows.length;
    let changed = 0;
    for (let start = 0; start < indexes.length; start += batchSz) {
        if (correctAbort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        const sliceIdxs = indexes.slice(start, start + batchSz);
        const sliceRows = sliceIdxs.map(i => rows[i]);
        const sources = sliceRows.map(r => r.dataset.orig || "");
        sliceRows.forEach(_markCorrectPending);
        await _geminiThrottle(engine);
        if (correctAbort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        try {
            const data = await correctBatchCall(sources, engine, customRules, attempt);
            _geminiTouch(engine);
            // 429 detection
            const errSample = data.error || (data.errors || []).find(e => e);
            const wait429 = _parse429RetrySec(errSample);
            if (wait429 > 0) {
                sliceIdxs.forEach((idx, k) => {
                    _applyCorrectError(sliceRows[k], `quota exceeded — wait ${(wait429/1000).toFixed(0)}s then click retry`);
                    stillFailed.push(idx);
                });
                correctProgress.textContent = `⛔ Gemini quota exceeded — stopping; wait ${(wait429/1000).toFixed(0)}s before retry`;
                stillFailed.push(...indexes.slice(start + sliceIdxs.length));
                break;
            }
            if (data.error) {
                sliceIdxs.forEach((idx, k) => {
                    _applyCorrectError(sliceRows[k], data.error);
                    stillFailed.push(idx);
                });
            } else {
                const arr = data.corrected || [];
                const errs = data.errors || [];
                sliceIdxs.forEach((idx, k) => {
                    if (errs[k]) {
                        _applyCorrectError(sliceRows[k], errs[k]);
                        stillFailed.push(idx);
                    } else {
                        if (_applyCorrectResult(sliceRows[k], sources[k], arr[k] ?? sources[k])) {
                            changed++;
                        }
                    }
                });
            }
        } catch (e) {
            _geminiTouch(engine);
            sliceIdxs.forEach((idx, k) => {
                _applyCorrectError(sliceRows[k], e.message);
                stillFailed.push(idx);
            });
        }
        const okCount = total - stillFailed.length - (indexes.length - start - sliceIdxs.length);
        correctProgress.textContent =
            `Corrected ${okCount}/${total} (${label}) — changed ${changed}${stillFailed.length ? `, fail ${stillFailed.length}` : ""}`;
    }
    return stillFailed;
}

runCorrectBtn.addEventListener("click", async () => {
    buildCompareTable();
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) return;

    // ใช้ engine เดียวกับ translate (Apple → fallback เป็น qwen ฝั่ง backend)
    const engine = translateEngineSel.value;
    const customRules = (customRulesEl.value || "").trim();
    const rawBatch = parseInt(document.getElementById("batchSize").value || "1", 10);
    const effectiveBatch = (rawBatch === 0) ? rows.length : Math.max(1, rawBatch);
    const useBatch = (engine === "qwen" || engine === "gemini") && effectiveBatch > 1;
    const batchLabel = (rawBatch === 0) ? `entire file (${rows.length})` : String(effectiveBatch);

    correctRunning = true;
    correctAbort = false;
    runCorrectBtn.disabled = true;
    document.getElementById("runTranslateBtn").disabled = true;
    retryFailedBtn.disabled = true;
    stopCorrectBtn.disabled = false;

    lastFailedIndexes = [];
    lastBatchUsed = effectiveBatch;
    lastCustomRules = customRules;
    lastOperationType = "correct";
    lastAttempt = 0;

    const total = rows.length;

    if (useBatch) {
        const allIdx = Array.from({length: rows.length}, (_, i) => i);
        const failed = await _processCorrectBatch(
            rows, allIdx, effectiveBatch, engine, customRules, 0, `batch=${batchLabel}`
        );
        lastFailedIndexes = failed;
    } else {
        // non-batch engine (apple/nllb) → ส่ง /correct ทีละ row พร้อม before/after context
        let done = 0, changed = 0, errors = 0;
        const contextWindow = [];
        const allOrigs = rows.map(r => r.dataset.orig || '');

        for (let idx = 0; idx < rows.length; idx++) {
            if (correctAbort) break;
            const row = rows[idx];
            const orig = row.dataset.orig || row.querySelector(".col-original").textContent;
            // ข้าม empty
            if (!orig || !orig.trim()) {
                _applyCorrectResult(row, orig, orig);
                contextWindow.push(orig);
                done++;
                continue;
            }
            _markCorrectPending(row);
            try {
                const before = contextWindow.slice(-5);
                const after = allOrigs.slice(idx + 1, idx + 6);
                const data = await correctOne(orig, before, after, engine, customRules);
                if (data.error) {
                    _applyCorrectError(row, data.error);
                    errors++;
                    contextWindow.push(orig);
                } else {
                    const corr = data.corrected || "";
                    if (_applyCorrectResult(row, orig, corr)) changed++;
                    contextWindow.push(corr);
                }
            } catch (e) {
                _applyCorrectError(row, e.message);
                errors++;
                contextWindow.push(orig);
            }
            done++;
            correctProgress.textContent = `${done}/${total} — changed ${changed}, fail ${errors}`;
        }
    }

    // sync visual preview to show corrections
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();

    correctRunning = false;
    runCorrectBtn.disabled = false;
    document.getElementById("runTranslateBtn").disabled = false;
    stopCorrectBtn.disabled = true;
    updateRetryButton();
});

stopCorrectBtn.addEventListener("click", () => {
    correctAbort = true;
    stopCorrectBtn.disabled = true;
});

clearCorrectBtn.addEventListener("click", () => {
    Object.keys(corrections).forEach(k => delete corrections[k]);
    Object.keys(translations).forEach(k => delete translations[k]);
    manualEdits.clear();
    manualTranslations.clear();
    buildCompareTable(true);
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});

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

// อัปเดตหน้าตา row หลังแก้ไข — re-render diff + state
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

// Event delegation: คลิก/แก้ cell ใน column corrected หรือ translated
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
        // ว่าง → ลบค่า, คืน placeholder
        if (ref) {
            if (isCorrected) {
                delete corrections[ref];
                manualEdits.delete(ref);
            } else {
                delete translations[ref];
                manualTranslations.delete(ref);
            }
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

    // sync visual preview ทันที (เผื่ออยู่แท็บนั้น)
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});
compareArea.addEventListener("keydown", (e) => {
    const cell = e.target.closest && e.target.closest("td.col-corrected, td.col-translated");
    if (!cell) return;
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        cell.blur();
    } else if (e.key === "Escape") {
        e.preventDefault();
        cell.blur();
    }
});

async function translateOne(text, target, engine) {
    const res = await fetch("/translate", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ text, target, engine: engine || "qwen" }),
    });
    return res.json();
}

async function translateBatchCall(texts, target, engine, customRules, attempt, speakers, ids) {
    // ถ้าไม่ส่ง speakers ให้ default = character แรก ทุกชิ้น
    const defaultId = (getCharacters()[0] && getCharacters()[0].id) || "";
    const speakerArr = speakers || texts.map(() => defaultId);
    const res = await fetch("/translate-batch", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            texts, target,
            engine: engine || "qwen",
            custom_rules: customRules || "",
            attempt: attempt || 0,
            speakers: speakerArr,
            characters: getCharacters(),
            ids: ids || null,
        }),
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
    }
    return res.json();
}

// แสดง/ซ่อน batch size + retry button ตาม engine (Apple ไม่รองรับ batch)
const translateEngineSel = document.getElementById("translateEngine");
const batchSizeLabel = document.getElementById("batchSizeLabel");
const batchSizeInput = document.getElementById("batchSize");
const retryFailedBtn = document.getElementById("retryFailedBtn");
const engineHint = document.getElementById("engineHint");
const customRulesEl = document.getElementById("customRules");

// ───────── Translation Memory (TM) controls ─────────
const tmSuggestBtn = document.getElementById("tmSuggestBtn");
const tmBuildBtn = document.getElementById("tmBuildBtn");
const tmPairSel = document.getElementById("tmPair");
const tmFinalKEl = document.getElementById("tmFinalK");
const tmStatusEl = document.getElementById("tmStatus");

function _tmCollectSources() {
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    return rows.map(_rowSource).filter(s => s && s.trim());
}

const TM_BLOCK_BEGIN = "=== TM Suggestions (auto-generated — re-run to refresh) ===";
const TM_BLOCK_END = "=== End TM Suggestions ===";

function _replaceTmBlock(textarea, tmText) {
    const cur = textarea.value || "";
    const beginIdx = cur.indexOf(TM_BLOCK_BEGIN);
    const endIdx = cur.indexOf(TM_BLOCK_END);
    const newBlock = `${TM_BLOCK_BEGIN}\n${tmText}\n${TM_BLOCK_END}`;
    if (beginIdx >= 0 && endIdx > beginIdx) {
        const before = cur.slice(0, beginIdx).replace(/\s+$/, "");
        const after = cur.slice(endIdx + TM_BLOCK_END.length).replace(/^\s+/, "");
        textarea.value = [before, newBlock, after].filter(s => s).join("\n\n");
    } else {
        const userPart = cur.trim();
        textarea.value = userPart ? userPart + "\n\n" + newBlock : newBlock;
    }
}

async function tmSuggest() {
    const sources = _tmCollectSources();
    if (!sources.length) {
        tmStatusEl.textContent = "no OCR rows yet — convert a file first";
        tmStatusEl.style.color = COLORS.errorStrong;
        return;
    }
    const pair = tmPairSel.value || "en-vn";
    const finalK = parseInt(tmFinalKEl.value, 10) || 20;
    tmSuggestBtn.disabled = true;
    tmStatusEl.style.color = COLORS.textMuted;
    tmStatusEl.textContent = `embedding ${sources.length} queries…`;
    try {
        const res = await fetch("/tm/suggest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts: sources, pair, final_k: finalK, auto_build: true }),
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 300);
            throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
        }
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const stats = data.stats || {};
        if (!data.rules_text) {
            tmStatusEl.textContent = `no matches (n_index_rows=${stats.n_index_rows || "?"})`;
            tmStatusEl.style.color = COLORS.errorStrong;
            return;
        }
        _replaceTmBlock(customRulesEl, data.rules_text);
        tmStatusEl.style.color = COLORS.successStrong;
        tmStatusEl.textContent = `${stats.n_returned} rules from ${stats.n_queries} queries (index=${stats.n_index_rows})`;
        const dbg = data.per_query_debug || [];
        if (dbg.length) {
            const sample = dbg.slice(0, 5).map((d, i) => {
                const q = (d.q || "").slice(0, 60);
                const s = (d.top_score != null) ? d.top_score.toFixed(3) : "-";
                const t = (d.top_source || "").slice(0, 60);
                return `[q${i}] "${q}…" → score=${s} | "${t}…"`;
            }).join("\n");
            console.log("[TM] per-query top hits:\n" + sample);
            tmStatusEl.title = sample + (dbg.length > 5 ? `\n…(+${dbg.length - 5} more)` : "");
        }
        if (Array.isArray(data.hits) && data.hits.length) {
            console.log(`[TM] final ${data.hits.length} hits (sorted by final_score desc):`);
            console.table(data.hits.map(h => ({
                final: h.final_score,
                cos: h.max_score,
                lex: h.lex_score,
                abs: h.abs_overlap,
                len: h.src_len,
                hits: h.n_hits,
                row: h.row,
                source: (h.source || "").slice(0, 80),
            })));
        }
    } catch (err) {
        tmStatusEl.style.color = COLORS.errorStrong;
        tmStatusEl.textContent = "error: " + err.message;
    } finally {
        tmSuggestBtn.disabled = false;
    }
}

async function tmBuild() {
    if (!confirm("Rebuild ALL TM indexes (every pair folder under data_tm/)? This calls the embedding model for every TU and can take several minutes per pair.")) return;
    tmBuildBtn.disabled = true;
    tmStatusEl.style.color = COLORS.textMuted;
    tmStatusEl.textContent = "building all indexes…";
    try {
        const res = await fetch("/tm/build", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 300);
            throw new Error(`HTTP ${res.status} (non-JSON): ${body}`);
        }
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const ms = data.manifests || [];
        const summary = ms.map(m => `${m.pair}(n=${m.n_rows})`).join(", ");
        tmStatusEl.style.color = COLORS.successStrong;
        tmStatusEl.textContent = `built ✓ pairs=${ms.length} → ${summary}`;
    } catch (err) {
        tmStatusEl.style.color = COLORS.errorStrong;
        tmStatusEl.textContent = "build error: " + err.message;
    } finally {
        tmBuildBtn.disabled = false;
    }
}

tmSuggestBtn.addEventListener("click", tmSuggest);
tmBuildBtn.addEventListener("click", tmBuild);

let _prevEngine = null;  // track engine ก่อนหน้า — เปลี่ยนแล้วค่อย reset batch default
function syncBatchVisibility() {
    const eng = translateEngineSel.value;
    const supportsBatch = (eng === "qwen" || eng === "gemini");
    batchSizeLabel.style.display = supportsBatch ? "inline-flex" : "none";
    retryFailedBtn.style.display = supportsBatch ? "" : "none";
    if (eng === "qwen") {
        engineHint.textContent = "qwen2.5:1.5b via Ollama";
    } else if (eng === "gemini") {
        engineHint.textContent = `Gemini (${_config.geminiModel || "gemini-2.5-flash"})`;
    } else if (eng === "nllb") {
        engineHint.textContent = "NLLB-200 distilled-600M (local)";
    } else {
        engineHint.textContent = "Apple Translate (Shortcuts CLI)";
    }
    // Gemini ใช้ทั้งไฟล์ (context ใหญ่ + rate limit ตึง), Qwen ใช้ batch default จาก config
    if (eng !== _prevEngine) {
        if (eng === "gemini") batchSizeInput.value = "0";
        else if (eng === "qwen") batchSizeInput.value = String(_config.batchSizeDefault);
        _prevEngine = eng;
    }
}
translateEngineSel.addEventListener("change", syncBatchVisibility);
syncBatchVisibility();

// state สำหรับ manual retry — เก็บไว้ระหว่าง click
let lastFailedIndexes = [];   // row indexes ที่ fail หลัง run ล่าสุด
let lastBatchUsed = 0;        // batch size ที่เพิ่งใช้
let lastTranslateTarget = "th";
let lastCustomRules = "";     // rules ที่ใช้ตอน run ล่าสุด — retry ใช้ตัวเดียวกัน
let lastOperationType = "translate";  // "translate" | "correct"
let lastAttempt = 0;          // attempt counter — เพิ่มขึ้นทุก retry → backend ปรับ temp ให้ result ต่าง

// Gemini rate-limit (5 RPM free tier) — กัน quota หมด, delay จาก _config.geminiDelayMs
let _lastGeminiCallAt = 0;
async function _geminiThrottle(engine) {
    const delay = _config.geminiDelayMs;
    if (engine !== "gemini" || delay <= 0) return;
    const elapsed = Date.now() - _lastGeminiCallAt;
    if (elapsed < delay) {
        const wait = delay - elapsed;
        correctProgress.textContent = `⏳ wait ${(wait/1000).toFixed(1)}s (Gemini rate limit)...`;
        await new Promise(r => setTimeout(r, wait));
    }
}
function _geminiTouch(engine) {
    if (engine === "gemini") _lastGeminiCallAt = Date.now();
}

// ตรวจ 429 จาก error string — return delay ms ที่ต้องรอ (0 = ไม่ใช่ 429)
function _parse429RetrySec(errMsg) {
    if (!errMsg || typeof errMsg !== "string") return 0;
    if (!errMsg.includes("RESOURCE_EXHAUSTED") && !errMsg.includes("429")) return 0;
    const m = errMsg.match(/retry in ([\d.]+)s/i) || errMsg.match(/retryDelay['"]?\s*[:=]\s*['"]?(\d+)s/i);
    if (m) return Math.ceil(parseFloat(m[1])) * 1000 + 1000;  // +1s buffer
    return 30000;  // fallback 30s
}

function updateRetryButton() {
    const n = lastFailedIndexes.length;
    const ICON = '<span class="material-symbols-outlined">replay</span>';
    if (n === 0) {
        retryFailedBtn.disabled = true;
        retryFailedBtn.innerHTML = `${ICON}retry fail`;
    } else {
        retryFailedBtn.disabled = false;
        const engine = translateEngineSel.value;
        const nextBatch = engine === "gemini"
            ? lastBatchUsed
            : Math.max(2, Math.floor(lastBatchUsed / 2));
        const opLabel = lastOperationType === "correct" ? "correct" : "translate";
        retryFailedBtn.innerHTML = `${ICON}retry ${opLabel} (${n}) batch=${nextBatch}`;
    }
}

function _rowSource(row) {
    const ref = row.dataset.ref;
    const orig = row.dataset.orig || "";
    return (ref && corrections[ref] !== undefined) ? corrections[ref] : orig;
}
function _markPending(row) {
    const cell = row.querySelector(".col-translated");
    cell.classList.add("pending");
    cell.classList.remove("error");
    cell.removeAttribute("title");
    cell.textContent = "Translating...";
    row.classList.add("active");
}
function _applySuccess(row, translated, warning) {
    const cell = row.querySelector(".col-translated");
    cell.classList.remove("pending", "error", "warning");
    if (warning) {
        cell.classList.add("warning");
        cell.title = "⚠ " + warning;
    } else {
        cell.removeAttribute("title");
    }
    row.classList.remove("active");
    cell.textContent = translated;
    const ref = row.dataset.ref;
    if (ref) translations[ref] = translated;
}
function _applyError(row, errMsg) {
    const cell = row.querySelector(".col-translated");
    cell.classList.remove("pending", "warning");
    cell.classList.add("error");
    // ไม่กรอก error ลง field — เคลียร์เนื้อหาเหลือ placeholder, error ใส่ tooltip
    cell.textContent = "—";
    cell.title = "❌ " + errMsg;
    row.classList.remove("active");
}

// ส่ง batch สำหรับ index list — return list ของ index ที่ยัง fail
async function _processBatch(rows, indexes, batchSz, target, engine, customRules, attempt, label) {
    // pre-filter: empty source → set translation = "" ไม่ต้องส่ง LLM (กัน token เปล่า)
    const workIndexes = [];
    let skippedEmpty = 0;
    for (const idx of indexes) {
        const src = _rowSource(rows[idx]);
        if (!src || !src.trim()) {
            _applySuccess(rows[idx], "");
            skippedEmpty++;
        } else {
            workIndexes.push(idx);
        }
    }
    indexes = workIndexes;
    if (skippedEmpty > 0) {
        console.log(`[translate] skipped ${skippedEmpty} empty rows`);
    }

    const stillFailed = [];
    const total = rows.length;
    for (let start = 0; start < indexes.length; start += batchSz) {
        if (correctAbort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        const sliceIdxs = indexes.slice(start, start + batchSz);
        const sliceRows = sliceIdxs.map(i => rows[i]);
        const sources = sliceRows.map(_rowSource);
        const defaultId = (getCharacters()[0] && getCharacters()[0].id) || "";
        const sliceSpeakers = sliceRows.map(r => speakerByRef[r.dataset.ref] || defaultId);
        sliceRows.forEach(_markPending);
        // throttle Gemini (rate limit 5 RPM ของ free tier)
        await _geminiThrottle(engine);
        if (correctAbort) {
            stillFailed.push(...indexes.slice(start));
            break;
        }
        try {
            const sliceIds = sliceIdxs.map(idx => idx + 1);
            const data = await translateBatchCall(sources, target, engine, customRules, attempt, sliceSpeakers, sliceIds);
            _geminiTouch(engine);
            // 429 detection ระดับ batch
            const errSample = data.error || (data.errors || []).find(e => e);
            const wait429 = _parse429RetrySec(errSample);
            if (wait429 > 0) {
                sliceIdxs.forEach((idx, k) => {
                    _applyError(sliceRows[k], `quota exceeded — wait ${(wait429/1000).toFixed(0)}s then click retry`);
                    stillFailed.push(idx);
                });
                correctProgress.textContent = `⛔ Gemini quota exceeded — stopping; wait ${(wait429/1000).toFixed(0)}s before retry`;
                stillFailed.push(...indexes.slice(start + sliceIdxs.length));
                break;
            }
            if (data.error) {
                sliceIdxs.forEach((idx, k) => {
                    _applyError(sliceRows[k], data.error);
                    stillFailed.push(idx);
                });
            } else {
                const arr = data.translated || [];
                const errs = data.errors || [];
                sliceIdxs.forEach((idx, k) => {
                    const tr = arr[k] ?? "";
                    const er = errs[k];
                    if (tr && er) {
                        // warning — apply LLM output แต่ flag ให้ user เห็น
                        _applySuccess(sliceRows[k], tr, er);
                    } else if (er) {
                        _applyError(sliceRows[k], er);
                        stillFailed.push(idx);
                    } else {
                        _applySuccess(sliceRows[k], tr);
                    }
                });
            }
        } catch (e) {
            _geminiTouch(engine);
            sliceIdxs.forEach((idx, k) => {
                _applyError(sliceRows[k], e.message);
                stillFailed.push(idx);
            });
        }
        const okCount = total - stillFailed.length - (indexes.length - start - sliceIdxs.length);
        correctProgress.textContent =
            `Translated ${okCount}/${total} (${label})${stillFailed.length ? ` — fail ${stillFailed.length}` : ""}`;
    }
    return stillFailed;
}

document.getElementById("runTranslateBtn").addEventListener("click", async () => {
    buildCompareTable();
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) return;
    const target = document.getElementById("translateTarget").value;
    const engine = translateEngineSel.value;
    const rawBatch = parseInt(document.getElementById("batchSize").value || "1", 10);
    const effectiveBatch = (rawBatch === 0) ? rows.length : Math.max(1, rawBatch);
    const useBatch = (engine === "qwen" || engine === "gemini") && effectiveBatch > 1;
    const batchLabel = (rawBatch === 0) ? `entire file (${rows.length})` : String(effectiveBatch);

    correctRunning = true;
    correctAbort = false;
    runCorrectBtn.disabled = true;
    document.getElementById("runTranslateBtn").disabled = true;
    retryFailedBtn.disabled = true;
    stopCorrectBtn.disabled = false;

    const customRules = (customRulesEl.value || "").trim();
    lastFailedIndexes = [];
    lastBatchUsed = effectiveBatch;
    lastTranslateTarget = target;
    lastCustomRules = customRules;
    lastOperationType = "translate";
    lastAttempt = 0;

    const total = rows.length;
    let errors = 0;

    if (useBatch) {
        const allIdx = Array.from({length: rows.length}, (_, i) => i);
        const failed = await _processBatch(
            rows, allIdx, effectiveBatch, target, engine, customRules, 0, `batch=${batchLabel}`
        );
        lastFailedIndexes = failed;
        errors = failed.length;
    } else {
        let done = 0, skipped = 0;
        for (const row of rows) {
            if (correctAbort) break;
            const ref = row.dataset.ref;
            if (ref && speakerByRef[ref] === SPEAKER_SKIP) {
                _applySuccess(row, "");
                done++; skipped++;
                correctProgress.textContent = `Translated ${done}/${total} — skipped ${skipped}${errors ? `, fail ${errors}` : ""}`;
                continue;
            }
            const source = _rowSource(row);
            if (!source || !source.trim()) {
                _applySuccess(row, "");
                done++;
                correctProgress.textContent = `Translated ${done}/${total}${errors ? ` — fail ${errors}` : ""}`;
                continue;
            }
            _markPending(row);
            try {
                const data = await translateOne(source, target, engine);
                if (data.error) { _applyError(row, data.error); errors++; }
                else { _applySuccess(row, data.translated || ""); }
            } catch (e) {
                _applyError(row, e.message); errors++;
            }
            done++;
            correctProgress.textContent = `Translated ${done}/${total}${skipped ? ` — skipped ${skipped}` : ""}${errors ? `, fail ${errors}` : ""}`;
        }
    }

    correctRunning = false;
    runCorrectBtn.disabled = false;
    document.getElementById("runTranslateBtn").disabled = false;
    stopCorrectBtn.disabled = true;
    updateRetryButton();
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});

// Retry button — ผู้ใช้กดเอง กัน token ระเบิด, dispatch ตาม operation ล่าสุด
retryFailedBtn.addEventListener("click", async () => {
    if (!lastFailedIndexes.length) return;
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    const engine = translateEngineSel.value;
    const target = document.getElementById("translateTarget").value;
    lastTranslateTarget = target;
    const nextBatch = engine === "gemini"
        ? lastBatchUsed
        : Math.max(2, Math.floor(lastBatchUsed / 2));
    const nextAttempt = lastAttempt + 1;

    correctRunning = true;
    correctAbort = false;
    runCorrectBtn.disabled = true;
    document.getElementById("runTranslateBtn").disabled = true;
    retryFailedBtn.disabled = true;
    stopCorrectBtn.disabled = false;

    const idxs = lastFailedIndexes.slice();
    let failed;
    if (lastOperationType === "correct") {
        failed = await _processCorrectBatch(
            rows, idxs, nextBatch, engine, lastCustomRules, nextAttempt,
            `retry#${nextAttempt} correct batch=${nextBatch}`
        );
    } else {
        failed = await _processBatch(
            rows, idxs, nextBatch, target, engine, lastCustomRules, nextAttempt,
            `retry#${nextAttempt} translate batch=${nextBatch}`
        );
    }
    lastFailedIndexes = failed;
    lastBatchUsed = nextBatch;
    lastAttempt = nextAttempt;

    correctRunning = false;
    runCorrectBtn.disabled = false;
    document.getElementById("runTranslateBtn").disabled = false;
    stopCorrectBtn.disabled = true;
    updateRetryButton();
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});

window.addEventListener("resize", () => {
    if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
});

// ───────── Preview prompt modal ─────────
const previewPromptBtn = document.getElementById("previewPromptBtn");
let previewModal = null;
// state จาก fetchPreview ครั้งล่าสุด — ใช้ตอน manual apply ส่ง texts/speakers/target ชุดเดิม
let _previewSource = null;

function openPreviewModal(data, sourceState, totalRows) {
    if (!previewModal) {
        previewModal = document.createElement("div");
        previewModal.className = "modal-backdrop";
        previewModal.innerHTML = `
            <div class="modal-card" role="dialog" style="max-width: 900px; max-height: 90vh;">
                <h2><span class="material-symbols-outlined">search</span>Preview prompt — payload that will be sent to the LLM</h2>
                <div id="previewMeta" style="font-size:12px; color:${COLORS.textStrong}; margin-bottom:8px; padding:8px 10px; background:${COLORS.bgLight}; border-radius:6px;"></div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:8px 0; padding:8px 10px; background:${COLORS.warningBg}; border-radius:6px; font-size:12px;">
                    <label>chunk size:
                        <input type="number" id="previewChunkSize" min="1" style="width:80px; padding:4px 6px; border:1px solid ${COLORS.border}; border-radius:4px; margin-left:4px;" />
                    </label>
                    <span style="color:${COLORS.textStrong};">·</span>
                    <label>chunk
                        <input type="number" id="previewChunkIdx" min="1" style="width:70px; padding:4px 6px; border:1px solid ${COLORS.border}; border-radius:4px; margin:0 4px;" />
                        <span style="color:${COLORS.textMuted};">/ <span id="previewChunkTotal">?</span></span>
                    </label>
                    <button type="button" id="previewPrevBtn" class="ghost" style="font-size:12px; padding:4px 8px;"><span class="material-symbols-outlined">chevron_left</span></button>
                    <button type="button" id="previewNextBtn" class="ghost" style="font-size:12px; padding:4px 8px;"><span class="material-symbols-outlined">chevron_right</span></button>
                    <button type="button" id="previewRefreshBtn" class="ghost" style="font-size:12px;"><span class="material-symbols-outlined">refresh</span>Reload</button>
                    <span id="previewRangeNote" style="color:${COLORS.textStrong};"></span>
                    <span id="previewRefreshStatus" style="color:${COLORS.textMuted};"></span>
                </div>
                <div style="display:flex; gap:8px; align-items:center; margin:8px 0; padding:8px 10px; background:${COLORS.errorBg}; border-radius:6px; font-size:12px;">
                    <strong style="color:${COLORS.errorTitle};">retry fail:</strong>
                    <span id="previewFailedNote" style="color:${COLORS.textStrong};">— No failed rows yet</span>
                    <button type="button" id="previewLoadFailedBtn" class="ghost" style="font-size:12px;" disabled><span class="material-symbols-outlined">place</span>Load all retry-fail rows</button>
                    <span id="previewFailedMode" style="color:${COLORS.errorTitle}; font-weight:600;"></span>
                </div>
                <div style="display:flex; gap:6px; margin:8px 0;">
                    <button type="button" id="previewCopyAllBtn" class="ghost" style="font-size:12px;"><span class="material-symbols-outlined">content_copy</span>Copy request body</button>
                </div>
                <h3 style="font-size:13px; margin:12px 0 4px;"><span class="material-symbols-outlined">outbox</span>RAW REQUEST BODY sent to LLM API</h3>
                <div id="previewEndpoint" style="font-size:11px; color:${COLORS.textStrong}; margin-bottom:4px; font-family: ui-monospace, Menlo, monospace;"></div>
                <pre id="previewBody" style="background:${COLORS.codeBg}; color:${COLORS.codeText}; padding:10px; border-radius:6px; font-size:11px; max-height:400px; overflow:auto; white-space:pre-wrap; word-break:break-word;"></pre>
                <h3 style="font-size:13px; margin:12px 0 4px; display:none;">CHARACTERS array (raw JSON)</h3>
                <pre id="previewChars" style="background:${COLORS.warningBg}; color:${COLORS.codeAltText}; padding:10px; border-radius:6px; font-size:11px; max-height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; display:none;"></pre>
                <h3 style="font-size:13px; margin:12px 0 4px; display:none;">SYSTEM PROMPT (readable)</h3>
                <pre id="previewSystem" style="background:${COLORS.promptBg}; color:${COLORS.promptText}; padding:10px; border-radius:6px; font-size:11px; max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-word; display:none;"></pre>
                <h3 style="font-size:13px; margin:12px 0 4px; display:none;">USER MESSAGE (readable)</h3>
                <pre id="previewUser" style="background:${COLORS.promptBg}; color:${COLORS.primaryLight}; padding:10px; border-radius:6px; font-size:11px; max-height:300px; overflow:auto; white-space:pre-wrap; word-break:break-word; display:none;"></pre>
                <h3 style="font-size:13px; margin:16px 0 4px;"><span class="material-symbols-outlined">content_paste_go</span>Paste LLM response (manual apply)</h3>
                <div style="font-size:11px; color:${COLORS.textMuted}; margin-bottom:4px;">
                    Copy the request body above → paste into Gemini/ChatGPT/Claude web UI → copy the response back here → click "Apply to table". Markdown fences (\`\`\`json ... \`\`\`) are supported.
                </div>
                <textarea id="previewManualResponse" rows="6" style="width:100%; font-family: ui-monospace, Menlo, monospace; font-size:11px; padding:8px; border:1px solid ${COLORS.border}; border-radius:6px; resize:vertical; box-sizing:border-box;" placeholder='{"items":[{"id":1,"text":"..."}, {"id":2,"text":"..."}]}'></textarea>
                <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                    <button type="button" id="previewApplyManualBtn">Apply to table</button>
                    <span id="previewManualStatus" style="font-size:12px; color:${COLORS.textMuted};"></span>
                </div>
                <div class="modal-foot">
                    <span style="font-size:11px; color:${COLORS.textMuted};">This is the actual payload the backend will send to the LLM API when you click translate.</span>
                    <button type="button" id="previewCloseBtn">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(previewModal);
        previewModal.addEventListener("click", (e) => {
            if (e.target === previewModal) previewModal.classList.remove("show");
        });
        document.getElementById("previewCloseBtn").addEventListener("click", () => previewModal.classList.remove("show"));
        document.getElementById("previewCopyAllBtn").addEventListener("click", async () => {
            const body = document.getElementById("previewBody").textContent;
            const btnEl = document.getElementById("previewCopyAllBtn");
            const origHTML = btnEl.innerHTML;
            try {
                await navigator.clipboard.writeText(body);
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
    _previewSource = sourceState || null;
    document.getElementById("previewManualResponse").value = "";
    document.getElementById("previewManualStatus").textContent = "";
    document.getElementById("previewManualStatus").style.color = COLORS.textMuted;
    const sizeInput = document.getElementById("previewChunkSize");
    const idxInput = document.getElementById("previewChunkIdx");
    const totalSpan = document.getElementById("previewChunkTotal");
    const rangeNote = document.getElementById("previewRangeNote");
    const failedNote = document.getElementById("previewFailedNote");
    const failedCount = lastFailedIndexes ? lastFailedIndexes.length : 0;
    const failedBtn = document.getElementById("previewLoadFailedBtn");
    const failedMode = document.getElementById("previewFailedMode");
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
    if (sizeInput) {
        sizeInput.value = size;
        sizeInput.max = total;
        sizeInput.disabled = !!isFailed;
    }
    if (idxInput) {
        idxInput.value = idx;
        idxInput.max = totalChunks;
        idxInput.disabled = !!isFailed;
    }
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
                // warning — มี translation จาก LLM แต่ guard ทักท้วง → apply + flag ให้ user เห็น
                _applySuccess(row, tr, er);
                warn++;
            } else if (tr) {
                _applySuccess(row, tr);
                ok++;
            } else if (er) {
                _applyError(row, er);
                fail++;
            } else {
                // id ไม่อยู่ใน response (paste ไม่ครบ) — เก็บ row เดิมไว้
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
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) {
        alert("No rows in the table — upload a file first");
        return;
    }
    if (mode === "failed" && (!lastFailedIndexes || !lastFailedIndexes.length)) {
        alert("No failed rows yet");
        return;
    }
    const target = document.getElementById("translateTarget").value;
    const engine = translateEngineSel.value;
    const customRules = (customRulesEl.value || "").trim();
    const defaultId = (getCharacters()[0] && getCharacters()[0].id) || "";

    let indices;
    let id_start;
    let size;
    let idx;
    let totalChunks;
    let offset;
    let totalShown;
    if (mode === "failed") {
        indices = lastFailedIndexes.slice();
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
    const workRows = indices.map(i => rows[i]);

    const texts = workRows.map(r => {
        const ref = r.dataset.ref;
        const orig = r.dataset.orig || "";
        return (corrections[ref] !== undefined) ? corrections[ref] : orig;
    });
    const speakerArr = workRows.map(r => speakerByRef[r.dataset.ref] || defaultId);
    const idsArr = indices.map(i => i + 1);  // ids = global row numbers (1-based)

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
                characters: getCharacters(),
                id_start: id_start,
                ids: idsArr,
            }),
        });
        const data = await res.json();
        if (data.error) {
            if (refreshStatus) refreshStatus.textContent = "";
            alert("Error: " + data.error);
            return;
        }
        openPreviewModal(
            data,
            { texts, target, speakers: speakerArr, characters: getCharacters(), indices, ids: idsArr, id_start, mode: mode || "chunk", chunkSize: size, chunkIdx: idx },
            totalShown
        );
    } catch (e) {
        if (refreshStatus) refreshStatus.textContent = "";
        alert("Error: " + e.message);
    }
}

previewPromptBtn.addEventListener("click", fetchPreview);

// ───────── One-click Copy prompt / Paste LLM response ─────────
const copyPromptBtn = document.getElementById("copyPromptBtn");
const pastePromptBtn = document.getElementById("pastePromptBtn");

// แสดงข้อความ flash บน button ชั่วคราว แล้วคืน HTML เดิม (รวม Material Symbols icon span)
function _flashBtn(btn, msg, ms) {
    if (btn.dataset.flashing) return;  // กันกดรัวๆ ทับ origHTML
    btn.dataset.flashing = "1";
    const orig = btn.innerHTML;
    btn.innerHTML = `<span class="material-symbols-outlined">check</span>${msg}`;
    setTimeout(() => {
        btn.innerHTML = orig;
        delete btn.dataset.flashing;
    }, ms || 1800);
}

async function copyPromptOneClick() {
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!rows.length) { alert("No rows in the table — upload a file first"); return; }
    const target = document.getElementById("translateTarget").value;
    const engine = translateEngineSel.value;
    const customRules = (customRulesEl.value || "").trim();
    const defaultId = (getCharacters()[0] && getCharacters()[0].id) || "";

    const indices = rows.map((_, i) => i);
    const texts = rows.map(r => {
        const ref = r.dataset.ref;
        const orig = r.dataset.orig || "";
        return (corrections[ref] !== undefined) ? corrections[ref] : orig;
    });
    const speakerArr = rows.map(r => speakerByRef[r.dataset.ref] || defaultId);
    const idsArr = indices.map(i => i + 1);

    correctProgress.textContent = "⏳ Building prompt...";
    try {
        const res = await fetch("/translate-batch/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                texts, target, engine,
                custom_rules: customRules,
                speakers: speakerArr,
                characters: getCharacters(),
                id_start: 1,
                ids: idsArr,
            }),
        });
        const data = await res.json();
        if (data.error) { correctProgress.textContent = "Error: " + data.error; return; }
        const body = JSON.stringify(data.request_body || {}, null, 2);
        await navigator.clipboard.writeText(body);
        correctProgress.textContent = `✓ Copied prompt (${rows.length} rows) → paste into LLM`;
        _flashBtn(copyPromptBtn, "Copied");
    } catch (e) {
        correctProgress.textContent = "Error: " + e.message;
    }
}

async function pastePromptOneClick() {
    const allRows = Array.from(compareArea.querySelectorAll("tbody tr"));
    if (!allRows.length) { alert("No rows in the table — upload a file first"); return; }

    let raw;
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        correctProgress.textContent = "Cannot read clipboard: " + e.message;
        return;
    }
    if (!raw || !raw.trim()) {
        correctProgress.textContent = "Clipboard is empty";
        return;
    }

    // build state จาก table ปัจจุบัน — ไม่ต้องพึ่ง _previewSource (กดได้เลย)
    const target = document.getElementById("translateTarget").value;
    const defaultId = (getCharacters()[0] && getCharacters()[0].id) || "";
    const indices = allRows.map((_, i) => i);
    const texts = allRows.map(r => {
        const ref = r.dataset.ref;
        const orig = r.dataset.orig || "";
        return (corrections[ref] !== undefined) ? corrections[ref] : orig;
    });
    const speakerArr = allRows.map(r => speakerByRef[r.dataset.ref] || defaultId);
    const idsArr = indices.map(i => i + 1);

    correctProgress.textContent = "⏳ Applying response...";
    try {
        const res = await fetch("/translate-batch/apply-manual", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                texts, target,
                speakers: speakerArr,
                characters: getCharacters(),
                raw_response: raw,
                id_start: 1,
                ids: idsArr,
            }),
        });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
            const body = (await res.text()).slice(0, 200);
            throw new Error(`HTTP ${res.status}: ${body}`);
        }
        const data = await res.json();
        if (data.error) { correctProgress.textContent = "Error: " + data.error; return; }

        const tArr = data.translated || [];
        const errors = data.errors || [];
        let ok = 0, warn = 0, fail = 0, skip = 0, notInResp = 0;
        for (let i = 0; i < tArr.length && i < indices.length; i++) {
            const row = allRows[indices[i]];
            if (!row) break;
            const ref = row.dataset.ref;
            const isUserSkip = ref && speakerByRef[ref] === SPEAKER_SKIP;
            const isEmptySource = !((texts[i] || "").trim());
            const tr = tArr[i];
            const er = errors[i];
            if (isUserSkip || isEmptySource) {
                skip++;
            } else if (tr && er) {
                _applySuccess(row, tr, er);
                warn++;
            } else if (tr) {
                _applySuccess(row, tr);
                ok++;
            } else if (er) {
                _applyError(row, er);
                fail++;
            } else {
                notInResp++;
            }
        }
        const parts = [`applied ${ok}`];
        if (warn) parts.push(`warn ${warn}`);
        if (fail) parts.push(`fail ${fail}`);
        if (skip) parts.push(`skipped ${skip}`);
        if (notInResp) parts.push(`not in response ${notInResp}`);
        correctProgress.textContent = parts.join(", ");
        _flashBtn(pastePromptBtn, "Applied");
        if (document.querySelector(".tab.active").dataset.tab === "visual") renderPreview();
    } catch (e) {
        correctProgress.textContent = "Error: " + e.message;
    }
}

copyPromptBtn.addEventListener("click", copyPromptOneClick);
pastePromptBtn.addEventListener("click", pastePromptOneClick);


// ── public API ──

// initCompare — เซ็ต config จาก Jinja-rendered values + re-apply batch default ตาม engine
export function initCompare(config) {
    Object.assign(_config, config || {});
    _prevEngine = null;          // force re-apply batch default ใน syncBatchVisibility
    syncBatchVisibility();
}

// resetCompareUI — เรียกตอน upload ไฟล์ใหม่: ล้าง table + progress + retry state
export function resetCompareUI() {
    lastFailedIndexes = [];
    compareArea.innerHTML = '<div class="empty">Processing...</div>';
    correctProgress.textContent = "";
    updateRetryButton();
}

export { buildCompareTable };

// ───────── Speaker dropdown change in Compare table ─────────
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
