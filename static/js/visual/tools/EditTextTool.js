import { ITool } from "./ITool.js";
import { state } from "../../state.js";
import { TEXTBOX_PADDING, TEXTBOX_FONT_FAMILY, measureTextInBox, buildFontString } from "../../text-layout.js";
import { COLORS } from "../../colors.js";
import { _hitRotatedBox, _worldToBoxLocal } from "../geometry.js";
import { updateInspector } from "../inspector.js";
import * as viewport from "../viewport.js";
import {
    selectionRange, cursorToLineCol, getLineLeftX,
    expandSelectionForClick, insertText as _insertText, deleteChar as _deleteCharFn, moveCursor as _moveCursorFn,
} from "./text-edit-util.js";

const BLINK_MS = 500;
const MULTI_CLICK_INTERVAL_MS = 350;
const MULTI_CLICK_PX = 4;

export class EditTextTool extends ITool {
    constructor() {
        super("edit-text", "Edit text");
        this.editingRef = null;
        this.editingBox = null;
        this.editingText = "";
        this.originalText = "";
        this.cursorPosition = 0;
        this.selectionAnchor = null;
        this.isDragSelecting = false;

        this.cursorVisible = true;
        this._blink = null;

        this._hiddenInput = null;
        this._kdHandler = null;
        this._pasteHandler = null;
        this._copyHandler = null;
        this._cutHandler = null;

        this._ctx = null;

        this._clickCount = 0;
        this._lastClickTime = 0;
        this._lastClickPos = null;

        this._preferredCol = null;

        this._menu = null;
    }

    begin(box, ref, ctx, clickPos) {
        this.editingRef = ref;
        this.editingBox = box;
        const cur = state.translations[ref] ?? "";
        this.editingText = cur;
        this.originalText = cur;
        this.selectionAnchor = null;
        this._preferredCol = null;
        this._ctx = ctx;
        this._syncEditingState();
        if (clickPos) {
            const cp = this._cursorFromPos(clickPos);
            this.cursorPosition = cp >= 0 ? cp : cur.length;
        } else {
            this.cursorPosition = cur.length;
        }
    }

    _syncEditingState() {
        state.editing = this.editingRef === null
            ? null
            : { ref: this.editingRef, text: this.editingText };
    }

    activate(ctx) {
        this._ctx = ctx;
        this._ensureInput();
        this._kdHandler = (e) => this._onKey(e);
        this._pasteHandler = (e) => this._onPaste(e);
        this._copyHandler = (e) => this._onCopy(e);
        this._cutHandler = (e) => this._onCut(e);
        this._hiddenInput.addEventListener("keydown", this._kdHandler);
        this._hiddenInput.addEventListener("paste", this._pasteHandler);
        this._hiddenInput.addEventListener("copy", this._copyHandler);
        this._hiddenInput.addEventListener("cut", this._cutHandler);
        this._focusHidden();
        this._startBlink();
        ctx.wrap.style.cursor = "text";
    }

    deactivate(ctx) {
        if (this.editingRef !== null) this._finish(true);
        this._stopBlink();
        this._dismissContextMenu();
        if (this._hiddenInput) {
            if (this._kdHandler) this._hiddenInput.removeEventListener("keydown", this._kdHandler);
            if (this._pasteHandler) this._hiddenInput.removeEventListener("paste", this._pasteHandler);
            if (this._copyHandler) this._hiddenInput.removeEventListener("copy", this._copyHandler);
            if (this._cutHandler) this._hiddenInput.removeEventListener("cut", this._cutHandler);
            this._hiddenInput.blur();
            this._hiddenInput.value = "";
        }
        this._kdHandler = this._pasteHandler = this._copyHandler = this._cutHandler = null;
        if (ctx?.wrap) ctx.wrap.style.cursor = "default";
    }

    _ensureInput() {
        if (this._hiddenInput) return;
        const ta = document.createElement("textarea");
        ta.setAttribute("aria-hidden", "true");
        ta.setAttribute("autocomplete", "off");
        ta.setAttribute("autocorrect", "off");
        ta.setAttribute("autocapitalize", "off");
        ta.setAttribute("spellcheck", "false");
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(ta);
        this._hiddenInput = ta;
    }

