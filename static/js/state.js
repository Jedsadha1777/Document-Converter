// Single source of truth สำหรับ state ของ session
// preview/compare/commands import จากที่นี่ — แก้ในวงนี้แล้ว alias ที่อื่นเห็น

export const state = {
    // ── document data (มาจาก /convert) ──
    lastResult: null,

    // ── per-document overrides (mutable, undo/redo เก็บ snapshot ของพวกนี้) ──
    bboxOverrides: {},      // {self_ref: {x, y, w, h, fontSize, align}}
    speakerByRef: {},       // {self_ref: character_id | SPEAKER_SKIP}
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
