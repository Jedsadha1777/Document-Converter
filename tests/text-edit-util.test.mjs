import {
    selectionRange, spliceText, getLineCol, setLineCol,
    lineStart, lineEnd, expandSelectionForClick,
    insertText, deleteChar, moveCursor,
    layoutEditText, cursorToLineCol, getLineLeftX,
} from "../static/js/visual/tools/text-edit-util.js";

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
    const g = JSON.stringify(got), e = JSON.stringify(exp);
    if (g === e) { pass++; }
    else { fail++; console.error(`FAIL ${name}\n  got: ${g}\n  exp: ${e}`); }
};

// ─── selectionRange ───
eq("selectionRange null anchor",     selectionRange(null, 5), null);
eq("selectionRange equal anchor",    selectionRange(5, 5), null);
eq("selectionRange forward",         selectionRange(2, 7), { start: 2, end: 7 });
eq("selectionRange backward",        selectionRange(7, 2), { start: 2, end: 7 });

// ─── spliceText ───
eq("splice insert at end",           spliceText("hello", 5, 5, " world"), "hello world");
eq("splice replace",                 spliceText("hello world", 6, 11, "there"), "hello there");
eq("splice delete",                  spliceText("hello world", 5, 11, ""), "hello");
eq("splice empty insert",            spliceText("", 0, 0, "x"), "x");

// ─── getLineCol / setLineCol ─── (text = "abc\ndef\nghi" → lines at 0..3, 4..7, 8..11)
const t1 = "abc\ndef\nghi";
eq("getLineCol pos=0",               getLineCol(t1, 0), { lineIdx: 0, col: 0 });
eq("getLineCol pos=3 (end line0)",   getLineCol(t1, 3), { lineIdx: 0, col: 3 });
eq("getLineCol pos=4 (start line1)", getLineCol(t1, 4), { lineIdx: 1, col: 0 });
eq("getLineCol pos=7",               getLineCol(t1, 7), { lineIdx: 1, col: 3 });
eq("getLineCol pos=11 (end)",        getLineCol(t1, 11), { lineIdx: 2, col: 3 });
eq("setLineCol line=1 col=2",        setLineCol(t1, 1, 2), 6);
eq("setLineCol line=0 col=99 cap",   setLineCol(t1, 0, 99), 3);
eq("setLineCol line=99 clip",        setLineCol(t1, 99, 0), 11);
eq("setLineCol line=-1 clip",        setLineCol(t1, -1, 0), 0);

// ─── lineStart / lineEnd ───
eq("lineStart pos=5 (in line1)",     lineStart(t1, 5), 4);
eq("lineStart pos=0",                lineStart(t1, 0), 0);
eq("lineStart pos=3",                lineStart(t1, 3), 0);
eq("lineStart pos=4",                lineStart(t1, 4), 4);
eq("lineEnd pos=5 (in line1)",       lineEnd(t1, 5), 7);
eq("lineEnd pos=10",                 lineEnd(t1, 10), 11);
eq("lineEnd pos=4",                  lineEnd(t1, 4), 7);

// ─── expandSelectionForClick ───
eq("expand level 1",                  expandSelectionForClick("hello world", 5, 1), null);
eq("expand level 3 (all)",            expandSelectionForClick("hello", 2, 3), { start: 0, end: 5 });
eq("expand level 2 mid-word",         expandSelectionForClick("hello world", 2, 2), { start: 0, end: 5 });
eq("expand at word boundary picks left word", expandSelectionForClick("hello world", 5, 2), { start: 0, end: 5 });
eq("expand at start of word picks right word", expandSelectionForClick("hello world", 6, 2), { start: 6, end: 11 });
eq("expand in whitespace run",        expandSelectionForClick("hello   world", 7, 2), { start: 5, end: 8 });
eq("expand level 2 empty",            expandSelectionForClick("", 0, 2), { start: 0, end: 0 });
eq("expand level 2 punct only",       expandSelectionForClick("!?", 1, 2), { start: 1, end: 2 });
// Thai with combining marks (สวัสดี = ส ว ั ส ดี — \p{M} keeps marks attached)
eq("expand thai word",                expandSelectionForClick("สวัสดี ครับ", 2, 2), { start: 0, end: 6 });

// ─── insertText ───
eq("insert no selection",             insertText("hello", 5, null, " world"), { text: "hello world", cursorPos: 11, anchor: null });
eq("insert with selection (replace)", insertText("hello world", 6, 0, "X"), { text: "Xworld", cursorPos: 1, anchor: null });
eq("insert at 0",                     insertText("abc", 0, null, "Z"), { text: "Zabc", cursorPos: 1, anchor: null });

