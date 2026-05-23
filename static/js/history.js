// Command pattern + History stack — ดัดแปลงจาก Ketchup/core/{Command,History}.js
// ลด complexity ของ Ketchup ออก (ไม่มี SpatialGrid/propertyEvents, ไม่มี jumpTo/initialize)

export class Command {
    do() {}
    undo() {}
    merge(next) { return false; }   // override สำหรับ collapse consecutive ops (เช่น drag)
}

const MAX_ENTRIES = 100;

class History {
    constructor() {
        this.entries = [{ description: "Initial", cmd: null }];
        this.currentIndex = 0;
        this._listener = null;
    }

    onChange(listener) {
        this._listener = listener;
    }

    exec(cmd) {
        try {
            cmd.do();
        } catch (err) {
            console.error("History.exec: cmd.do() threw", err);
            try { cmd.undo?.(); } catch {}
            throw err;
        }

        // collapse กับ command ก่อนหน้าถ้า merge ได้ (เช่น drag ต่อเนื่อง)
        const last = this.entries[this.currentIndex];
        if (this.currentIndex === this.entries.length - 1
            && last && last.cmd
            && typeof last.cmd.merge === "function"
            && last.cmd.merge(cmd)) {
            this._listener?.();
            return;
        }

        const description = cmd.description || cmd.constructor.name.replace(/Cmd$/, "");
        this.entries.length = this.currentIndex + 1;     // ตัด redo branch ถ้ามี
        this.entries.push({ description, cmd });
        this.currentIndex++;

        while (this.entries.length > MAX_ENTRIES + 1) {
            this.entries.shift();
            this.currentIndex--;
        }

        this._listener?.();
    }

    canUndo() { return this.currentIndex > 0; }
    canRedo() { return this.currentIndex < this.entries.length - 1; }

    undo() {
        if (!this.canUndo()) return false;
        this.entries[this.currentIndex].cmd?.undo();
        this.currentIndex--;
        this._listener?.();
        return true;
    }

    redo() {
        if (!this.canRedo()) return false;
        this.currentIndex++;
        this.entries[this.currentIndex].cmd?.do();
        this._listener?.();
        return true;
    }

    clear() {
        this.entries = [{ description: "Initial", cmd: null }];
        this.currentIndex = 0;
        this._listener?.();
    }
}

export const history = new History();
