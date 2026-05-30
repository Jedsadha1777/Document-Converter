// Detect speaker + emotion per row — copy/paste workflow ผ่าน external LLM (Gemini web ฯลฯ)
// Pattern เดียวกับ characters detect (📋 Copy / 📥 Paste) แต่ทำที่ระดับ row metadata

import { state } from "./state.js";
import { getCharacters } from "./characters.js";
import { getEmotionList, EMOTION_AUTO } from "./emotions.js";
import { buildCompareTable } from "./compare.js";

const _PAIR_TO_TARGET = { "jp-th": "th", "en-th": "th", "en-vn": "vi" };
function _currentEmotionTarget() {
    const pair = document.getElementById("tmPair")?.value || "";
    return _PAIR_TO_TARGET[pair] || "_default";
}

function _collectRows() {
    const compareArea = document.getElementById("compareArea");
    if (!compareArea) return [];
    const rows = Array.from(compareArea.querySelectorAll("tbody tr"));
    const out = [];
    rows.forEach((r, i) => {
        const ref = r.dataset.ref;
        const orig = (r.dataset.orig || "").trim();
        // ใช้ corrected ถ้ามี ไม่งั้น orig
        const corr = ref ? (state.corrections[ref] || "").trim() : "";
        const text = corr || orig;
        if (text) out.push({ idx: i + 1, ref, text });
    });
    return out;
}

function _buildDetectPrompt() {
    const rows = _collectRows();
    if (!rows.length) return null;
    const target = _currentEmotionTarget();
    const emotions = getEmotionList(target);
    const chars = getCharacters();

    const charList = chars.length
        ? chars.map(c => {
            const parts = [`id="${c.id}"`, `name="${c.name || ''}"`];
            if (c.gender) parts.push(`gender="${c.gender}"`);
            if (c.age) parts.push(`age="${c.age}"`);
            if (c.persona) parts.push(`persona="${c.persona}"`);
            return `  - ${parts.join(", ")}`;
        }).join("\n")
        : "  (no characters defined — use \"\" for speaker)";

    const emoList = emotions.join(", ");
    const corpus = rows.map(r => `[${r.idx}] ${r.text}`).join("\n");

    return (
        "Identify SPEAKER + EMOTION for each numbered line below.\n" +
        "Output ONLY a JSON array — no markdown fences, no explanation:\n" +
        '[{"id":1, "speaker":"<character_id_or_empty>", "emotion1":"<primary_or_empty>", "emotion2":"<secondary_or_empty>"}, ...]\n\n' +
        "Rules:\n" +
        "- speaker: ใช้ character id จาก CHARACTERS list (ถ้าไม่แน่ใจ/narration → \"\")\n" +
        "- emotion1: primary emotion จาก EMOTIONS list ตามภาษา target (ถ้าไม่ระบุ → \"\")\n" +
        "- emotion2: secondary emotion ถ้าเป็น layered อารมณ์ (เช่น ดีใจ+เขิน) — ปกติ \"\"\n" +
        "- ห้ามแปลคำ/ปรับ id — output value ตามที่อยู่ใน list เท่านั้น\n\n" +
        "CHARACTERS:\n" + charList + "\n\n" +
        `EMOTIONS (target=${target}, use ONLY these target-language words):\n  ${emoList}\n\n` +
        "LINES:\n" + corpus
    );
}

