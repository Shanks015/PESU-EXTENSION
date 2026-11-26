// Extra helpers for PESU Academy:
//   1. PYQ search: list subjects in the course and fetch all question papers
//      for a subject from the PESU library Koha OPAC.
//   2. Desktop notifications when a course page gains new slides/assignments.
(function () {
  "use strict";

  if (window.__pesuExtraFeatures) return;
  window.__pesuExtraFeatures = true;

  const PYQ_SUBJECT_KEY = "pesuPyqSubject";
  const SEEN_KEY = "pesuSeenItems";
  const PYQ_BASE = "http://1.6.83.11:8081/cgi-bin/koha/opac-search.pl";

  /* ───────────── subject detection ───────────── */

  function cleanSubject(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/profile\s*\|\s*mycourses/gi, "")
      .replace(/[^\w\s&\-().]/g, "")
      .trim()
      .slice(0, 80);
  }

  const GENERIC = /^(home|dashboard|profile|mycourses|courses|subjects|units?|modules?|notes?|slides?|assignments?|attendance|results?|grade|settings|logout|login)$/i;

  function detectSubjects() {
    const set = new Set();
    const selectors = [
      "h1", "h2", "h3", "h4",
      "li", "td", "th",
      ".subject", ".course", ".course-name", ".subject-name",
      "[class*='subject']", "[class*='course']",
    ];
    document.querySelectorAll(selectors.join(",")).forEach((el) => {
      // Only leaf-ish text nodes.
      if (el.children.length > 3) return;
      const text = cleanSubject(el.textContent);
      if (!text || text.length < 4 || text.length > 60) return;
      if (GENERIC.test(text)) return;
      // Skip if it's just a number or very short.
      if (/^\d+$/.test(text)) return;
      set.add(text);
    });
    return Array.from(set).slice(0, 40);
  }

  /* ───────────── Koha PYQ search ───────────── */

  function kohaUrl(subject) {
    return `${PYQ_BASE}?idx=&q=${encodeURIComponent(subject)}&weight_search=1`;
  }

  function parseKohaResults(html) {
    const results = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
      return results;
    }
    const links = doc.querySelectorAll("a[href*='biblionumber']");
    links.forEach((a) => {
      // Only the title links have class 'title'.
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

  function fetchPyqs(subject, onDone) {
    const url = kohaUrl(subject);
    if (!chrome.runtime?.id) {
      window.open(url, "_blank");
      if (onDone) onDone([], url);
      return;
    }
    chrome.runtime.sendMessage({ action: "FETCH_PYQ", url }, (res) => {
      if (!res || !res.ok) {
        window.open(url, "_blank");
        if (onDone) onDone([], url);
        return;
      }
      const results = parseKohaResults(res.html || "");
      if (onDone) onDone(results, url);
    });
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
      width: "420px",
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

  function renderSubjectList(subjects, onPick) {
    const p = ensurePanel();
    p.innerHTML = "";
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "8px";
    const title = document.createElement("strong");
    title.textContent = "Subjects in this course";
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

    if (!subjects || subjects.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No subjects detected on this page.";
      p.appendChild(empty);
      return;
    }

    const hint = document.createElement("div");
    hint.textContent = "Click a subject to fetch all its question papers:";
    hint.style.color = "#9a9c9e";
    hint.style.marginBottom = "6px";
    p.appendChild(hint);

    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexWrap = "wrap";
    list.style.gap = "6px";
    subjects.forEach((s) => {
      const chip = document.createElement("button");
      chip.textContent = s;
      Object.assign(chip.style, {
        background: "#2a2b2f",
        color: "#e7e6e1",
        border: "1px solid #34363b",
        borderRadius: "6px",
        padding: "4px 8px",
        cursor: "pointer",
        font: "inherit",
      });
      chip.addEventListener("click", () => onPick(s));
      list.appendChild(chip);
    });
    p.appendChild(list);

    // Manual input.
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "6px";
    row.style.marginTop = "10px";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Or type a subject name";
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
      if (v) onPick(v);
    });
    row.appendChild(input);
    row.appendChild(go);
    p.appendChild(row);
  }

  function showResults(subject, results, fallbackUrl) {
    const p = ensurePanel();
    p.innerHTML = "";
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "8px";
    const title = document.createElement("strong");
    title.textContent = `QPs: ${subject}`;
    const back = document.createElement("button");
    back.textContent = "← subjects";
    back.style.background = "transparent";
    back.style.color = "#9a9c9e";
    back.style.border = "none";
    back.style.cursor = "pointer";
    back.addEventListener("click", () => renderSubjectList(detectSubjects(), pickSubject));
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

    if (!results || results.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No results parsed. ";
      const link = document.createElement("a");
      link.textContent = "Open library search";
      link.href = fallbackUrl;
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

  function pickSubject(subject) {
    try {
      chrome.storage.local.set({ [PYQ_SUBJECT_KEY]: subject });
    } catch {
      /* ignore */
    }
    const p = ensurePanel();
    p.innerHTML = "";
    const loading = document.createElement("div");
    loading.textContent = `Fetching QPs for "${subject}"…`;
    p.appendChild(loading);
    fetchPyqs(subject, (results, url) => showResults(subject, results, url));
  }

  function injectPyqButton() {
    if (document.getElementById("pesu-pyq-btn")) return;

    const btn = document.createElement("button");
    btn.id = "pesu-pyq-btn";
    btn.type = "button";
    btn.textContent = "PYQs";
    btn.title = "Browse previous-year question papers by subject";
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
      renderSubjectList(detectSubjects(), pickSubject);
    });

    (document.body || document.documentElement).appendChild(btn);
  }

  function injectInlinePyqLinks() {
    const titles = document.querySelectorAll("h3, h4, .subject, .course-name");
    titles.forEach((el) => {
      if (el.dataset.pesuPyq === "1") return;
      const text = cleanSubject(el.textContent);
      if (!text || text.length < 4 || text.length > 80) return;
      if (GENERIC.test(text)) return;
      el.dataset.pesuPyq = "1";

      const link = document.createElement("a");
      link.textContent = " (PYQs)";
      link.href = "#";
      link.style.fontSize = "0.85em";
      link.style.marginLeft = "6px";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        pickSubject(text);
      });
      el.appendChild(link);
    });
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