    _focusHidden() {
        if (this._hiddenInput) this._hiddenInput.focus({ preventScroll: true });
    }

    _startBlink() {
        this.cursorVisible = true;
        this._stopBlink();
        this._blink = setInterval(() => {
            this.cursorVisible = !this.cursorVisible;
            this._ctx?.doDraw();
        }, BLINK_MS);
    }
    _stopBlink() {
        if (this._blink) { clearInterval(this._blink); this._blink = null; }
        this.cursorVisible = false;
    }
    _resetBlink() {
        this.cursorVisible = true;
        if (this._blink) clearInterval(this._blink);
        this._blink = setInterval(() => {
            this.cursorVisible = !this.cursorVisible;
            this._ctx?.doDraw();
        }, BLINK_MS);
    }

    _finish(commit) {
        if (this.editingRef === null) return;
        const ref = this.editingRef;
        const changed = this.editingText !== this.originalText;
        if (commit && changed) {
            const v = this.editingText;
            if (v.trim()) {
                state.translations[ref] = v;
                state.manualTranslations.add(ref);
            } else {
                delete state.translations[ref];
                state.manualTranslations.delete(ref);
            }
            window.buildCompareTable?.(true);
            if (state.selection.ref === ref) updateInspector();
        }
        this.editingRef = null;
        this.editingBox = null;
        this.editingText = "";
        this.cursorPosition = 0;
        this.selectionAnchor = null;
        this._preferredCol = null;
        this._syncEditingState();
        this._ctx?.doDraw();
    }

    hasSelection() {
        return this.selectionAnchor !== null && this.selectionAnchor !== this.cursorPosition;
    }
    getSelectionRange() {
        return selectionRange(this.selectionAnchor, this.cursorPosition);
    }
    getSelectedText() {
        const r = this.getSelectionRange();
        return r ? this.editingText.slice(r.start, r.end) : "";
    }
    deleteSelection() {
        const r = this.getSelectionRange();
        if (!r) return false;
        this.editingText = this.editingText.slice(0, r.start) + this.editingText.slice(r.end);
        this.cursorPosition = r.start;
        this.selectionAnchor = null;
        this._syncEditingState();
        return true;
    }

    _resolveClickLevel(pos) {
        const now = performance.now();
        const zoom = viewport.getZoom() || 1;
        const tol = MULTI_CLICK_PX / zoom;
        const close = this._lastClickPos
            && Math.abs(pos.x - this._lastClickPos.x) < tol
            && Math.abs(pos.y - this._lastClickPos.y) < tol;
        if (close && now - this._lastClickTime < MULTI_CLICK_INTERVAL_MS) {
            this._clickCount = Math.min(3, this._clickCount + 1);
        } else {
            this._clickCount = 1;
        }
        this._lastClickTime = now;
        this._lastClickPos = { x: pos.x, y: pos.y };
        return this._clickCount;
    }

    _applyMultiClickSelection(level) {
        const range = expandSelectionForClick(this.editingText, this.cursorPosition, level);
        if (!range) return;
        this.selectionAnchor = range.start;
        this.cursorPosition = range.end;
        this.isDragSelecting = false;
        this._preferredCol = null;
        this._resetBlink();
    }

    _placeCursorAt(pos, opts = {}) {
        const cp = this._cursorFromPos(pos);
        if (cp < 0) return;
        if (opts.extendSelection) {
            if (this.selectionAnchor === null) this.selectionAnchor = this.cursorPosition;
            this.cursorPosition = cp;
        } else {
            this.cursorPosition = cp;
            this.selectionAnchor = opts.startDrag ? cp : null;
        }
        this._preferredCol = null;
        this._resetBlink();
    }

    _liveBox() {
        if (this.editingRef === null) return null;
        const live = this._ctx?.drawn?.find(d => d.item?.self_ref === this.editingRef);
        const b = live || this.editingBox;
        if (b) this.editingBox = b;
        return b;
    }

    _fontOpts() {
        const ov = state.bboxOverrides[this.editingRef] || {};
        return { fontFamily: ov.fontFamily, bold: !!ov.bold, italic: !!ov.italic };
    }

