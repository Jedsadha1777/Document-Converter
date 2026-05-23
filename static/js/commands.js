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
