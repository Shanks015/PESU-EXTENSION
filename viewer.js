pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.js");

/* ───────────── elements ───────────── */

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const pagesEl = $("pages");
const dockEl = $("dock");
const bootEl = $("boot");
const bootTitleEl = $("bootTitle");
const bootSubEl = $("bootSub");
const bootHintEl = $("bootHint");
const progressFill = $("progressFill");
const counterEl = $("counter");
const zoomLabel = $("zoomLabel");
const forceOcrBtn = $("forceOcrBtn");
const downloadBtn = $("downloadBtn");
const downloadMenu = $("downloadMenu");
const menuNote = $("menuNote");
const openBtn = $("openBtn");


/* ───────────── tuning ───────────── */

const MAX_PAGE_WIDTH = 1800;
const SIDE_GUTTER = 24;
// Leave a little air around the page instead of touching both edges.
const FIT_TRIM = 0.96;
const DPR_CAP = 1.5;
const MAX_CANVAS_WIDTH = 2600;
const ZOOM_STEPS = [1, 1.25, 1.5, 2];
const OCR_FONT = 'Arial, "Helvetica Neue", sans-serif';

// If pdf.js or Tesseract wedges on a single page, move on instead of
// letting the whole document sit at "20 of 23" forever.
const RENDER_TIMEOUT = 25000;
const OCR_TIMEOUT = 45000;
const OCR_START_TIMEOUT = 60000;
const OCR_MAX_WIDTH = 1600;

const measureCtx = document.createElement("canvas").getContext("2d");
let ascent = null;

// Where the baseline sits inside a 1em line box for the OCR font, so the
// invisible spans land on top of the glyphs instead of floating above them.
function ascentRatio() {
  if (ascent === null) {
    measureCtx.font = `100px ${OCR_FONT}`;
    const m = measureCtx.measureText("Hxg");
    ascent = (m.fontBoundingBoxAscent || 80) / 100;
  }
  return ascent;
}

const widthCache = new Map();
function naturalWidth(text, size) {
  const key = `${size}|${text}`;
  if (widthCache.has(key)) return widthCache.get(key);
  measureCtx.font = `${size}px ${OCR_FONT}`;
  const width = measureCtx.measureText(text).width;
  if (widthCache.size > 600) widthCache.clear();
  widthCache.set(key, width);
  return width;
}

const state = {
  pdf: null,
  docName: "",
  mode: "text", // "text" | "ocr"
  pages: [],
  fitScale: 1.15,
  zoomIdx: 0,
  runId: 0,
  textReady: 0,
  pagesDone: 0,
  activeSlide: 0,
  totalSlides: 0,
  statusAt: 0,
  ocrFailures: 0,
  ocrUnavailable: false,
  busy: false,
  exporting: false,
  pendingExport: null,
  sourceUrl: "",
  sourceBlob: null,
};

/* ───────────── helpers ───────────── */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const pad2 = (n) => String(n).padStart(2, "0");

const zoomFactor = () => ZOOM_STEPS[state.zoomIdx];
const currentScale = () => state.fitScale * zoomFactor();