// ─── deleteChar ───
eq("delete backward at end",          deleteChar("hello", 5, null, "backward"), { text: "hell", cursorPos: 4, anchor: null });
eq("delete backward at 0 (no-op)",    deleteChar("hello", 0, null, "backward"), { text: "hello", cursorPos: 0, anchor: null });
eq("delete forward at 0",             deleteChar("hello", 0, null, "forward"), { text: "ello", cursorPos: 0, anchor: null });
eq("delete forward at end (no-op)",   deleteChar("hello", 5, null, "forward"), { text: "hello", cursorPos: 5, anchor: null });
eq("delete selection",                deleteChar("hello world", 5, 0, "backward"), { text: " world", cursorPos: 0, anchor: null });

// ─── moveCursor: horizontal ───
eq("move left",                       moveCursor("hello", 3, null, "left", false, null), { cursorPos: 2, anchor: null, preferredCol: null });
eq("move right",                      moveCursor("hello", 3, null, "right", false, null), { cursorPos: 4, anchor: null, preferredCol: null });
eq("move left at 0 (clamp)",          moveCursor("hello", 0, null, "left", false, null), { cursorPos: 0, anchor: null, preferredCol: null });
eq("move right at end (clamp)",       moveCursor("hello", 5, null, "right", false, null), { cursorPos: 5, anchor: null, preferredCol: null });

// ─── moveCursor: selection collapse on left/right without shift ───
eq("collapse selection left",         moveCursor("hello", 4, 1, "left", false, null), { cursorPos: 1, anchor: null, preferredCol: null });
eq("collapse selection right",        moveCursor("hello", 4, 1, "right", false, null), { cursorPos: 4, anchor: null, preferredCol: null });

// ─── moveCursor: shift extends selection ───
eq("shift+left starts anchor",        moveCursor("hello", 3, null, "left", true, null), { cursorPos: 2, anchor: 3, preferredCol: null });
eq("shift+right extends",             moveCursor("hello", 3, 1, "right", true, null), { cursorPos: 4, anchor: 1, preferredCol: null });
eq("shift back to anchor → clears",   moveCursor("hello", 2, 1, "left", true, null), { cursorPos: 1, anchor: null, preferredCol: null });

// ─── moveCursor: home/end ───
eq("home in line1",                   moveCursor(t1, 6, null, "home", false, null), { cursorPos: 4, anchor: null, preferredCol: null });
eq("end in line1",                    moveCursor(t1, 5, null, "end", false, null), { cursorPos: 7, anchor: null, preferredCol: null });

// ─── moveCursor: up/down with preferredCol ───
// "abc\ndef\nghi" — pos=6 is line1 col=2
eq("up from line1 col=2",             moveCursor(t1, 6, null, "up", false, null), { cursorPos: 2, anchor: null, preferredCol: 2 });
eq("up at line0 (no move)",           moveCursor(t1, 1, null, "up", false, null), { cursorPos: 1, anchor: null, preferredCol: 1 });
eq("down from line0 col=2",           moveCursor(t1, 2, null, "down", false, null), { cursorPos: 6, anchor: null, preferredCol: 2 });
// Preferred col preserved through short line: "abcdef\nx\nghi" — pos=3 line0 col=3 → down to line1 (len 1) → col=1; preferredCol stays 3
const t2 = "abcdef\nx\nghi";
const step1 = moveCursor(t2, 3, null, "down", false, null);
eq("down to short line preserves pref", step1, { cursorPos: 8, anchor: null, preferredCol: 3 });
// Continue down: from pos=8 (line1 col=1) with preferredCol=3 → line2 col=3 → pos=12
const step2 = moveCursor(t2, step1.cursorPos, step1.anchor, "down", false, step1.preferredCol);
eq("down continues with pref col",    step2, { cursorPos: 12, anchor: null, preferredCol: 3 });

// ─── layoutEditText ───
eq("layoutEditText empty",            layoutEditText("", "10px sans", 10, 100, null), { lines: [{ text: "", width: 0, startPos: 0, endPos: 0 }], lineHeight: 12 });
eq("layoutEditText no Pretext",       layoutEditText("abc", "10px sans", 10, 100, null), { lines: [{ text: "abc", width: 0, startPos: 0, endPos: 3 }], lineHeight: 12 });

