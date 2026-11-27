// Extra helpers for PESU Academy:
//   1. PYQ search: on the MyCourses page, list each course and fetch all its
//      question papers from the PESU library Koha OPAC, keyed by course code
//      (the library files QPs under the subject part of the code, so
//      UE20CS301 is searched as CS301 — same trick as PESU-MAX).
//   2. Desktop notifications when a course page gains new slides/assignments.
(function () {
  "use strict";

  if (window.__pesuExtraFeatures) return;
  window.__pesuExtraFeatures = true;

  const PYQ_SUBJECT_KEY = "pesuPyqSubject";
  const SEEN_KEY = "pesuSeenItems";
  const PYQ_BASE = "http://1.6.83.11:8081/cgi-bin/koha/opac-search.pl";
  const PYQ_PAGE_SIZE = 20; // Koha shows 20 hits per page
  const PYQ_MAX_PAGES = 5; // safety cap: 100 papers per subject

  /* ───────────── course/subject detection (MyCourses page) ───────────── */

  // PESU renders courses as rows: <tr id="rowWiseCourseContent_..."> with
  // cells: [Course Code, Course Title, Course Type, Status, Action].
  function courseRows() {
    return Array.from(document.querySelectorAll('tr[id^="rowWiseCourseContent_"]'));
  }

  function courseTitle(row) {
    const cells = row.querySelectorAll("td");
    // second cell holds the title (with possible whitespace/newlines)
    const raw = cells.length >= 2 ? cells[1].textContent : "";
    return String(raw || "").replace(/\s+/g, " ").trim();
  }

  function courseCode(row) {
    const cells = row.querySelectorAll("td");
    const raw = cells.length >= 1 ? cells[0].textContent : "";
    return String(raw || "").replace(/\s+/g, " ").trim().split(/\s/)[0];
  }

  function detectCourses() {
    const byKey = new Map();
    courseRows().forEach((row) => {
      const code = courseCode(row);
      const title = courseTitle(row);
      if (!code && !title) return;
      const key = code || title;
      if (!byKey.has(key)) byKey.set(key, { code, title });
    });
    return Array.from(byKey.values());
  }

  /* ── course code → library subject key (adapted from PESU-MAX) ──────
     The library catalogues each QP under the subject part of the course
     code: UE20CS301 is filed as "(CS301)", UE24CS251A as "(CS251)".
     Searching Koha with the full code finds nothing, so strip the scheme
     prefix and any section suffix first (cf. ndigvijay/PESU-MAX
     src/helpers/libraryPaperLinks.js → subjectKeyFromCourseCode). */

  const SCHEME_PATTERN = /^[A-Z]{2}\d{2}(?=[A-Z])/;

  function subjectKeyFromCourseCode(courseCode) {
    const code = String(courseCode || "").trim().toUpperCase();
    const subjectKey = code.replace(SCHEME_PATTERN, "");
    return subjectKey.length >= 4 ? subjectKey : code;
  }

  // Every subject key worth trying for a code, most specific first:
  //   UE24CS251A   -> ["CS251A", "CS251"]
  //   UE21CS342AA1 -> ["CS342AA1", "CS342"]
  //   UE20CS301    -> ["CS301"]
  function searchKeysForCode(courseCode) {
    const code = String(courseCode || "").trim().toUpperCase();
    if (!code) return [];
    const keys = [];
    const add = (k) => {
      const v = String(k || "").trim().toUpperCase();
      if (v.length >= 4 && keys.indexOf(v) === -1) keys.push(v);
    };
    const subjectKey = subjectKeyFromCourseCode(code);
    add(subjectKey);
    add(subjectKey.replace(/[A-Z]+$/, "")); // drop section suffix: CS251A -> CS251
    add((subjectKey.match(/^[A-Z]{2,4}\d{3}/) || [""])[0]); // dept + number only
    return keys;
  }

  // Trailing "(CODE)" group of a QP title -> individual codes.
  //   "… PESIT Autonomous (CS301)"           -> ["CS301"]
  //   "… PESIT Autonomous (CS255/CS301)"     -> ["CS255", "CS301"]
  function trailingCourseCodes(title) {
    const m = String(title || "").match(/\(([A-Z0-9/ -]+)\)\s*$/i);
    if (!m) return [];
    return m[1].split(/[\/,\s-]+/).filter(Boolean);
  }

  // Keep only papers whose catalogue code maps back to one of our keys.
  // Returns [] when nothing matches so the caller can try the next query.
  function filterBySubjectKeys(results, keys) {
    if (!keys || keys.length === 0) return results;
    const wanted = keys.map((k) => k.toUpperCase());
    const strict = results.filter((r) =>
      trailingCourseCodes(r.title).some((c) => {
        const sk = subjectKeyFromCourseCode(c);
        return wanted.some((k) => sk === k || sk.startsWith(k) || k.startsWith(sk));
      })
    );
    if (strict.length) return strict;
    // Titles with the key in parentheses somewhere, not just at the end.
    return results.filter((r) =>
      wanted.some((k) => new RegExp(`\\(${k}\\)`, "i").test(r.title))
    );
  }

  /* ───────────── Koha PYQ search ───────────── */

  function kohaUrl(query) {
    return `${PYQ_BASE}?idx=&q=${encodeURIComponent(query)}&weight_search=1`;
  }

  function parseHtml(html) {
    try {
      return new DOMParser().parseFromString(html, "text/html");
    } catch {
      return null;
    }
  }

  function parseKohaResults(doc) {
    const results = [];
    if (!doc) return results;
    const links = doc.querySelectorAll("a[href*='biblionumber']");
    links.forEach((a) => {
      if (!a.classList.contains("title")) return;
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      let href = a.getAttribute("href") || "";
      if (href && !/^https?:/i.test(href)) {
        href = "http://1.6.83.11:8081" + (href.startsWith("/") ? "" : "/") + href;
      }
      if (title && title.length > 3) results.push({ title, href });
    });
    const seen = new Set();
    return results.filter((r) => {
      if (seen.has(r.title)) return false;
      seen.add(r.title);
      return true;
    });
  }

  // "Results of search for '…', page 2 of 542" -> 542
  function kohaPageCount(doc) {
    const text = doc && doc.body ? doc.body.textContent : "";
    const m = text.match(/page\s+\d+\s+of\s+(\d+)/i);
    return m ? parseInt(m[1], 10) || 1 : 1;
  }

  // Fetch every results page for one query so all QPs of a subject list,
  // even when Koha would only show the first 20.
  function fetchKohaPages(query, onDone) {
    const baseUrl = kohaUrl(query);

    if (!chrome.runtime?.id) {
      window.open(baseUrl, "_blank");
      onDone([], baseUrl);
      return;
    }

    const collected = [];
    const seen = new Set();

    const loadPage = (offset) => {
      const url = offset ? `${baseUrl}&offset=${offset}` : baseUrl;
      chrome.runtime.sendMessage({ action: "FETCH_PYQ", url }, (res) => {
        if (!res || !res.ok) {
          onDone(collected, baseUrl);
          return;
        }
        const doc = parseHtml(res.html || "");
        const pageCount = kohaPageCount(doc);
        parseKohaResults(doc).forEach((r) => {
          const id = r.href || r.title;
          if (!seen.has(id)) {
            seen.add(id);
            collected.push(r);
          }
        });
        const nextPage = Math.floor(offset / PYQ_PAGE_SIZE) + 1;
        if (nextPage < pageCount && nextPage < PYQ_MAX_PAGES) {
          loadPage(nextPage * PYQ_PAGE_SIZE);
        } else {
          onDone(collected, baseUrl);
        }
      });
    };
    loadPage(0);
  }

  // Try the course-code subject keys first, then the raw code, then the
  // title. If no query matches the keys, fall back to the best unfiltered
  // result (flagged so the panel can say so).
  function runPyqSearch(course, onDone) {
    const code = String(course.code || "").trim().toUpperCase();
    const title = String(course.title || "").trim();
    const keys = searchKeysForCode(code);
    const queries = [];
    keys.forEach((k) => queries.push(`${k})`));
    if (code && queries.indexOf(code) === -1) queries.push(code);
    if (title) queries.push(title);
    if (queries.length === 0) {
      onDone([], "", "", false);
      return;
    }

    let fallback = null;
    let index = 0;
    const next = () => {
      if (index >= queries.length) {
        if (fallback) onDone(fallback.results, fallback.url, fallback.query, true);
        else onDone([], kohaUrl(queries[0]), queries[0], false);
        return;
      }
      const query = queries[index++];
      fetchKohaPages(query, (results) => {
        const filtered = filterBySubjectKeys(results, keys);
        if (filtered.length > 0) {
          onDone(filtered, kohaUrl(query), query, false);
          return;
        }
        if (results.length > 0 && !fallback) {
          fallback = { results, url: kohaUrl(query), query };
        }
        next();
      });
    };
    next();
  }

  /* ───────────── UI panel ───────────── */

  let panel = null;

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement("div");
    panel.id = "pesu-pyq-panel";
    Object.assign(panel.style, {
      position: "fixed",
      right: "16px",
      bottom: "60px",
      width: "440px",
      maxHeight: "70vh",
      overflow: "auto",
      zIndex: "2147483647",
      background: "#1b1a17",
      color: "#e7e6e1",
      border: "1px solid #34363b",
      borderRadius: "10px",
      padding: "12px",
      font: "12.5px/1.4 system-ui, sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
    });
    (document.body || document.documentElement).appendChild(panel);
    return panel;
  }

  function renderCourseList(courses, onPick) {
    const p = ensurePanel();
    p.innerHTML = "";
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "8px";
    const title = document.createElement("strong");
    title.textContent = "Courses in this semester";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.background = "transparent";
    close.style.color = "#e7e6e1";
    close.style.border = "none";
    close.style.cursor = "pointer";
    close.style.fontSize = "14px";
    close.addEventListener("click", () => p.remove());
    header.appendChild(title);
    header.appendChild(close);
    p.appendChild(header);

    if (!courses || courses.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No courses detected on this page.";
      p.appendChild(empty);
      return;
    }

    const hint = document.createElement("div");
    hint.textContent = "Click a course — QPs are searched by its course code:";
    hint.style.color = "#9a9c9e";
    hint.style.marginBottom = "6px";
    p.appendChild(hint);

    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexWrap = "wrap";
    list.style.gap = "6px";
    courses.forEach((c) => {
      const chip = document.createElement("button");
      chip.title = c.title || c.code;
      const label = document.createElement("span");
      label.textContent = c.code || c.title;
      label.style.fontWeight = "600";
      chip.appendChild(label);
      if (c.code && c.title) {
        const sub = document.createElement("span");
        sub.textContent = c.title.length > 30 ? `${c.title.slice(0, 29)}…` : c.title;
        Object.assign(sub.style, {
          display: "block",
          fontWeight: "400",
          fontSize: "10.5px",
          opacity: "0.72",
          marginTop: "2px",
        });
        chip.appendChild(sub);
      }
      Object.assign(chip.style, {
        background: "#2a2b2f",
        color: "#e7e6e1",
        border: "1px solid #34363b",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
      });
      chip.addEventListener("click", () => onPick(c));
      list.appendChild(chip);
    });
    p.appendChild(list);

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "6px";
    row.style.marginTop = "10px";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Or type a course code (e.g. UE20CS301)";
    Object.assign(input.style, {
      flex: "1",
      padding: "6px",
      background: "#212226",
      color: "#e7e6e1",
      border: "1px solid #34363b",
      borderRadius: "6px",
    });
    const go = document.createElement("button");
    go.textContent = "Go";
    Object.assign(go.style, {
      padding: "6px 10px",
      background: "#d3a963",
      color: "#1b1a17",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
      fontWeight: "600",
    });
    go.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) return;
      const upper = v.toUpperCase();
      // A course code (CS301, UE20CS301, UQ26CA641A) is searched by code;
      // anything else is treated as a title/keyword query.
      if (/^[A-Z]{2,4}\d{3}[A-Z0-9]*$/.test(upper)) onPick({ code: upper, title: "" });
      else onPick({ code: "", title: v });
    });
    row.appendChild(input);
    row.appendChild(go);
    p.appendChild(row);
  }

  function showResults(course, results, fallbackUrl, query, isFallback) {
    const p = ensurePanel();
    p.innerHTML = "";
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "8px";
    const title = document.createElement("strong");
    title.textContent = `QPs: ${course.code || query}`;
    const back = document.createElement("button");
    back.textContent = "← courses";
    back.style.background = "transparent";
    back.style.color = "#9a9c9e";
    back.style.border = "none";
    back.style.cursor = "pointer";
    back.addEventListener("click", () => renderCourseList(detectCourses(), pickCourse));
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.background = "transparent";
    close.style.color = "#e7e6e1";
    close.style.border = "none";
    close.style.cursor = "pointer";
    close.style.fontSize = "14px";
    close.addEventListener("click", () => p.remove());
    header.appendChild(title);
    const right = document.createElement("div");
    right.appendChild(back);
    right.appendChild(close);
    header.appendChild(right);
    p.appendChild(header);

    if (course.code && course.title) {
      const sub = document.createElement("div");
      sub.textContent = course.title;
      sub.style.color = "#9a9c9e";
      sub.style.marginBottom = "6px";
      p.appendChild(sub);
    }

    if (isFallback && query) {
      const note = document.createElement("div");
      note.textContent = `No papers matched the course code — showing every library result for “${query}”.`;
      note.style.color = "#e0a458";
      note.style.marginBottom = "6px";
      p.appendChild(note);
    }

    if (!results || results.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No results parsed. ";
      const link = document.createElement("a");
      link.textContent = "Open library search";
      link.href = fallbackUrl || kohaUrl(query || "");
      link.target = "_blank";
      link.style.color = "#d3a963";
      empty.appendChild(link);
      p.appendChild(empty);
      return;
    }

    const count = document.createElement("div");
    count.textContent = `${results.length} question paper(s) found:`;
    count.style.color = "#9a9c9e";
    count.style.marginBottom = "6px";
    p.appendChild(count);

    const list = document.createElement("ul");
    list.style.listStyle = "none";
    list.style.padding = "0";
    list.style.margin = "0";
    results.forEach((r) => {
      const li = document.createElement("li");
      li.style.padding = "6px 0";
      li.style.borderBottom = "1px solid #2a2b2f";
      const a = document.createElement("a");
      a.textContent = r.title;
      a.href = r.href || fallbackUrl;
      a.target = "_blank";
      a.style.color = "#d3a963";
      a.style.textDecoration = "none";
      li.appendChild(a);
      list.appendChild(li);
    });
    p.appendChild(list);
  }

  function pickCourse(course) {
    const label = course.code || course.title || "";
    try {
      chrome.storage.local.set({ [PYQ_SUBJECT_KEY]: label });
    } catch {
      /* ignore */
    }
    const p = ensurePanel();
    p.innerHTML = "";
    const loading = document.createElement("div");
    loading.textContent = `Fetching QPs for ${label}…`;
    p.appendChild(loading);
    runPyqSearch(course, (results, url, query, isFallback) =>
      showResults(course, results, url, query, isFallback)
    );
  }

  /* ───────────── inline PYQ links on course rows ───────────── */

  function injectInlinePyqLinks() {
    courseRows().forEach((row) => {
      if (row.dataset.pesuPyq === "1") return;
      const code = courseCode(row);
      const title = courseTitle(row);
      if (!code && !title) return;
      row.dataset.pesuPyq = "1";

      // Put the link in the Action cell (last td) to avoid row click navigation.
      const cells = row.querySelectorAll("td");
      const actionCell = cells.length >= 5 ? cells[cells.length - 1] : cells[cells.length - 1];
      if (!actionCell) return;

      const link = document.createElement("a");
      link.textContent = "PYQs";
      link.href = "#";
      link.title = code ? `Question papers for ${code}` : `Question papers for ${title}`;
      Object.assign(link.style, {
        display: "inline-block",
        padding: "2px 8px",
        background: "#d3a963",
        color: "#1b1a17",
        borderRadius: "4px",
        textDecoration: "none",
        fontSize: "11px",
        fontWeight: "600",
        cursor: "pointer",
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Search by course code, not by the (often unfindable) title.
        pickCourse({ code, title });
      });
      // Avoid triggering row onclick.
      link.addEventListener("mousedown", (e) => e.stopPropagation());
      actionCell.appendChild(link);
    });
  }

  /* ───────────── floating button ───────────── */

  function injectPyqButton() {
    if (document.getElementById("pesu-pyq-btn")) return;

    const btn = document.createElement("button");
    btn.id = "pesu-pyq-btn";
    btn.type = "button";
    btn.textContent = "PYQs";
    btn.title = "Browse previous-year question papers by course";
    Object.assign(btn.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      padding: "8px 12px",
      border: "none",
      borderRadius: "8px",
      background: "#1b1a17",
      color: "#e7e6e1",
      font: "600 12px/1.2 system-ui, sans-serif",
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
    });

    btn.addEventListener("click", () => {
      renderCourseList(detectCourses(), pickCourse);
    });

    (document.body || document.documentElement).appendChild(btn);
  }

  /* ───────────── update notifications ───────────── */

  function collectItems() {
    const items = new Set();
    const anchors = document.querySelectorAll("a[href]");
    anchors.forEach((a) => {
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      const href = a.getAttribute("href") || "";
      if (!text || text.length < 3) return;
      if (!/slide|assignment|unit|module|doc|pdf|note|material|lab/i.test(text + " " + href)) return;
      items.add(text + "::" + href);
    });
    return Array.from(items);
  }

  function pageKey() {
    return "page:" + location.pathname + location.search;
  }

  async function checkForUpdates() {
    if (!chrome.runtime?.id || !chrome.storage?.local) return;

    const current = collectItems();
    if (current.length === 0) return;

    let stored = {};
    try {
      stored = await new Promise((resolve) => {
        chrome.storage.local.get({ [SEEN_KEY]: {} }, (r) => resolve(r || {}));
      });
    } catch {
      return;
    }

    const seen = (stored && stored[SEEN_KEY]) || {};
    const key = pageKey();
    const previous = new Set(seen[key] || []);
    const novel = current.filter((item) => !previous.has(item));

    if (previous.size > 0 && novel.length > 0) {
      const message =
        novel.length === 1
          ? `New item: ${novel[0].split("::")[0]}`
          : `${novel.length} new items on this page`;
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          title: "PESU Academy update",
          message,
          priority: 1,
        });
      } catch {
        /* notifications permission may be absent */
      }
    }

    seen[key] = current;
    const keys = Object.keys(seen);
    if (keys.length > 50) {
      keys.slice(0, keys.length - 50).forEach((k) => delete seen[k]);
    }
    try {
      chrome.storage.local.set({ [SEEN_KEY]: seen });
    } catch {
      /* ignore */
    }
  }

  /* ───────────── wire up ───────────── */

  function run() {
    injectPyqButton();
    injectInlinePyqLinks();
    checkForUpdates();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }

  let queued = 0;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = setTimeout(() => {
      queued = 0;
      injectInlinePyqLinks();
    }, 600);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(checkForUpdates, 5 * 60 * 1000);
})();
