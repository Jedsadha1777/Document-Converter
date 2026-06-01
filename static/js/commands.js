// Concrete commands — เก็บ before/after snapshot, apply ตอน do/undo
// merge() collapse consecutive ops ของ ref เดียวกัน → 1 history entry

import { Command } from "./history.js";
import { state } from "./state.js";

function clone(v) {
    return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

// UpdateBboxCmd — ใช้กับ drag/resize/font/align/reset (after = undefined ลบ override)
export class UpdateBboxCmd extends Command {
    constructor(ref, before, after, description) {
        super();
        this.ref = ref;
        this.before = clone(before);
        this.after = clone(after);
        this.description = description || "Update bbox";
    }
    do()   { this._apply(this.after); }
    undo() { this._apply(this.before); }
    _apply(val) {
        if (val === undefined || val === null) {
            delete state.bboxOverrides[this.ref];
        } else {
            state.bboxOverrides[this.ref] = clone(val);
        }
    }
    merge(next) {
        if (next instanceof UpdateBboxCmd
            && next.ref === this.ref
            && this.description === next.description) {
            this.after = next.after;
            return true;
        }
        return false;
    }
}

// SetSpeakerCmd — เปลี่ยน speakerByRef[ref]
export class SetSpeakerCmd extends Command {
    constructor(ref, before, after) {
        super();
        this.ref = ref;
        this.before = before;
        this.after = after;
        this.description = "Set speaker";
    }
    do()   { this._apply(this.after); }
    undo() { this._apply(this.before); }
    _apply(val) {
        if (val === undefined) delete state.speakerByRef[this.ref];
        else state.speakerByRef[this.ref] = val;
    }
}

// SetEmotionCmd — เปลี่ยน emotionByRef[ref] (primary) หรือ emotion2ByRef[ref] (secondary)
export class SetEmotionCmd extends Command {
    constructor(ref, before, after, slot = 1) {
        super();
        this.ref = ref;
        this.before = before;
        this.after = after;
        this.slot = slot;   // 1 = primary, 2 = secondary
        this.description = `Set emotion ${slot}`;
    }
    do()   { this._apply(this.after); }
    undo() { this._apply(this.before); }
    _apply(val) {
        const map = this.slot === 2 ? state.emotion2ByRef : state.emotionByRef;
        if (val === undefined) delete map[this.ref];
        else map[this.ref] = val;
    }
}

// CompositeCommand — รวม cmds หลายตัวเป็น history entry เดียว (multi-bbox edit ฯลฯ)
export class CompositeCommand extends Command {
    constructor(cmds, description) {
        super();
        this.cmds = cmds;
        this.description = description || "Composite";
    }
    do()   { for (const c of this.cmds) c.do(); }
    undo() { for (let i = this.cmds.length - 1; i >= 0; i--) this.cmds[i].undo(); }
}

// CreateMarkupCmd — append shape; undo removes by id
export class CreateMarkupCmd extends Command {
    constructor(shape) {
        super();
        this.shape = clone(shape);
        this.description = "Create markup";
    }
    do() {
        if (!state.markup.find(s => s.id === this.shape.id)) {
            state.markup.push(clone(this.shape));
        }
    }
    undo() {
        const i = state.markup.findIndex(s => s.id === this.shape.id);
        if (i >= 0) state.markup.splice(i, 1);
    }
}

// DeleteMarkupCmd — remove by id; undo re-inserts at original index
export class DeleteMarkupCmd extends Command {
    constructor(id) {
        super();
        this.id = id;
        this.index = state.markup.findIndex(s => s.id === id);
        this.shape = this.index >= 0 ? clone(state.markup[this.index]) : null;
        this.description = "Delete markup";
    }
    do() {
        const i = state.markup.findIndex(s => s.id === this.id);
        if (i >= 0) state.markup.splice(i, 1);
    }
    undo() {
        if (this.shape == null) return;
        const i = Math.min(this.index, state.markup.length);
        state.markup.splice(i, 0, clone(this.shape));
    }
}

// UpdateMarkupCmd — drag/resize/restyle; merge consecutive ops on same (id, description)
export class UpdateMarkupCmd extends Command {
    constructor(id, before, after, description) {
        super();
        this.id = id;
        this.before = clone(before);
        this.after = clone(after);
        this.description = description || "Update markup";
    }
    do()   { this._apply(this.after); }
    undo() { this._apply(this.before); }
    _apply(patch) {
        const s = state.markup.find(x => x.id === this.id);
        if (!s) return;
        Object.assign(s, clone(patch));
    }
    merge(next) {
        if (next instanceof UpdateMarkupCmd
            && next.id === this.id
            && this.description === next.description) {
            this.after = next.after;
            return true;
        }
        return false;
    }
}

// MergeBoxesCmd — รวมหลายกล่อง: items/texts/json_text + dicts ทุกตัวที่ remap
// snapshot ครอบทั้งหมดเพื่อให้ undo คืนสภาพได้ก้อนเดียว
export class MergeBoxesCmd extends Command {
    constructor(beforeSnap, afterSnap) {
        super();
        this.before = beforeSnap;
        this.after = afterSnap;
        this.description = "Merge boxes";
    }
    do()   { this._apply(this.after); }
    undo() { this._apply(this.before); }
    _apply(snap) {
        if (state.lastResult?.preview) {
            state.lastResult.preview.items = clone(snap.items);
        }
        if (state.lastResult) {
            state.lastResult.texts = clone(snap.texts);
            state.lastResult.json_text = snap.json_text;
        }
        // ล้าง+ใส่ใหม่ทั้งก้อน (refs อาจเปลี่ยนหลัง re-index)
        const reset = (target, src) => {
            for (const k of Object.keys(target)) delete target[k];
            Object.assign(target, clone(src));
        };
        reset(state.corrections, snap.corrections);
        reset(state.translations, snap.translations);
        reset(state.speakerByRef, snap.speakerByRef);
        reset(state.bboxOverrides, snap.bboxOverrides);
        // restore Sets ของ Compare table edits
        const restoreSet = (target, src) => {
            target.clear();
            for (const v of src || []) target.add(v);
        };
        restoreSet(state.manualEdits, snap.manualEdits);
        restoreSet(state.manualTranslations, snap.manualTranslations);
        // sync output textarea (มี json_text)
        const output = document.getElementById("output");
        if (output) output.value = snap.json_text || "";
    }
}