function fitScaleFor(baseWidth) {
  // clientWidth leaves out the scrollbar, so the page never spills sideways.
  const viewport = document.documentElement.clientWidth || window.innerWidth;
  const available = Math.min(viewport - SIDE_GUTTER, MAX_PAGE_WIDTH) * FIT_TRIM;
  return clamp(available / baseWidth, 0.5, 4);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Timed out after ${Math.round(ms / 1000)}s`);
      err.timedOut = true;
      reject(err);
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function setStatus(text) {
  statusEl.textContent = text;
  state.statusAt = Date.now();
}

// OCR narrates constantly. While a file is being written, the download's own
// progress gets the status line instead of being overwritten mid-encode.
function narrate(text) {
  if (!state.exporting) setStatus(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setProgress(fraction) {
  progressFill.style.transform = `scaleX(${clamp(fraction, 0, 1)})`;
}

function setCounter(done, total) {
  counterEl.textContent = total ? `${pad2(done)}/${pad2(total)}` : "--/--";
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  updateDownloadState();
}

// Download becomes available as soon as every slide has paint on it. OCR can
// keep running in the background; the file simply carries the text found so far.
function updateDownloadState() {
  const ready =
    state.pages.length > 0 &&
    state.pages.every((record) => record.painted || record.paintFailed);
  downloadBtn.disabled = state.exporting || !ready;
  openBtn.disabled = !(state.sourceBlob || state.sourceUrl);

  downloadBtn.title =
    state.busy && state.mode === "ocr"
      ? "Text recognition is still running — the download starts automatically when it finishes"
      : "Save these slides as a file";
}

function hideBoot() {
  bootEl.classList.add("gone");
}

function showBootError(title, detail) {
  bootEl.classList.remove("gone");
  bootEl.classList.add("error");
  bootTitleEl.textContent = title;
  bootSubEl.textContent = detail;
  bootHintEl.textContent = "Reload the page to try again";
}

/* ───────────── OCR line building ───────────── */

// Tesseract returns words with their own boxes; rebuild a readable line by
// looking at the gap between neighbours instead of trusting raw spacing.
function buildCleanOcrLine(words) {
  if (!words || words.length === 0) return "";
  let lineText = "";
  // A single word's own average character width lies about punctuation: "."
  // is narrow, so a normal space after "random." would look like a card gutter.
  // Take the typical character width across the whole run instead.
  const widths = words.map(
    (w) => (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.length)
  );
  const charWidth = median(widths) || 1;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0) {
      const gap = w.bbox.x0 - words[i - 1].bbox.x1;
      if (gap > charWidth * 0.45) lineText += " ";
    }
    lineText += w.text;
  }

  return lineText;
}

// Slides pack text into cards and columns. Tesseract happily reports one
// "line" spanning all of them, which glues independent cards together when
// copied. Measure the page's normal word spacing first so card gutters can
// be told apart from ordinary spaces.
function typicalWordGap(data) {
  const gaps = [];
  for (const line of data.lines || []) {
    const words = line.words || [];
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
      if (gap > 0) gaps.push(gap);
    }
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  // A low percentile: most gaps on a page are ordinary word spaces, while the
  // card gutters are the outliers we're looking for.
  return gaps[Math.floor((gaps.length - 1) * 0.25)];
}

// A code listing is one source line per slide line, and the alignment spaces
// inside it are wider than any card gutter. Splitting those lines turns every
// statement into two or three fragments, and reading order then walks the
// fragments column by column — `printf("x` / `= %d\n", x);` come out shuffled
// and interleaved. Recognise code first and leave such a line whole.
function looksLikeCode(text) {
  const t = (text || "").trim();
  if (!t) return false;

  // Signals that essentially never appear in slide prose.
  if (/[;{}]/.test(t)) return true;
  if (/->|::|&&|\|\||\+\+|--|[=!<>+\-*\/]=/.test(t)) return true;
  if (/#\s*(?:include|define|endif|ifn?def|pragma)\b/.test(t)) return true;
  if (/^\s*(?:\/\/|\/\*|\*\/)/.test(t)) return true;

  // Weaker signals: one of these alone might be prose, so require two.
  let score = 0;
  if (
    /\b(?:printf|scanf|fprintf|sprintf|snprintf|malloc|calloc|realloc|free|memcpy|strlen|strcpy|strcmp|puts|getchar)\s*\(/.test(
      t
    )
  )
    score += 2;
  if (/\b(?:int|float|double|char|void|long|short|unsigned|struct|typedef)\s+[*&]?[A-Za-z_]\w*/.test(t))
    score += 2;
  if (/\b(?:for|while|switch)\s*\(/.test(t)) score += 1;
  if (/\b(?:def|class|import|from|elif|lambda|None|True|False|self)\b/.test(t)) score += 1;
  if (/\b(?:print|len|range|input|enumerate|append|sorted)\s*\(/.test(t)) score += 1;
  if (/\b(?:os|sys|random|math|json|re|np|pd)\.[A-Za-z_]\w*/.test(t)) score += 1;
  if (/[A-Za-z_]\w*\s*=\s*[^=]/.test(t)) score += 1;

  return score >= 2;
}

function splitAtColumnGaps(words, breakAt) {
  const runs = [];
  let run = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    if (gap > breakAt) {
      runs.push(run);
      run = [words[i]];
    } else {
      run.push(words[i]);
    }
  }

  runs.push(run);
  return runs;
}

// Tesseract glues a tall logo, icon or unit-number stamp to the text beside it
// when their baselines overlap. The union box then reports a font size several
// times too large, which is what turns a slide header into 90pt text. Split the
// run wherever the glyph height changes sharply.
function splitAtHeightJumps(words, isCode) {
  const runs = [];
  let run = [words[0]];

  // On a code line, highlighted tokens (strings, calls) come back with boxes
  // several times taller than the identifiers around them even though they sit
  // on the same line. That is not a logo: only split when the jump is large
  // enough to be a separate element.
  const medianHeight = median(words.map((w) => w.bbox.y1 - w.bbox.y0)) || 1;
  const ratioLimit = isCode ? 3 : 2;
  const diffLimit = isCode ? Math.max(18, medianHeight * 1.1) : 10;

  for (let i = 1; i < words.length; i++) {
    const height = words[i].bbox.y1 - words[i].bbox.y0;
    const previous = words[i - 1].bbox.y1 - words[i - 1].bbox.y0;
    const tall = Math.max(height, previous);
    const short = Math.max(1, Math.min(height, previous));

    if (tall / short > ratioLimit && tall - short > diffLimit) {
      runs.push(run);
      run = [words[i]];
    } else {
      run.push(words[i]);
    }
  }

  runs.push(run);
  return runs;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Most words in a line of prose have an ascender or a descender, so the upper
// quartile of word heights is a good estimate of the line's true ink height,
// while ignoring one inflated box or a stray x-height word.
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

/* ───────────── reading order ───────────── */

// Copy order follows DOM order, so lines have to be grouped the way a person
// reads a slide: one card at a time, not one row at a time across every card.
// This is a small XY-cut: repeatedly slice the page at the widest empty band,
// so cards, columns and stacked blocks stay contiguous.
function largestGap(sorted, start, end) {
  let reach = -Infinity;
  let best = null;

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const from = start(item);
    const to = end(item);

    if (i > 0) {
      const gap = from - reach;
      if (gap > 0 && (!best || gap > best.gap)) best = { gap, k: i };
    }

    if (to > reach) reach = to;
  }

  return best;
}

function orderBlock(lines, minGap) {
  if (lines.length < 2) return lines;

  // Two fragments of one visual line (a header cut by a logo, a card title cut
  // by a rule) sit at almost the same height. Sort those left to right so the
  // sentence is rebuilt in the right order; otherwise sort by rows.
  const sameRow = (a, b) => {
    const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return overlap > Math.min(a.h, b.h) * 0.6;
  };

  const byY = lines
    .slice()
    .sort((a, b) => (sameRow(a, b) ? a.x - b.x : a.y - b.y || a.x - b.x));
  const byX = lines.slice().sort((a, b) => a.x - b.x || a.y - b.y);

  const yCut = largestGap(byY, (l) => l.y, (l) => l.y + l.h);
  const xCut = largestGap(byX, (l) => l.x, (l) => l.x + l.w);
  // Column gutters get a slightly looser bar than row gaps: a narrow gutter
  // between cards still means two separate blocks.
  const canCutX =
    xCut && xCut.gap > minGap * 0.75 && xCut.k >= 2 && byX.length - xCut.k >= 2;

  if (yCut && yCut.gap > minGap && (!canCutX || yCut.gap >= xCut.gap)) {
    return [
      ...orderBlock(byY.slice(0, yCut.k), minGap),
      ...orderBlock(byY.slice(yCut.k), minGap),
    ];
  }

  if (canCutX) {
    return [
      ...orderBlock(byX.slice(0, xCut.k), minGap),
      ...orderBlock(byX.slice(xCut.k), minGap),
    ];
  }

  return byY;
}

function readingOrder(lines) {
  if (lines.length < 2) return lines;

  const heights = lines.map((l) => l.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  // A band narrower than one line of text is just line spacing, not a gutter.
  const minGap = Math.max(0.012, median * 0.9);

  return orderBlock(lines, minGap);
}

// Tesseract sometimes reports one visual line as two runs with a slightly
// different baseline ("Returns a" + "random number..."). Join those back so a
// sentence stays a single text box instead of two boxes with a gap.
function mergeCloseLines(lines) {
  const out = [];

  for (const line of lines) {
    let merged = false;

    for (const target of out) {
      const overlap =
        Math.min(line.y + line.h, target.y + target.h) - Math.max(line.y, target.y);
      const minHeight = Math.min(line.h, target.h);
      if (overlap < minHeight * 0.55) continue;

      // Tesseract clips ascenders and descenders inconsistently, so two halves
      // of one sentence can report noticeably different ink heights.
      const heightRatio =
        Math.max(line.h, target.h) / Math.max(0.001, Math.min(line.h, target.h));
      if (heightRatio > 1.9) continue;

      const left = line.x <= target.x ? line : target;
      const right = line.x <= target.x ? target : line;
      const gap = right.x - (left.x + left.w);
      if (gap > Math.max(left.h, right.h) * 0.9) continue;

      const baselineGap = Math.abs(line.y + line.h - (target.y + target.h));
      if (baselineGap > minHeight * 0.6) continue;

      if (left.text === right.text && gap < 0) {
        // The same word reported twice; keep the first copy only.
        merged = true;
        break;
      }

      const x0 = Math.min(left.x, right.x);
      const y0 = Math.min(line.y, target.y);
      const x1 = Math.max(left.x + left.w, right.x + right.w);
      const y1 = Math.max(line.y + line.h, target.y + target.h);

      target.text = `${left.text} ${right.text}`.replace(/\s+/g, " ").trim();
      target.x = x0;
      target.y = y0;
      target.w = x1 - x0;
      target.h = y1 - y0;
      merged = true;
      break;
    }

    if (!merged) out.push({ ...line });
  }

  return out;
}

function buildOcrLines(data, canvasWidth, canvasHeight) {
  const lines = [];
  const source = (data.lines || []).slice().sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const pageGap = typicalWordGap(data);

  for (const line of source) {
    const words = (line.words || []).filter((w) => w.text && w.text.trim());
    if (!words.length) continue;
    words.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    const wholeLine = buildCleanOcrLine(words);
    const codeLine = looksLikeCode(wholeLine);

    for (const heightRun of splitAtHeightJumps(words, codeLine)) {
      // Size the gutter threshold from the text itself, not from a logo that
      // happened to share the line.
      const runHeight = Math.max(6, median(heightRun.map((w) => w.bbox.y1 - w.bbox.y0)));
      // Anything wider than roughly one em — or four normal spaces — is a card
      // gutter, not a word gap. Clamping keeps a page with only one or two wide
      // gaps from inflating the threshold past the gutter itself.
      const space = Math.min(pageGap, runHeight * 0.4);
      const breakAt = Math.max(runHeight * 0.9, space * 3.5);

      const runs =
        codeLine || looksLikeCode(buildCleanOcrLine(heightRun))
          ? [heightRun]
          : splitAtColumnGaps(heightRun, breakAt);

      for (const run of runs) {
        // The bullet is part of the slide art, not the sentence, but OCR reads
        // the glyph itself as "?", "•" or "*". Strip it before anything is
        // copied or exported.
        const text = buildCleanOcrLine(run)
          .replace(/^©(?=\.)/, "0")
          .replace(/^[?|»«](?=[A-Za-z])/, "")
          .replace(/^[©®™]\s*/, "")
          .replace(/^(?:[•·]\s*|\*\s+(?=[A-Za-z]))/, "")
          .replace(/^\([^)\s]{1,4}\)\s+(?=[A-Z])/, "")
          .trim();
        if (!text) continue;

        // Icons and decorative shapes come back as stray punctuation or a lone
        // guessed character. Keep real text, drop the scraps.
        if (!/[A-Za-z0-9]/.test(text)) continue;
        const confidence = run.reduce((min, w) => Math.min(min, w.confidence ?? 100), 100);
        const wordCount = text.split(/\s+/).length;
        if (wordCount === 1 && text.length <= 3) continue;
        if (text.length === 1 && confidence < 60) continue;

        const x0 = Math.min(...run.map((w) => w.bbox.x0));
        const x1 = Math.max(...run.map((w) => w.bbox.x1));
        // A typical top plus a typical bottom: one inflated box cannot decide
        // the font size, but ascenders and descenders from different words are
        // still both counted. The line's own box is usually trustworthy.
        const y0 = Math.min(
          Math.max(line.bbox.y0, median(run.map((w) => w.bbox.y0))),
          line.bbox.y1 - 6
        );
        // Ignore words whose box starts well above the rest of the run: those
        // are stray tall boxes, not descenders belonging to this line.
        const top = median(run.map((w) => w.bbox.y0));
        const typicalHeight = median(run.map((w) => w.bbox.y1 - w.bbox.y0));
        const onLine = run.filter(
          (w) => Math.abs(w.bbox.y0 - top) <= Math.max(6, typicalHeight * 0.5)
        );
        const bottoms = (onLine.length ? onLine : run).map((w) => w.bbox.y1);
        const y1 = Math.max(y0 + 6, Math.max(...bottoms));
        const inkHeight = y1 - y0;
        const relativeHeight = inkHeight / canvasHeight;
        const alnum = (text.match(/[A-Za-z0-9]/g) || []).length;

        // The university wordmark in the corner is tiny, badly read and not
        // part of the slide's content.
        if (relativeHeight < 0.018 && x0 / canvasWidth > 0.85) continue;
        // A tall decorative glyph (icon, arrow, unit stamp) is not a line of
        // text, however confidently OCR guessed at it.
        if (relativeHeight > 0.08 && alnum < 4) continue;
        if (alnum < 3 && confidence < 60) continue;

        lines.push({
          text,
          x: x0 / canvasWidth,
          y: y0 / canvasHeight,
          w: Math.max(1, x1 - x0) / canvasWidth,
          // The ink box measured above is what the exporter should match.
          h: Math.max(6, inkHeight) / canvasHeight,
        });
      }
    }
  }

  return readingOrder(mergeCloseLines(lines));
}

// Join PDF text runs without doubling up spaces.
function joinRuns(parts) {
  let out = "";
  for (const part of parts) {
    if (!out) {
      out = part;
      continue;
    }
    if (/\s$/.test(out) || /^\s/.test(part)) out += part;
    else if (/[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(part)) out += " " + part;
    else out += part;
  }
  return out;
}

/* ───────────── page shells ───────────── */

function makeSkeleton(seed, baseHeight) {
  const el = document.createElement("div");
  el.className = "skeleton";
  el.setAttribute("aria-hidden", "true");

  // Deterministic pseudo-random so every reload looks the same-ish but each
  // page has slightly different "text" blocks.
  let s = (seed * 9301 + 49297) % 233280;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  const count = clamp(Math.round(baseHeight / 58), 4, 12);
  let y = baseHeight * 0.07;

  for (let i = 0; i < count && y < baseHeight * 0.86; i++) {
    const bar = document.createElement("span");
    bar.className = "ghost";
    bar.style.top = `${(y / baseHeight) * 100}%`;
    bar.style.left = `${7 + rnd() * 9}%`;
    bar.style.width = `${32 + rnd() * 50}%`;
    el.appendChild(bar);
    y += (i === 0 ? 18 : 12) + rnd() * 16;
  }

  return el;
}

function makePageShell(num, page) {
  const base = page.getViewport({ scale: 1 });
  const box = page.getViewport({ scale: currentScale() });
  const boxWidth = Math.max(1, Math.round(box.width));
  const boxHeight = Math.max(1, Math.round(box.height));

  const wrapper = document.createElement("div");
  wrapper.className = "page-wrapper";
  wrapper.dataset.page = String(num);
  wrapper.style.width = `${boxWidth}px`;
  wrapper.style.height = `${boxHeight}px`;

  const canvas = document.createElement("canvas");
  canvas.className = "page-canvas";
  canvas.style.width = `${boxWidth}px`;
  canvas.style.height = `${boxHeight}px`;

  const textLayer = document.createElement("div");
  textLayer.className = "text-layer";

  const chip = document.createElement("span");
  chip.className = "page-chip";
  chip.textContent = pad2(num);

  const skeleton = makeSkeleton(num, base.height);

  wrapper.append(skeleton, canvas, textLayer, chip);

  state.pages.push({
    num,
    page,
    wrapper,
    canvas,
    textLayer,
    skeleton,
    lines: null,
    spans: [],
    dim: null,
    painted: false,
    paintFailed: false,
    paintChain: Promise.resolve(),
  });

  return wrapper;
}

/* ───────────── painting & text layout ───────────── */

function paintPage(record) {
  record.paintChain = record.paintChain
    .then(() => doPaint(record))
    .catch((err) => {
      console.warn("Could not paint page", record.num, err);
      // Don't leave a shimmer running under a document that already finished.
      if (record.skeleton) record.skeleton.classList.add("stalled");
      // A page that timed out will never paint. Let the rest of the viewer
      // (and a download) carry on with whatever is already on the canvas.
      record.paintFailed = true;
      updateDownloadState();
    });
  return record.paintChain;
}

async function doPaint(record) {
  record.paintFailed = false;

  const cssScale = currentScale();
  const cssViewport = record.page.getViewport({ scale: cssScale });
  const width = Math.max(1, Math.round(cssViewport.width));
  const height = Math.max(1, Math.round(cssViewport.height));

  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP, MAX_CANVAS_WIDTH / width);
  const renderScale = cssScale * dpr;

  record.wrapper.style.width = `${width}px`;
  record.wrapper.style.height = `${height}px`;
  record.canvas.width = Math.round(width * dpr);
  record.canvas.height = Math.round(height * dpr);
  record.canvas.style.width = `${width}px`;
  record.canvas.style.height = `${height}px`;

  const task = record.page.render({
    canvasContext: record.canvas.getContext("2d"),
    viewport: record.page.getViewport({ scale: renderScale }),
  });

  try {
    await withTimeout(task.promise, RENDER_TIMEOUT);
  } catch (err) {
    if (err.timedOut) {
      try {
        task.cancel();
      } catch {
        /* already finished */
      }
    }
    throw err;
  }

  record.dim = { width, height };
  record.painted = true;
  record.wrapper.classList.add("painted");
  updateDownloadState();

  if (record.skeleton) {
    record.skeleton.remove();
    record.skeleton = null;
  }

  layoutText(record);
}

function layoutText(record) {
  if (!record.dim || !record.lines) return;

  const { width, height } = record.dim;

  if (record.spans.length !== record.lines.length) {
    record.textLayer.replaceChildren();
    record.spans = record.lines.map(() => {
      const span = document.createElement("span");
      span.className = "ocr-line";
      record.textLayer.appendChild(span);
      return span;
    });
  }

  record.lines.forEach((line, i) => {
    const span = record.spans[i];
    const size = Math.max(1, line.h * height);
    const natural = naturalWidth(line.text, size);
    const target = line.w * width;

    span.textContent = line.text + "\n";
    span.style.left = `${line.x * width}px`;
    span.style.top = `${line.y * height}px`;
    span.style.fontSize = `${size}px`;
    span.style.fontFamily = OCR_FONT;
    span.style.transform =
      natural > 0 && target > 0 ? `scaleX(${clamp(target / natural, 0.3, 3)})` : "none";
  });
}

async function extractNativeText(record) {
  const viewport = record.page.getViewport({ scale: 1 });
  const textContent = await record.page.getTextContent();
  const rows = new Map();

  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const itemHeight = Math.hypot(tx[2], tx[3]) || 12;
    const baseline = tx[5];
    const key = Math.round(baseline / 3) * 3;

    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({
      str: item.str,
      x: tx[4],
      right: tx[4] + (item.width || item.str.length * itemHeight * 0.5),
      baseline,
      height: itemHeight,
    });
  }

  // Arial is wider than most PDF display faces, so measure the real line and
  // squeeze the invisible span to the same width.
  const ascent = ascentRatio();
  const lines = [];

  for (const key of [...rows.keys()].sort((a, b) => a - b)) {
    const items = rows.get(key).sort((a, b) => a.x - b.x);
    if (!items.length) continue;

    // Cards and columns share a baseline, so the PDF hands back one row for
    // all of them. Break at the gutters so each card copies on its own.
    const gapLimit = Math.max(items[0].height * 0.9, 8);
    let group = [items[0]];

    const flush = () => {
      const text = joinRuns(group.map((i) => i.str));
      if (text.trim()) {
        const first = group[0];
        const lastX = group.reduce((max, i) => Math.max(max, i.right), first.right);
        const height = group.reduce((max, i) => Math.max(max, i.height), first.height);

        lines.push({
          text,
          x: first.x / viewport.width,
          y: (first.baseline - height * ascent) / viewport.height,
          w: Math.max(1, lastX - first.x) / viewport.width,
          h: height / viewport.height,
        });
      }
      group = [];
    };

    for (let i = 1; i < items.length; i++) {
      if (items[i].x - items[i - 1].right > gapLimit) flush();
      group.push(items[i]);
    }
    flush();
  }

  record.lines = readingOrder(lines);
  record.spans = [];
  layoutText(record);
}

/* ───────────── document flow ───────────── */

// Almost no embedded text across the sampled pages means the slides are images
// that need OCR. A low bar keeps genuinely sparse text decks off the OCR path.
const IMAGE_DECK_CHAR_LIMIT = 70;

async function estimateTextDensity(pdf) {
  // Start at page 1: a short deck's second page is often blank, which used to
  // make text-heavy files look like image scans.
  const end = Math.min(5, pdf.numPages);
  let chars = 0;

  for (let i = 1; i <= end; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    chars += textContent.items.reduce((sum, item) => sum + item.str.trim().length, 0);
  }

  return chars / end < IMAGE_DECK_CHAR_LIMIT;
}

async function runRenderPass(run, endFraction) {
  const total = state.pages.length;
  let painted = 0;

  for (const record of state.pages) {
    if (run !== state.runId) return;

    setStatus(`Rendering slide ${record.num} of ${total}…`);
    await paintPage(record);
    painted++;

    if (state.mode === "text") {
      await extractNativeText(record);
      if (record.lines.length) state.textReady++;
      state.pagesDone++;
      setCounter(state.pagesDone, total);
    }

    setProgress((endFraction * painted) / total);
    if (painted === 1) hideBoot();
  }
}

/* ───────────── OCR engine ───────────── */

// Tesseract narrates its own startup. These are the stages it reports, turned
// into something readable instead of a silent "Reading slide…" for a minute.
const ENGINE_PHASES = {
  "loading tesseract core": "Loading the OCR engine…",
  "initializing tesseract": "Waking the OCR engine up…",
  "loading language traineddata": "Loading the English model…",
  "initializing api": "Getting the reader ready…",
};

let lastProgressAt = 0;

function reportEngine(run, message) {
  if (!message || run !== state.runId) return;

  const phase = ENGINE_PHASES[message.status];
  if (phase) {
    narrate(phase);
    return;
  }

  if (message.status !== "recognizing text" || !state.activeSlide) return;

  lastProgressAt = Date.now();
  if (Date.now() - state.statusAt < 250) return;

  const pct = Math.round((message.progress || 0) * 100);
  if (pct < 2) return;
  narrate(`Reading slide ${state.activeSlide} of ${state.totalSlides}… ${pct}%`);
}

async function createOcrWorker(run) {
  return Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract-core.js"),
    langPath: chrome.runtime.getURL(""),
    workerBlobURL: false,
    gzip: true,
    logger: (message) => reportEngine(run, message),
  });
}

async function runOcrPass(run, startFraction) {
  const total = state.pages.length;
  state.ocrFailures = 0;
  state.textReady = 0;
  state.pagesDone = 0;
  state.totalSlides = total;
  state.activeSlide = 0;
  setCounter(0, total);
  setBusy(true);
  narrate("Starting the OCR engine…");

  let worker = null;

  try {
    worker = await withTimeout(createOcrWorker(run), OCR_START_TIMEOUT);
  } catch (err) {
    console.error(err);
    setBusy(false);
    state.ocrUnavailable = true;
    return false;
  }

  // If Tesseract goes quiet mid-slide, say so instead of leaving the last
  // percentage on screen forever.
  const heartbeat = setInterval(() => {
    if (run !== state.runId || !state.activeSlide) return;
    if (Date.now() - lastProgressAt < 12000) return;
    narrate(`Slide ${state.activeSlide} is taking a while. Still reading.`);
  }, 3000);

  for (const record of state.pages) {
    if (run !== state.runId) break;
    if (!worker) break;

    state.activeSlide = record.num;
    lastProgressAt = Date.now();
    narrate(`Reading slide ${record.num} of ${total}…`);

    try {
      // OCR at a sane width: slides stay legible and a 23-slide deck doesn't
      // spend a minute per page on 2600px canvases.
      const snap = document.createElement("canvas");
      const snapScale = Math.min(1, OCR_MAX_WIDTH / record.canvas.width);
      snap.width = Math.max(1, Math.round(record.canvas.width * snapScale));
      snap.height = Math.max(1, Math.round(record.canvas.height * snapScale));

      const snapCtx = snap.getContext("2d");
      snapCtx.fillStyle = "#ffffff";
      snapCtx.fillRect(0, 0, snap.width, snap.height);
      snapCtx.drawImage(record.canvas, 0, 0, snap.width, snap.height);

      const { data } = await withTimeout(worker.recognize(snap), OCR_TIMEOUT);
      const fresh = buildOcrLines(data, snap.width, snap.height);

      // If OCR comes back empty on a page that already had usable text, keep
      // the old lines instead of turning a readable page into a dead one.
      if (fresh.length || !record.lines || record.lines.length === 0) {
        record.lines = fresh;
        record.spans = [];
        layoutText(record);
      }

      if (record.lines.length) state.textReady++;
    } catch (err) {
      state.ocrFailures++;
      if (record.lines && record.lines.length) state.textReady++;
      console.warn("OCR failed on slide", record.num, err);

      state.activeSlide = 0;
      narrate(`Slide ${record.num} didn't read. Moving on.`);
      await sleep(500);

      if (err && err.timedOut) {
        // The worker is wedged on this page; rebuild it for the remaining ones.
        narrate("The OCR engine stalled. Restarting it…");
        try {
          await worker.terminate();
        } catch {
          /* ignore */
        }
        worker = null;
        try {
          worker = await withTimeout(createOcrWorker(run), OCR_START_TIMEOUT);
        } catch (createErr) {
          console.error(createErr);
        }
      }
    }

    state.activeSlide = 0;
    state.pagesDone++;
    setCounter(state.pagesDone, total);
    setProgress(startFraction + (1 - startFraction) * (record.num / total));
  }

  clearInterval(heartbeat);

  if (worker) {
    try {
      await worker.terminate();
    } catch {
      /* worker already gone */
    }
  }

  setBusy(false);
  return true;
}