async function _copyDetectPrompt(btn) {
    const p = _buildDetectPrompt();
    const statusEl = document.getElementById("detectMetaStatus");
    if (!p) {
        if (statusEl) statusEl.textContent = "No rows in Compare table — upload + OCR first";
        return;
    }
    try {
        await navigator.clipboard.writeText(p);
        const orig = btn.textContent;
        btn.textContent = "✓ Copied — paste into Gemini";
        if (statusEl) statusEl.textContent = `prompt length: ${p.length} chars`;
        setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch (e) {
        if (statusEl) statusEl.textContent = "Copy failed: " + e.message;
    }
}

async function _patchDetected() {
    const statusEl = document.getElementById("detectMetaStatus");
    let raw;
    try { raw = await navigator.clipboard.readText(); }
    catch (e) {
        if (statusEl) statusEl.textContent = "Cannot read clipboard: " + e.message;
        return;
    }
    if (!raw || !raw.trim()) {
        if (statusEl) statusEl.textContent = "Clipboard empty";
        return;
    }
    // strip markdown fences + จับ array แรก
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const m = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (m) cleaned = m[0];

    let data;
    try { data = JSON.parse(cleaned); }
    catch (e) {
        if (statusEl) statusEl.textContent = `JSON parse failed: ${e.message}`;
        return;
    }
    if (!Array.isArray(data) || !data.length) {
        if (statusEl) statusEl.textContent = "Expected non-empty JSON array";
        return;
    }

    const compareArea = document.getElementById("compareArea");
    const rows = Array.from(compareArea?.querySelectorAll("tbody tr") || []);
    if (!rows.length) {
        if (statusEl) statusEl.textContent = "No rows in Compare table";
        return;
    }
    const validCharIds = new Set(getCharacters().map(c => c.id));
    const validEmotions = new Set(getEmotionList(_currentEmotionTarget()));

    // direct mutate (ไม่ใช้ history เพื่อกัน N undo entries) — buildCompareTable rebuild ตอนจบ
    let nSpeaker = 0, nEmotion1 = 0, nEmotion2 = 0, nSkipped = 0;
    data.forEach(d => {
        const id = parseInt(d.id, 10);
        if (!Number.isFinite(id) || id < 1 || id > rows.length) { nSkipped++; return; }
        const ref = rows[id - 1].dataset.ref;
        if (!ref) { nSkipped++; return; }

        // speaker: ต้อง valid id หรือ "" (clear)
        if (d.speaker !== undefined) {
            const sp = String(d.speaker || "").trim();
            if (!sp) {
                // ค่าว่าง → ลบ → fallback กลับเป็น AUTO
                if (state.speakerByRef[ref] !== undefined) {
                    delete state.speakerByRef[ref];
                    nSpeaker++;
                }
            } else if (validCharIds.has(sp)) {
                if (state.speakerByRef[ref] !== sp) {
                    state.speakerByRef[ref] = sp;
                    nSpeaker++;
                }
            }
            // ถ้าไม่ valid (id ไม่อยู่ใน characters) → skip ไม่ patch
        }
        // emotion1: ต้องอยู่ใน list หรือ ""
        if (d.emotion1 !== undefined) {
            const e1 = String(d.emotion1 || "").trim();
            if (!e1) {
                if (state.emotionByRef[ref] !== undefined) {
                    delete state.emotionByRef[ref];
                    nEmotion1++;
                }
            } else if (validEmotions.has(e1)) {
                if (state.emotionByRef[ref] !== e1) {
                    state.emotionByRef[ref] = e1;
                    nEmotion1++;
                }
            }
        }
        // emotion2: เหมือน emotion1 — รองรับ "" (no secondary)
        if (d.emotion2 !== undefined) {
            const e2 = String(d.emotion2 || "").trim();
            if (!e2) {
                if (state.emotion2ByRef[ref] !== undefined) {
                    delete state.emotion2ByRef[ref];
                    nEmotion2++;
                }
            } else if (validEmotions.has(e2)) {
                if (state.emotion2ByRef[ref] !== e2) {
                    state.emotion2ByRef[ref] = e2;
                    nEmotion2++;
                }
            }
        }
    });

    buildCompareTable(true);
    if (statusEl) {
        statusEl.textContent = `✓ patched ${data.length} row(s) — speaker:${nSpeaker} emo1:${nEmotion1} emo2:${nEmotion2}${nSkipped ? ` skipped:${nSkipped}` : ""}`;
    }
}

export function initDetectRowMeta() {
    document.getElementById("detectMetaCopyBtn")?.addEventListener("click", (e) => _copyDetectPrompt(e.currentTarget));
    document.getElementById("detectMetaPasteBtn")?.addEventListener("click", _patchDetected);
}