const mockHardOnly = {
    prepareWithSegments: (text) => ({ text }),
    layoutWithLines: (prepared) => {
        const parts = prepared.text.split("\n");
        if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
        return { lines: parts.map(t => ({ text: t, width: t.length * 8 })) };
    },
};
eq("layoutEditText hard break",       layoutEditText("ab\ncd", "10px sans", 10, 100, mockHardOnly), {
    lines: [
        { text: "ab", width: 16, startPos: 0, endPos: 2 },
        { text: "cd", width: 16, startPos: 3, endPos: 5 },
    ],
    lineHeight: 12,
});
eq("layoutEditText trailing \\n",     layoutEditText("ab\n", "10px sans", 10, 100, mockHardOnly), {
    lines: [
        { text: "ab", width: 16, startPos: 0, endPos: 2 },
        { text: "", width: 0, startPos: 3, endPos: 3 },
    ],
    lineHeight: 12,
});

const mockSoftWrap = {
    prepareWithSegments: (text) => ({ text }),
    layoutWithLines: (prepared, maxWidth) => {
        const text = prepared.text;
        const lines = [];
        for (const segment of text.split("\n")) {
            let buf = "";
            for (const word of segment.split(" ")) {
                const tryBuf = buf ? buf + " " + word : word;
                if (tryBuf.length * 8 > maxWidth && buf) {
                    lines.push({ text: buf, width: buf.length * 8 });
                    buf = word;
                } else {
                    buf = tryBuf;
                }
            }
            lines.push({ text: buf, width: buf.length * 8 });
        }
        return { lines };
    },
};
eq("layoutEditText soft wrap (whitespace consumed)",
    layoutEditText("hello world foo", "10px sans", 10, 80, mockSoftWrap), {
    lines: [
        { text: "hello", width: 40, startPos: 0, endPos: 5 },
        { text: "world foo", width: 72, startPos: 6, endPos: 15 },
    ],
    lineHeight: 12,
});

// ─── cursorToLineCol ───
const layoutLines = [
    { text: "hello", width: 40, startPos: 0, endPos: 5 },
    { text: "world", width: 40, startPos: 6, endPos: 11 },
];
eq("cursorToLineCol pos=0",           cursorToLineCol(0, layoutLines), { lineIdx: 0, col: 0 });
eq("cursorToLineCol pos=5 (line end)", cursorToLineCol(5, layoutLines), { lineIdx: 0, col: 5 });
eq("cursorToLineCol pos=6 (line start)", cursorToLineCol(6, layoutLines), { lineIdx: 1, col: 0 });
eq("cursorToLineCol pos=11",          cursorToLineCol(11, layoutLines), { lineIdx: 1, col: 5 });
eq("cursorToLineCol empty lines",     cursorToLineCol(0, []), { lineIdx: 0, col: 0 });
eq("cursorToLineCol beyond end",      cursorToLineCol(99, layoutLines), { lineIdx: 1, col: 5 });

// ─── getLineLeftX (text alignment) ───
// boxX=100, boxW=200, padding=4, line.width=80
const ln80 = { text: "x", width: 80 };
eq("getLineLeftX left",               getLineLeftX(ln80, 100, 200, 4, "left"), 104);
eq("getLineLeftX center",             getLineLeftX(ln80, 100, 200, 4, "center"), 160);  // 100 + (200-80)/2
eq("getLineLeftX right",              getLineLeftX(ln80, 100, 200, 4, "right"), 216);   // 100 + 200 - 4 - 80
eq("getLineLeftX default (no align)", getLineLeftX(ln80, 100, 200, 4, undefined), 104);
eq("getLineLeftX empty line center",  getLineLeftX({ text: "", width: 0 }, 100, 200, 4, "center"), 200);  // centered in box
eq("getLineLeftX line wider than box (left)", getLineLeftX({ text: "long", width: 300 }, 100, 200, 4, "left"), 104);
eq("getLineLeftX line wider than box (right)", getLineLeftX({ text: "long", width: 300 }, 100, 200, 4, "right"), -4);

// ─── cursor preservation across layout changes (resize simulation) ───
// Simulates: editingText "hello world", initial wrap at narrow width gives 2 lines,
// then resize to wider gives 1 line. cursorPosition (absolute char index) stays valid.
const narrowLines = [
    { text: "hello", width: 40, startPos: 0, endPos: 5 },
    { text: "world", width: 40, startPos: 6, endPos: 11 },
];
const wideLines = [
    { text: "hello world", width: 88, startPos: 0, endPos: 11 },
];
eq("cursor at pos 8 narrow",          cursorToLineCol(8, narrowLines), { lineIdx: 1, col: 2 });
eq("cursor at pos 8 wide (resize)",   cursorToLineCol(8, wideLines), { lineIdx: 0, col: 8 });
eq("cursor at pos 11 narrow",         cursorToLineCol(11, narrowLines), { lineIdx: 1, col: 5 });
eq("cursor at pos 11 wide",           cursorToLineCol(11, wideLines), { lineIdx: 0, col: 11 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