function finish() {
  setProgress(1);
  dockEl.classList.add("done");
  setBusy(false);
  forceOcrBtn.hidden = state.mode === "ocr" || state.ocrUnavailable;

  if (state.ocrUnavailable) {
    setStatus(
      state.textReady > 0
        ? "OCR didn't start. Using the PDF's own text."
        : "No selectable text on this file."
    );
  } else if (state.ocrFailures > 0) {
    const label = state.ocrFailures === 1 ? "1 slide" : `${state.ocrFailures} slides`;
    setStatus(`Couldn't read ${label}. Everything else is selectable.`);
  } else if (state.textReady === 0) {
    setStatus("No text found on these slides.");
  } else {
    setStatus("Ready. Select any text.");
  }

  flushPendingExport();
}

// A download requested during OCR waits here and starts by itself as soon as
// the text pass is complete.
function flushPendingExport() {
  const format = state.pendingExport;
  if (!format || state.exporting) return;

  state.pendingExport = null;
  setStatus(`Text is ready. Preparing your ${formatLabel(format)}…`);
  exportDeck(format);
}

// Last resort when Tesseract can't start: use whatever text the PDF already carries.
async function fallBackToEmbeddedText(run) {
  state.mode = "text";
  state.textReady = 0;
  narrate("OCR didn't start. Reading the PDF's own text…");

  for (const record of state.pages) {
    if (run !== state.runId) return;
    narrate(`Reading the PDF's own text, slide ${record.num} of ${state.pages.length}…`);
    await extractNativeText(record);
    if (record.lines.length) state.textReady++;
    state.pagesDone++;
    setCounter(state.pagesDone, state.pages.length);
  }
}