    _computeMetrics(b, ctx2d) {
        const text = this.editingText;
        const layout = measureTextInBox(ctx2d, text || " ", b.w, { fixedFontSize: b.fontSize, preserveWhitespace: true, ...this._fontOpts() });
        if (!layout) {
            return { ascent: 0, descent: 0, lineHeight: 0, lines: [] };
        }
        if (!text || layout.lines.length === 0) {
            return { ...layout, lines: [{ text: "", width: 0, startPos: 0, endPos: 0 }] };
        }
        const linesWithPos = [];
        let cursor = 0;
        for (const ln of layout.lines) {
            let startPos, endPos;
            if (ln.text === "") {
                startPos = cursor;
                endPos = cursor;
                if (text[cursor] === "\n") cursor++;
            } else {
                const idx = text.indexOf(ln.text, cursor);
                startPos = idx >= 0 ? idx : cursor;
                endPos = startPos + ln.text.length;
                cursor = endPos;
                if (text[cursor] === "\n") cursor++;
            }
            linesWithPos.push({ text: ln.text, width: ln.width, startPos, endPos });
        }
        if (text.length > 0 && text[text.length - 1] === "\n" && linesWithPos.length > 0) {
            linesWithPos.push({ text: "", width: 0, startPos: text.length, endPos: text.length });
        }
        return { ascent: layout.ascent, descent: layout.descent, lineHeight: layout.lineHeight, lines: linesWithPos };
    }

    _topY(b, lines, lineHeight) {
        const valign = state.bboxOverrides[this.editingRef]?.valign || "top";
        const totalTextH = lines.length * lineHeight;
        if (valign === "middle") {
            return b.y + TEXTBOX_PADDING + (b.h - TEXTBOX_PADDING * 2 - totalTextH) / 2;
        }
        if (valign === "bottom") {
            return b.y + b.h - TEXTBOX_PADDING - totalTextH;
        }
        return b.y + TEXTBOX_PADDING;
    }

    onPointerDown(ev, pos, ctx) {
        if (ev.button !== 0) return;
        if (this.editingRef === null) {
            ctx.useTool("select");
            return;
        }
        const b = this._liveBox();
        if (!b) { ctx.useTool("select"); return; }
        const inside = _hitRotatedBox({ x: b.x, y: b.y, w: b.w, h: b.h }, b.rotation || 0, pos.x, pos.y);
        if (!inside) {
            this._finish(true);
            ctx.useTool("select");
            return;
        }
        ev.preventDefault();
        if (ev.shiftKey) {
            this._placeCursorAt(pos, { extendSelection: true });
        } else {
            this._placeCursorAt(pos, { startDrag: true });
            this.isDragSelecting = true;
            const level = this._resolveClickLevel(pos);
            if (level >= 2) this._applyMultiClickSelection(level);
        }
        ctx.doDraw();
        this._focusHidden();
    }

    onPointerMove(ev, pos, ctx) {
        const b = this._liveBox();
        if (b) {
            const inside = _hitRotatedBox({ x: b.x, y: b.y, w: b.w, h: b.h }, b.rotation || 0, pos.x, pos.y);
            ctx.wrap.style.cursor = inside ? "text" : "default";
        }
        if (!this.isDragSelecting) return;
        const cp = this._cursorFromPos(pos);
        if (cp < 0) return;
        this.cursorPosition = cp;
        this._preferredCol = null;
        this._resetBlink();
        ctx.doDraw();
    }

    onPointerUp(ev, pos, ctx) {
        if (this.editingRef !== null) this._focusHidden();
        if (!this.isDragSelecting) return;
        this.isDragSelecting = false;
        if (this.selectionAnchor === this.cursorPosition) this.selectionAnchor = null;
    }

