// Works out what the current course module is called so downloads are named
// after it instead of a generic "pesu-slides". Runs on the PESU page and in the
// viewer (the viewer only needs `clean`).
(function () {
  "use strict";

  const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

  // Page furniture that is never the module name.
  const GENERIC =
    /^(pesu\s*academy|pesuacademy|academy|home|dashboard|my\s*courses?|my\s*learning|profile(?:\s*(?:my\s*)?courses?)?|student portal|student profile|student|learner|course|module|unit|topic|chapter|content|course content|study material|study materials|materials?|resources?|slides?|notes?|documents?|files?|downloads?|syllabus|announcements?|menu|logout|search|pdf|embedded pdf|pdf document|pdf viewer|document|document viewer|viewer|preview|document preview|untitled|presentation|powerpoint presentation|microsoft powerpoint|microsoft word|slide\s*\d+|page\s*\d+)$/i;

  function clean(raw, fallback = "") {
    if (!raw) return fallback;

    let text = String(raw).replace(/\s+/g, " ").trim();

    // "Operating Systems - PESU Academy", "PESU Academy | Operating Systems"
    text = text.replace(/[\s|·•]+(pesu\s*academy|pesuacademy).*$/i, "");
    text = text.replace(/\s*[-–—]\s*(pesu\s*academy|pesuacademy).*$/i, "");
    text = text.replace(/^(pesu\s*academy|pesuacademy)\s*[-–—|:]\s*/i, "");

    text = text.replace(/^(download|view|open)\s+/i, "");
    text = text.replace(/^microsoft (powerpoint|word)\s*[-–—]\s*/i, "");
    text = text.replace(/\.(pdf|pptx?|docx?|txt)$/i, "");
    text = text.replace(BAD_CHARS, " ");
    text = text.replace(/\s+/g, " ").trim();
    text = text.replace(/^[\s.\-_]+|[\s.\-_]+$/g, "");

    if (!text || GENERIC.test(text)) return fallback;
    if (text.length < 3) return fallback;
    if (text.length > 90) text = text.slice(0, 90).replace(/[\s.\-_]+$/, "");

    return text;
  }

  // Some PESU links carry the real file name as a query parameter.
  function nameFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      return "";
    }

    const keys = [
      "filename",
      "fileName",
      "documentName",
      "docName",
      "courseName",
      "subjectName",
      "moduleName",
    ];

    for (const key of keys) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const name = clean(value);
      // Skip opaque tokens/signatures that happen to sit in a name-ish param.
      if (name && /\s|[A-Za-z]{2}/.test(name) && name.length >= 4) return name;
    }

    return "";
  }

  function textOf(node) {
    if (!node) return "";
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  }

  function usable(text) {
    return text && text.length >= 3 && text.length <= 120 && !GENERIC.test(text);
  }

  // Walk up from the iframe and take the last heading that sits above it in
  // the nearest container. That is usually the module title on the page.
  function headingNear(iframe) {
    const broad = [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "legend",
      "caption",
      '[class*="title" i]',
      '[class*="heading" i]',
      '[id*="title" i]',
      '[id*="heading" i]',
    ].join(",");

    // At page level, only trust real headings and explicitly named fields;
    // generic card titles would otherwise win by being the closest match.
    const narrow = [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "legend",
      "caption",
      '[class*="courseName" i]',
      '[id*="courseName" i]',
      '[class*="subjectName" i]',
      '[id*="subjectName" i]',
      '[class*="moduleName" i]',
      '[id*="moduleName" i]',
      '[class*="topicName" i]',
      '[id*="topicName" i]',
    ].join(",");

    let node = iframe;
    for (let depth = 0; depth < 8 && node; depth++) {
      const parent = node.parentElement;
      if (!parent) break;

      const selector = parent === document.body ? narrow : broad;
      let found = "";
      for (const el of parent.querySelectorAll(selector)) {
        if (el === iframe || el.contains(iframe)) continue;
        if (el.closest('nav, aside, [class*="navbar" i], [class*="menu" i], [class*="sidebar" i]')) {
          continue;
        }

        const text = textOf(el);
        if (!usable(text)) continue;

        // `el` must come before the branch that contains the iframe.
        const position = node.compareDocumentPosition(el);
        if (position & Node.DOCUMENT_POSITION_PRECEDING) found = text;
      }

      if (found) return clean(found);
      if (parent === document.body) break;
      node = parent;
    }

    return "";
  }

  function breadcrumbName() {
    const crumb = document.querySelector(
      '[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]'
    );
    if (!crumb) return "";

    const parts = crumb.querySelectorAll("a, span, li");
    for (let i = parts.length - 1; i >= 0; i--) {
      const text = textOf(parts[i]);
      if (usable(text)) return clean(text);
    }

    return "";
  }

  function labelledName() {
    const selectors = [
      '[class*="courseName" i]',
      '[id*="courseName" i]',
      '[class*="subjectName" i]',
      '[id*="subjectName" i]',
      '[class*="moduleName" i]',
      '[id*="moduleName" i]',
      '[class*="topicName" i]',
      '[id*="topicName" i]',
      '[class*="lessonName" i]',
      '[id*="lessonName" i]',
    ];

    for (const el of document.querySelectorAll(selectors.join(","))) {
      const text = textOf(el);
      if (usable(text)) return clean(text);
    }

    return "";
  }

  function fromIframe(iframe, pdfUrl) {
    const label = clean(
      iframe.getAttribute("title") ||
        iframe.getAttribute("aria-label") ||
        iframe.dataset.title ||
        iframe.dataset.name
    );
    if (label) return label;

    return (
      headingNear(iframe) ||
      nameFromUrl(pdfUrl) ||
      breadcrumbName() ||
      labelledName() ||
      clean(document.title)
    );
  }

  window.ModuleName = { clean, fromIframe };
})();