// PDFs often carry the deck's own title. It is a decent fallback when the
// page around the iframe gives us nothing.
async function documentTitle(pdf) {
  try {
    const meta = await pdf.getMetadata();
    const title = meta && meta.info && meta.info.Title;
    return window.ModuleName ? ModuleName.clean(title) : String(title || "").trim();
  } catch {
    return "";
  }
}

async function openDocument(pdf) {
  const run = ++state.runId;

  state.pdf = pdf;
  if (!state.docName) state.docName = await documentTitle(pdf);
  state.pages = [];
  state.textReady = 0;
  state.pagesDone = 0;
  state.ocrFailures = 0;
  state.zoomIdx = 0;
  state.activeSlide = 0;
  state.pendingExport = null;
  zoomLabel.textContent = "Fit";
  pagesEl.replaceChildren();
  forceOcrBtn.hidden = true;
  dockEl.classList.remove("done");

  bootSubEl.textContent = "Mapping the pages…";

  const isImageDeck = await estimateTextDensity(pdf);

  const firstPage = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  state.fitScale = fitScaleFor(firstViewport.width);

  for (let n = 1; n <= pdf.numPages; n++) {
    if (run !== state.runId) return;
    const page = n === 1 ? firstPage : await pdf.getPage(n);
    pagesEl.appendChild(makePageShell(n, page));
    bootSubEl.textContent = `Mapping the pages… ${n}/${pdf.numPages}`;
  }

  setProgress(0);
  setCounter(0, pdf.numPages);
  dockEl.hidden = false;
  bootSubEl.textContent = "Opening the viewer…";
  setBusy(true);

  state.mode = isImageDeck ? "ocr" : "text";
  state.ocrUnavailable = false;

  if (isImageDeck) {
    // Paint every page first so the deck is readable right away, then read it.
    await runRenderPass(run, 0.5);
    if (run !== state.runId) return;
    const ocrStarted = await runOcrPass(run, 0.5);
    if (run !== state.runId) return;
    if (!ocrStarted) await fallBackToEmbeddedText(run);
  } else {
    await runRenderPass(run, 0.92);
  }

  if (run !== state.runId) return;
  if (!state.pages.length) hideBoot();
  finish();
}