    _cursorFromPos(pos) {
        const b = this._liveBox();
        if (!b) return -1;
        const lp = _worldToBoxLocal({ x: b.x, y: b.y, w: b.w, h: b.h }, b.rotation || 0, pos.x, pos.y);
        const m = _measureCtx();
        const { lineHeight, lines } = this._computeMetrics(b, m);
        if (!lineHeight || lines.length === 0) return 0;

        const topY = this._topY(b, lines, lineHeight);
        const relY = lp.y - topY;
        const clickedLineIndex = Math.floor(relY / lineHeight);
        if (clickedLineIndex < 0) return 0;
        if (clickedLineIndex >= lines.length) return this.editingText.length;

        const line = lines[clickedLineIndex];
        if (!line) return this.editingText.length;
        const align = state.bboxOverrides[this.editingRef]?.align || "left";
        const lineLeft = getLineLeftX(line, b.x, b.w, TEXTBOX_PADDING, align);
        const relX = lp.x - lineLeft;
        m.font = buildFontString(b.fontSize, this._fontOpts());
        let bestCol = 0, minD = Math.abs(relX);
        for (let i = 0; i <= line.text.length; i++) {
            const w = m.measureText(line.text.slice(0, i)).width;
            const d = Math.abs(w - relX);
            if (d < minD) { minD = d; bestCol = i; }
        }
        return line.startPos + bestCol;
    }

    _moveCursor(direction, shift) {
        if (direction === "up" || direction === "down") {
            const b = this._liveBox();
            if (!b) return;
            const { lines } = this._computeMetrics(b, _measureCtx());
            const cur = cursorToLineCol(this.cursorPosition, lines);
            let pref = this._preferredCol !== null ? this._preferredCol : cur.col;
            let nextAnchor = shift ? (this.selectionAnchor === null ? this.cursorPosition : this.selectionAnchor) : null;
            const targetIdx = cur.lineIdx + (direction === "up" ? -1 : 1);
            let nextCursor = this.cursorPosition;
            if (targetIdx >= 0 && targetIdx < lines.length) {
                const tgt = lines[targetIdx];
                nextCursor = tgt.startPos + Math.min(pref, tgt.text.length);
            }
            if (shift && nextAnchor === nextCursor) nextAnchor = null;
            this.cursorPosition = nextCursor;
            this.selectionAnchor = nextAnchor;
            this._preferredCol = pref;
            this._resetBlink();
            return;
        }
        const r = _moveCursorFn(this.editingText, this.cursorPosition, this.selectionAnchor, direction, shift, this._preferredCol);
        this.cursorPosition = r.cursorPos;
        this.selectionAnchor = r.anchor;
        this._preferredCol = r.preferredCol;
        this._resetBlink();
    }

    _insert(text) {
        const r = _insertText(this.editingText, this.cursorPosition, this.selectionAnchor, text);
        this.editingText = r.text;
        this.cursorPosition = r.cursorPos;
        this.selectionAnchor = r.anchor;
        this._preferredCol = null;
        this._syncEditingState();
        this._resetBlink();
    }

    _deleteChar(direction) {
        const r = _deleteCharFn(this.editingText, this.cursorPosition, this.selectionAnchor, direction);
        this.editingText = r.text;
        this.cursorPosition = r.cursorPos;
        this.selectionAnchor = r.anchor;
        this._preferredCol = null;
        this._syncEditingState();
        this._resetBlink();
    }

