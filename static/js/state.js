// Single source of truth สำหรับ state ของ session
// preview/compare/commands import จากที่นี่ — แก้ในวงนี้แล้ว alias ที่อื่นเห็น

export const state = {
    // ── document data (มาจาก /convert) ──
    lastResult: null,
    ocrMeta: null,          // {engine, lang} ที่ใช้จริงตอน convert — Re-OCR ใช้ค่านี้แทน dropdown ปัจจุบัน

    // ── image source map: "docId/pageNo" → blob URL (client-uploaded image) ──
    // ใช้แทน base64 จาก server เมื่อ user upload image (ตัด round-trip)
    clientImages: new Map(),

    // ── per-document overrides (mutable, undo/redo เก็บ snapshot ของพวกนี้) ──
    bboxOverrides: {},      // {self_ref: {x, y, w, h, fontSize, align}}
    speakerByRef: {},       // {self_ref: character_id | SPEAKER_SKIP}
    emotionByRef: {},       // {self_ref: emotion_text | EMOTION_AUTO} — primary emotion (string ตาม target language)
    emotion2ByRef: {},      // {self_ref: emotion_text | EMOTION_AUTO} — secondary emotion (layered)
    corrections: {},        // {self_ref: corrected_text}
    translations: {},       // {self_ref: translated_text}
    manualEdits: new Set(),         // refs ที่ผู้ใช้พิมพ์เองใน Compare cell (ไม่ใช่ LLM)
    manualTranslations: new Set(),  // refs ที่ผู้ใช้พิมพ์คำแปลเองใน Compare cell

    // ── interaction state (ไม่เข้า history) ──
    selection: {
        ref: null,           // active ref ล่าสุด — ใช้ตอน drag/font/align toolbar
        refs: new Set(),     // multi-select (shift+คลิก / marquee)
    },
    drag: null,              // {ref, mode, startX, startY, startBox, beforeOv, moved}
    marquee: null,           // {startX, startY, endX, endY, additive, initialSelection}
    justDragged: false,      // ตั้ง true หลัง drag จริง — กัน click trigger speaker popup
    previewMode: false,      // เต็มจอ + ซ่อน chrome — preview.js ใช้กดข้าม border stroke ตอน render
    editing: null,           // {ref, text} ระหว่าง edit-text — box-renderer ใช้ text นี้แทน state.translations[ref]
    subtitleBgOn: true,      // toolbar toggle — false = bbox bg transparent (เห็น text บนรูปต้นฉบับ)

    // ── markup layer (annotation shapes — separate from text bboxes) ──
    markup: [],              // [{id, type, x, y, w, h, strokeColor, fillColor, strokeWidth, pageNo}]
    markupSelection: {       // ephemeral, ไม่เข้า history
        id: null,
        ids: new Set(),
    },
    markupDefaults: {        // sticky — กล่องต่อไปจำค่าสีจากกล่องล่าสุดที่ user เปลี่ยน
        fillColor: "#facc15",
    },
};

// ── selection mutators ──

export function toggleSelect(ref, additive) {
    if (!ref) return;
    const { refs } = state.selection;
    if (additive) {
        if (refs.has(ref)) {
            refs.delete(ref);
            if (state.selection.ref === ref) {
                state.selection.ref = [...refs].pop() || null;
            }
        } else {
            refs.add(ref);
            state.selection.ref = ref;
        }
    } else {
        refs.clear();
        refs.add(ref);
        state.selection.ref = ref;
    }
}

export function clearSelection() {
    state.selection.refs.clear();
    state.selection.ref = null;
}