/* ───────────── messages from content.js ───────────── */

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "PDF_ERROR") {
    handleFetchFailure(msg.message, msg.fallbackUrl);
    return;
  }

  if (msg.type === "PDF_BUFFER") {
    bootEl.classList.remove("gone", "error");
    bootTitleEl.textContent = "Opening document";
    bootSubEl.textContent = "Fetching the file…";
    bootHintEl.textContent = "Recognition runs on this machine";

    state.docName = window.ModuleName
      ? ModuleName.clean(msg.name)
      : String(msg.name || "").trim();

    state.sourceUrl = String(msg.url || "");
    state.sourceBlob = null;
    try {
      // Copy before PDF.js touches the buffer, so "Open in a new tab" still
      // has bytes to show if the worker detaches the original.
      state.sourceBlob = new Blob([msg.buffer], { type: "application/pdf" });
    } catch {
      state.sourceBlob = null;
    }
    updateDownloadState();

    try {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(msg.buffer) }).promise;
      await openDocument(pdf);
    } catch (err) {
      console.error(err);
      dockEl.hidden = true;
      showBootError("Couldn't read this PDF", err?.message || String(err));
    }
  }
});

function handleFetchFailure(message, fallbackUrl) {
  hideBoot();
  dockEl.hidden = false;
  setStatus("Using the browser's PDF viewer");
  pagesEl.replaceChildren();

  state.sourceUrl = fallbackUrl || state.sourceUrl;
  state.sourceBlob = null;
  updateDownloadState();

  const note = document.createElement("div");
  note.className = "fallback-note";
  note.textContent = message ? `Custom fetch failed — ${message}` : "Custom fetch failed";
  pagesEl.appendChild(note);

  if (fallbackUrl) {
    const frame = document.createElement("iframe");
    frame.className = "fallback-frame";
    frame.src = fallbackUrl;
    pagesEl.appendChild(frame);
  }
}