    _onKey(e) {
        if (this.editingRef === null) return;
        const modKey = e.ctrlKey || e.metaKey;
        const k = e.key;

        if (modKey && !e.altKey) {
            const kl = k.toLowerCase();
            if (kl === "a") {
                e.preventDefault();
                e.stopPropagation();
                this.selectionAnchor = 0;
                this.cursorPosition = this.editingText.length;
                this._preferredCol = null;
                this._resetBlink();
                this._ctx.doDraw();
                return;
            }
            if (kl === "c" || kl === "v" || kl === "x") return;
            if (kl === "z" || kl === "y") {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        e.preventDefault();
        e.stopPropagation();
        switch (k) {
            case "Escape":     this._finish(false); this._ctx.useTool("select"); return;
            case "Enter":      e.shiftKey ? this._insert("\n") : (this._finish(true), this._ctx.useTool("select")); break;
            case "Backspace":  this._deleteChar("backward"); break;
            case "Delete":     this._deleteChar("forward"); break;
            case "ArrowLeft":  this._moveCursor("left", e.shiftKey); break;
            case "ArrowRight": this._moveCursor("right", e.shiftKey); break;
            case "ArrowUp":    this._moveCursor("up", e.shiftKey); break;
            case "ArrowDown":  this._moveCursor("down", e.shiftKey); break;
            case "Home":       this._moveCursor("home", e.shiftKey); break;
            case "End":        this._moveCursor("end", e.shiftKey); break;
            default:
                if (k.length === 1 && !modKey) this._insert(k);
                break;
        }
        if (this.editingRef !== null) this._ctx.doDraw();
    }

    _onPaste(e) {
        if (this.editingRef === null) return;
        const raw = e.clipboardData?.getData("text/plain");
        if (!raw) return;
        e.preventDefault();
        this._insert(raw);
        this._ctx.doDraw();
    }
    _onCopy(e) {
        if (this.editingRef === null) return;
        const t = this.getSelectedText();
        if (!t) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", t);
    }
    _onCut(e) {
        if (this.editingRef === null) return;
        const t = this.getSelectedText();
        if (!t) return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", t);
        this.deleteSelection();
        this._ctx.doDraw();
    }

    onContextMenu(ev, pos, ctx) {
        if (this.editingRef === null) return;
        const b = this._liveBox();
        if (!b) return;
        if (!_hitRotatedBox({ x: b.x, y: b.y, w: b.w, h: b.h }, b.rotation || 0, pos.x, pos.y)) return;
        ev.preventDefault();
        ev.stopPropagation();
        this._showContextMenu(ev.clientX, ev.clientY);
    }

    _showContextMenu(screenX, screenY) {
        this._dismissContextMenu();
        const hasSel = this.hasSelection();
        const items = [
            { label: "Cut",        action: () => this._menuCut(),    disabled: !hasSel },
            { label: "Copy",       action: () => this._menuCopy(),   disabled: !hasSel },
            { label: "Paste",      action: () => this._menuPaste() },
            { divider: true },
            { label: "Select all", action: () => this._menuSelectAll() },
        ];
        const menu = document.createElement("div");
        menu.style.cssText = "position:fixed;z-index:10001;min-width:180px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:6px;box-shadow:0 6px 16px rgba(0,0,0,0.16);padding:6px 0;user-select:none;font:13px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;";
        for (const it of items) {
            if (it.divider) {
                const sep = document.createElement("div");
                sep.style.cssText = "height:1px;background:#e8eaed;margin:4px 0;";
                menu.appendChild(sep);
                continue;
            }
            const row = document.createElement("div");
            row.textContent = it.label;
            row.style.cssText = `padding:6px 16px;cursor:${it.disabled ? "not-allowed" : "pointer"};color:${it.disabled ? "#9aa0a6" : "#202124"};`;
            if (!it.disabled) {
                row.addEventListener("mouseenter", () => { row.style.background = "#e8f0fe"; });
                row.addEventListener("mouseleave", () => { row.style.background = ""; });
                row.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
                row.addEventListener("click", () => { this._dismissContextMenu(); it.action(); });
            }
            menu.appendChild(row);
        }
        document.body.appendChild(menu);
        const r = menu.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let mx = screenX, my = screenY;
        if (mx + r.width  > vw - 4) mx = Math.max(4, vw - r.width  - 4);
        if (my + r.height > vh - 4) my = Math.max(4, vh - r.height - 4);
        menu.style.left = mx + "px";
        menu.style.top  = my + "px";
        const dismiss = (e) => { if (!menu.contains(e.target)) this._dismissContextMenu(); };
        const dismissKey = (e) => { if (e.key === "Escape") this._dismissContextMenu(); };
        this._menu = { element: menu, dismiss, dismissKey };
        setTimeout(() => {
            document.addEventListener("mousedown", dismiss, true);
            document.addEventListener("keydown", dismissKey, true);
        }, 0);
        requestAnimationFrame(() => this._focusHidden());
    }

    _dismissContextMenu() {
        if (!this._menu) return;
        const { element, dismiss, dismissKey } = this._menu;
        document.removeEventListener("mousedown", dismiss, true);
        document.removeEventListener("keydown", dismissKey, true);
        element.parentNode?.removeChild(element);
        this._menu = null;
    }

    async _menuCut() {
        const t = this.getSelectedText();
        if (!t) return;
        try { await navigator.clipboard.writeText(t); } catch (e) {}
        this.deleteSelection();
        this._ctx.doDraw();
        this._focusHidden();
    }
    async _menuCopy() {
        const t = this.getSelectedText();
        if (!t) return;
        try { await navigator.clipboard.writeText(t); } catch (e) {}
        this._focusHidden();
    }
    async _menuPaste() {
        let text = "";
        try { text = await navigator.clipboard.readText(); } catch (e) {}
        if (!text) return;
        this._insert(text);
        this._ctx.doDraw();
        this._focusHidden();
    }
    _menuSelectAll() {
        this.selectionAnchor = 0;
        this.cursorPosition = this.editingText.length;
        this._preferredCol = null;
        this._resetBlink();
        this._ctx.doDraw();
        this._focusHidden();
    }

    drawOverlay(canvasCtx, opts) {
        const b = this._liveBox();
        if (!b) return;
        const z = opts.zoom;

        canvasCtx.save();
        if (b.rotation) {
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            canvasCtx.translate(cx, cy);
            canvasCtx.rotate(b.rotation * Math.PI / 180);
            canvasCtx.translate(-cx, -cy);
        }

        const { lineHeight, lines, ascent, descent } = this._computeMetrics(b, canvasCtx);
        const ov = state.bboxOverrides[this.editingRef] || {};
        const align = ov.align || "left";
        const topY = this._topY(b, lines, lineHeight);
        canvasCtx.font = buildFontString(b.fontSize, this._fontOpts());

        canvasCtx.save();
        canvasCtx.beginPath();
        canvasCtx.rect(b.x, b.y, b.w, b.h);
        canvasCtx.clip();

        const range = this.getSelectionRange();
        if (range) {
            canvasCtx.fillStyle = "rgba(0, 102, 204, 0.25)";
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                const segStart = Math.max(range.start, ln.startPos);
                const segEnd = Math.min(range.end, ln.endPos);
                if (segStart < segEnd) {
                    const sCol = segStart - ln.startPos;
                    const eCol = segEnd - ln.startPos;
                    const lineLeft = getLineLeftX(ln, b.x, b.w, TEXTBOX_PADDING, align);
                    const xStart = lineLeft + canvasCtx.measureText(ln.text.slice(0, sCol)).width;
                    const xEnd = lineLeft + canvasCtx.measureText(ln.text.slice(0, eCol)).width;
                    const y = topY + i * lineHeight;
                    canvasCtx.fillRect(xStart, y, Math.max(1, xEnd - xStart), lineHeight * 0.95);
                }
            }
        }

        if (this.cursorVisible && !this.hasSelection()) {
            const { lineIdx, col } = cursorToLineCol(this.cursorPosition, lines);
            const line = lines[lineIdx] || { text: "", width: 0 };
            const subWidth = canvasCtx.measureText(line.text.slice(0, col)).width;
            const lineLeft = getLineLeftX(line, b.x, b.w, TEXTBOX_PADDING, align);
            const cx = lineLeft + subWidth;
            const cy = topY + lineIdx * lineHeight;
            const ch = lineHeight * 0.9;
            canvasCtx.strokeStyle = "#000";
            canvasCtx.lineWidth = 1 / z;
            canvasCtx.beginPath();
            canvasCtx.moveTo(cx, cy);
            canvasCtx.lineTo(cx, cy + ch);
            canvasCtx.stroke();
        }

        canvasCtx.restore();

        const lw = 2 / z;
        canvasCtx.strokeStyle = COLORS.primary;
        canvasCtx.lineWidth = lw;
        canvasCtx.setLineDash([6 / z, 4 / z]);
        canvasCtx.strokeRect(b.x - lw / 2, b.y - lw / 2, b.w + lw, b.h + lw);
        canvasCtx.setLineDash([]);

        canvasCtx.restore();
    }
}

let _shared = null;
function _measureCtx() {
    if (!_shared) _shared = document.createElement("canvas").getContext("2d");
    return _shared;
}
