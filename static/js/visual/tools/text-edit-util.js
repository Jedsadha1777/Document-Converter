export function layoutEditText(text, font, fontSize, maxWidth, Pretext) {
    const lineHeight = fontSize * 1.2;
    if (!text) return { lines: [{ text: "", width: 0, startPos: 0, endPos: 0 }], lineHeight };
    if (!Pretext) return { lines: [{ text, width: 0, startPos: 0, endPos: text.length }], lineHeight };

    const prepared = Pretext.prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
    const result = Pretext.layoutWithLines(prepared, Math.max(maxWidth, 1), lineHeight);

    const lines = [];
    let cursor = 0;
    for (const pLine of result.lines) {
        const lineText = pLine.text;
        let startPos;
        if (lineText === "") {
            startPos = cursor;
        } else {
            const found = text.indexOf(lineText, cursor);
            startPos = found >= 0 ? found : cursor;
        }
        const endPos = startPos + lineText.length;
        cursor = endPos;

        if (cursor < text.length) {
            if (text[cursor] === "\n") {
                cursor++;
            } else {
                while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
            }
        }

        lines.push({ text: lineText, width: pLine.width, startPos, endPos });
    }

    if (text.length > 0 && text[text.length - 1] === "\n" && lines.length > 0) {
        lines.push({ text: "", width: 0, startPos: text.length, endPos: text.length });
    }

    return { lines, lineHeight };
}

export function getLineLeftX(line, boxX, boxW, padding, textAlign) {
    if (textAlign === "center") return boxX + (boxW - line.width) / 2;
    if (textAlign === "right") return boxX + boxW - padding - line.width;
    return boxX + padding;
}

export function cursorToLineCol(cursorPos, layoutLines) {
    if (layoutLines.length === 0) return { lineIdx: 0, col: 0 };
    for (let i = 0; i < layoutLines.length; i++) {
        const ln = layoutLines[i];
        if (cursorPos >= ln.startPos && cursorPos <= ln.endPos) {
            return { lineIdx: i, col: cursorPos - ln.startPos };
        }
    }
    const last = layoutLines[layoutLines.length - 1];
    return { lineIdx: layoutLines.length - 1, col: last.text.length };
}

export function selectionRange(anchor, cursor) {
    if (anchor === null || anchor === cursor) return null;
    return anchor < cursor ? { start: anchor, end: cursor } : { start: cursor, end: anchor };
}

export function spliceText(text, start, end, replacement) {
    return text.slice(0, start) + replacement + text.slice(end);
}

export function getLineCol(text, pos) {
    const lines = text.split("\n");
    let abs = 0;
    for (let i = 0; i < lines.length; i++) {
        if (pos <= abs + lines[i].length) return { lineIdx: i, col: pos - abs };
        abs += lines[i].length + 1;
    }
    return { lineIdx: lines.length - 1, col: lines[lines.length - 1].length };
}

export function setLineCol(text, lineIdx, col) {
    const lines = text.split("\n");
    if (lineIdx < 0) return 0;
    if (lineIdx >= lines.length) return text.length;
    let abs = 0;
    for (let i = 0; i < lineIdx; i++) abs += lines[i].length + 1;
    return abs + Math.min(col, lines[lineIdx].length);
}

export function lineStart(text, pos) {
    return text.lastIndexOf("\n", pos - 1) + 1;
}

export function lineEnd(text, pos) {
    const i = text.indexOf("\n", pos);
    return i === -1 ? text.length : i;
}

export function expandSelectionForClick(text, position, level) {
    if (level >= 3) return { start: 0, end: text.length };
    if (level !== 2) return null;
    if (text.length === 0) return { start: 0, end: 0 };
    const isWord = (c) => /[\p{L}\p{N}\p{M}_]/u.test(c);
    const isSpace = (c) => /\s/.test(c);
    const p = Math.max(0, Math.min(position, text.length));
    const right = p < text.length ? text[p] : null;
    const left = p > 0 ? text[p - 1] : null;
    let test, anchor;
    if (right && isWord(right))       { test = isWord;  anchor = p; }
    else if (left && isWord(left))    { test = isWord;  anchor = p - 1; }
    else if (right && isSpace(right)) { test = isSpace; anchor = p; }
    else if (left && isSpace(left))   { test = isSpace; anchor = p - 1; }
    else                              { return right ? { start: p, end: p + 1 } : { start: p, end: p }; }
    let start = anchor, end = anchor;
    while (start > 0 && test(text[start - 1])) start--;
    while (end < text.length && test(text[end])) end++;
    return { start, end };
}

export function insertText(text, cursorPos, anchor, insert) {
    const range = selectionRange(anchor, cursorPos);
    const s = range ? range.start : cursorPos;
    const e = range ? range.end : cursorPos;
    return {
        text: spliceText(text, s, e, insert),
        cursorPos: s + insert.length,
        anchor: null,
    };
}

export function deleteChar(text, cursorPos, anchor, direction) {
    const range = selectionRange(anchor, cursorPos);
    if (range) {
        return { text: spliceText(text, range.start, range.end, ""), cursorPos: range.start, anchor: null };
    }
    if (direction === "backward" && cursorPos > 0) {
        return { text: spliceText(text, cursorPos - 1, cursorPos, ""), cursorPos: cursorPos - 1, anchor: null };
    }
    if (direction === "forward" && cursorPos < text.length) {
        return { text: spliceText(text, cursorPos, cursorPos + 1, ""), cursorPos: cursorPos, anchor: null };
    }
    return { text, cursorPos, anchor };
}

export function moveCursor(text, cursorPos, anchor, direction, shift, preferredCol) {
    if (!shift && anchor !== null && anchor !== cursorPos && (direction === "left" || direction === "right")) {
        const r = selectionRange(anchor, cursorPos);
        return { cursorPos: direction === "left" ? r.start : r.end, anchor: null, preferredCol: null };
    }
    let nextAnchor = shift ? (anchor === null ? cursorPos : anchor) : null;
    let nextCursor = cursorPos;
    let nextPref = preferredCol;
    if (direction === "left") {
        nextCursor = Math.max(0, cursorPos - 1);
        nextPref = null;
    } else if (direction === "right") {
        nextCursor = Math.min(text.length, cursorPos + 1);
        nextPref = null;
    } else if (direction === "up" || direction === "down") {
        const cur = getLineCol(text, cursorPos);
        if (nextPref === null) nextPref = cur.col;
        const target = cur.lineIdx + (direction === "up" ? -1 : 1);
        const lines = text.split("\n");
        if (target < 0 || target >= lines.length) {
            nextCursor = cursorPos;
        } else {
            nextCursor = setLineCol(text, target, nextPref);
        }
    } else if (direction === "home") {
        nextCursor = lineStart(text, cursorPos);
        nextPref = null;
    } else if (direction === "end") {
        nextCursor = lineEnd(text, cursorPos);
        nextPref = null;
    }
    if (shift && nextAnchor === nextCursor) nextAnchor = null;
    return { cursorPos: nextCursor, anchor: nextAnchor, preferredCol: nextPref };
}