/* ───────────── zoom, resize, keys ───────────── */

function repaintPaintedPages() {
  for (const record of state.pages) {
    if (record.painted) paintPage(record);
  }
}

function setZoom(nextIdx) {
  if (state.exporting) return;

  const idx = clamp(nextIdx, 0, ZOOM_STEPS.length - 1);
  if (idx === state.zoomIdx) return;

  state.zoomIdx = idx;
  zoomLabel.textContent = idx === 0 ? "Fit" : `${Math.round(ZOOM_STEPS[idx] * 100)}%`;
  repaintPaintedPages();
}

document.querySelectorAll("[data-zoom]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.zoom;
    if (action === "in") setZoom(state.zoomIdx + 1);
    else if (action === "out") setZoom(state.zoomIdx - 1);
    else setZoom(0);
  });
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  if (!state.pdf || state.exporting) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const first = state.pages[0];
    if (!first) return;
    const base = first.page.getViewport({ scale: 1 });
    state.fitScale = fitScaleFor(base.width);
    repaintPaintedPages();
  }, 180);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    setZoom(state.zoomIdx + 1);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    setZoom(state.zoomIdx - 1);
  } else if (event.key === "0") {
    event.preventDefault();
    setZoom(0);
  }
});

/* ───────────── download ───────────── */

const EXPORT_FORMATS = {
  pdf: {
    ext: "pdf",
    type: "application/pdf",
    build: "buildPdf",
  },
  docx: {
    ext: "docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    build: "buildDocx",
  },
  pptx: {
    ext: "pptx",
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    build: "buildPptx",
  },
};

function closeDownloadMenu() {
  downloadMenu.hidden = true;
  downloadBtn.setAttribute("aria-expanded", "false");
}

function openDownloadMenu() {
  downloadMenu.hidden = false;
  downloadBtn.setAttribute("aria-expanded", "true");

  // The file is only complete once OCR has finished. Say so up front instead
  // of letting someone save a half-read deck.
  const reading = state.busy && state.mode === "ocr";
  menuNote.hidden = !reading;
  if (reading) {
    menuNote.textContent =
      "Text recognition is still running. The download starts automatically once every slide has selectable text.";
  }
}

downloadBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (downloadMenu.hidden) openDownloadMenu();
  else closeDownloadMenu();
});

document.addEventListener("click", (event) => {
  if (downloadMenu.hidden) return;
  if (downloadMenu.contains(event.target)) return;
  closeDownloadMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || downloadMenu.hidden) return;
  closeDownloadMenu();
  downloadBtn.focus();
});


function openPdfInNewTab() {
  closeDownloadMenu();

  let url = state.sourceUrl;
  let temporary = "";

  // The bytes we already fetched make a stable blob and always open in the
  // browser's PDF viewer, even when the signed URL is single-use.
  if (state.sourceBlob) {
    try {
      temporary = URL.createObjectURL(state.sourceBlob);
      url = temporary;
    } catch {
      /* fall back to the original address */
    }
  }

  if (!url) {
    setStatus("The PDF isn't ready yet.");
    return;
  }

  const opened = () => {
    setStatus("Opened the PDF in a new tab.");
  };

  if (chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(
        { action: "OPEN_TAB", url, fallbackUrl: temporary ? state.sourceUrl : "" },
        (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            const win = window.open(url, "_blank");
            if (win) {
              try {
                win.opener = null;
              } catch {
                /* cross-origin window */
              }
              opened();
            } else {
              setStatus("Allow pop-ups to open the PDF in a new tab.");
            }
          } else {
            opened();
          }
        }
      );
    } catch {
      window.open(url, "_blank");
    }
  } else {
    window.open(url, "_blank");
  }

  if (temporary) setTimeout(() => URL.revokeObjectURL(temporary), 180000);
}

openBtn.addEventListener("click", openPdfInNewTab);

function encodeJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("The browser could not encode a slide image."));
          return;
        }
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      "image/jpeg",
      0.85
    );
  });
}

function saveBlob(bytes, spec, fileName) {
  const blob = new Blob([bytes], { type: spec.type });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // The download has already been handed to the browser at this point.
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/* ───────────── editable slides for PowerPoint ───────────── */

const toHex = (r, g, b) =>
  ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();

// Slides are mostly text on a flat colour. Find that colour along the edge of
// a line's box, then paint over the glyphs so the line can be rebuilt as a
// real, editable text box instead of staying baked into the image.
function boxColour(data, width, x0, y0, x1, y1) {
  const buckets = new Map();

  const add = (x, y) => {
    const at = (y * width + x) * 4;
    const r = data[at];
    const g = data[at + 1];
    const b = data[at + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  };

  for (let x = x0; x < x1; x++) {
    add(x, y0);
    if (y1 - 1 > y0) add(x, y1 - 1);
  }
  for (let y = y0; y < y1; y++) {
    add(x0, y);
    if (x1 - 1 > x0) add(x1 - 1, y);
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }

  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
  };
}

// The text colour is whichever colour inside the box differs most from the
// background. Averaging only near-identical pixels keeps antialiased edges
// from washing the ink out to grey.
function lineColour(data, width, x0, y0, x1, y1, background) {
  let strongest = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 4;
      const dr = data[at] - background.r;
      const dg = data[at + 1] - background.g;
      const db = data[at + 2] - background.b;
      const distance = dr * dr + dg * dg + db * db;
      if (distance > strongest) strongest = distance;
    }
  }

  const lightPaper =
    background.r * 0.299 + background.g * 0.587 + background.b * 0.114 > 140;

  if (strongest < 50 * 50) {
    return lightPaper ? { r: 29, g: 29, b: 27 } : { r: 245, g: 245, b: 242 };
  }

  const floor = strongest * 0.55;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 4;
      const dr = data[at] - background.r;
      const dg = data[at + 1] - background.g;
      const db = data[at + 2] - background.b;
      if (dr * dr + dg * dg + db * db >= floor) {
        r += data[at];
        g += data[at + 1];
        b += data[at + 2];
        n++;
      }
    }
  }

  if (!n) {
    return lightPaper ? { r: 29, g: 29, b: 27 } : { r: 245, g: 245, b: 242 };
  }

  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function editableSlide(record) {
  const canvas = record.canvas;
  const width = canvas.width;
  const height = canvas.height;
  const lines = (record.lines || []).filter((line) => line.text && line.text.trim());

  if (!lines.length) return { canvas, lines: [] };

  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const styled = [];

  for (const line of lines) {
    const padX = Math.max(2, Math.round(line.h * height * 0.3));
    const padY = Math.max(2, Math.round(line.h * height * 0.28));
    const x0 = clamp(Math.floor(line.x * width) - padX, 0, width - 1);
    const y0 = clamp(Math.floor(line.y * height) - padY, 0, height - 1);
    const x1 = clamp(Math.ceil((line.x + line.w) * width) + padX, x0 + 1, width);
    const y1 = clamp(Math.ceil((line.y + line.h) * height) + padY, y0 + 1, height);

    const background = boxColour(pixels, width, x0, y0, x1, y1);
    const ink = lineColour(pixels, width, x0, y0, x1, y1, background);

    ctx.fillStyle = `rgb(${background.r}, ${background.g}, ${background.b})`;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    styled.push({ ...line, ink: toHex(ink.r, ink.g, ink.b) });
  }

  return { canvas: copy, lines: styled };
}

// If the page around the iframe gave us nothing useful, the deck's own title
// slide is the next best source. The most prominent line there is almost always
// the module name ("PROGRAMMING WITH PYTHON").
function deckTitle() {
  const record = state.pages.find((page) => page.lines && page.lines.length);
  if (!record) return "";

  let best = null;

  for (const line of record.lines) {
    const text = (line.text || "").trim();
    if (text.length < 4 || !/[A-Za-z]{3}/.test(text)) continue;

    const name = window.ModuleName ? ModuleName.clean(text) : text;
    if (!name) continue;

    const score = line.h * Math.min(name.length, 60);
    if (!best || score > best.score) best = { name, score };
  }

  return best ? best.name : "";
}

function formatLabel(format) {
  if (format === "docx") return "Word file";
  if (format === "pptx") return "PowerPoint";
  return "PDF";
}

async function exportDeck(format) {
  const spec = EXPORT_FORMATS[format];
  if (!spec || !window.Packaging || state.exporting || !state.pages.length) return;

  closeDownloadMenu();

  // Saving while OCR is halfway through is what left most slides without a
  // text layer. Queue the download instead and finish it automatically.
  if (state.busy && state.mode === "ocr") {
    state.pendingExport = format;
    setStatus(
      `Still reading the slides — the ${formatLabel(format)} will download once every page has text.`
    );
    return;
  }

  // Only a render that is still in flight should hold the download back. A
  // slide that already timed out gets saved as whatever is on its canvas.
  const waiting = state.pages.find((record) => !record.painted && !record.paintFailed);
  if (waiting) {
    setStatus(`Slide ${waiting.num} is still rendering. Try again in a moment.`);
    return;
  }

  const blank = state.pages.filter((record) => !record.painted).length;
  const baseName = state.docName || deckTitle() || "pesu-slides";

  state.exporting = true;
  updateDownloadState();

  try {
    const pages = [];

    for (const record of state.pages) {
      setStatus(`Preparing slide ${record.num} of ${state.pages.length}…`);
      // Give the status line a frame before the encoder blocks the thread.
      await sleep(24);

      const slide = format === "pptx" ? editableSlide(record) : null;
      const source = slide ? slide.canvas : record.canvas;

      pages.push({
        jpeg: await encodeJpeg(source),
        jpegWidth: source.width,
        jpegHeight: source.height,
        // The JPEG is already in canvas pixels; its aspect sets the page shape.
        width: source.width,
        height: source.height,
        lines: slide ? slide.lines : record.lines || [],
      });
    }

    const label = formatLabel(format);
    setStatus(`Building the ${label}…`);
    // Let that message land before the ZIP/PDF writer runs.
    await sleep(60);

    const fileName = `${baseName}.${spec.ext}`;
    saveBlob(window.Packaging[spec.build](pages), spec, fileName);

    if (blank) {
      setStatus(`${fileName} saved. ${blank} slide${blank === 1 ? "" : "s"} came out blank.`);
    } else {
      setStatus(`Saved ${fileName}.`);
    }
  } catch (err) {
    console.error(err);
    setStatus("Download failed. Try a different format.");
  } finally {
    state.exporting = false;
    updateDownloadState();
  }
}

downloadMenu.querySelectorAll("[data-format]").forEach((item) => {
  item.addEventListener("click", () => exportDeck(item.dataset.format));
});

/* ───────────── force OCR ───────────── */

forceOcrBtn.addEventListener("click", async () => {
  if (state.busy || state.exporting) return;

  forceOcrBtn.hidden = true;
  const run = ++state.runId;
  const previousMode = state.mode;
  const previousReady = state.textReady;
  const previousPages = state.pagesDone;
  state.mode = "ocr";
  state.ocrUnavailable = false;

  setProgress(0);
  const ocrStarted = await runOcrPass(run, 0);
  if (run !== state.runId) return;

  if (!ocrStarted) {
    // Nothing was overwritten yet, so the original text layers are still intact.
    state.mode = previousMode;
    state.textReady = previousReady;
    state.pagesDone = previousPages;
    setCounter(previousPages, state.pages.length);
  }

  finish();
});

/* ───────────── nudge if nothing ever arrives ───────────── */

setTimeout(() => {
  if (!dockEl.hidden) return;
  if (bootEl.classList.contains("gone")) return;
  bootHintEl.textContent = "Still waiting — reload if this hangs";
}, 8000);
