// Extra helpers for PESU Academy:
//   1. Quick search for previous-year question papers (PYQs) per subject,
//      fetched from the PESU library Koha OPAC.
//   2. Desktop notifications when a course page gains new slides/assignments.
(function () {
  "use strict";

  if (window.__pesuExtraFeatures) return;
  window.__pesuExtraFeatures = true;

  const PYQ_SUBJECT_KEY = "pesuPyqSubject";
  const SEEN_KEY = "pesuSeenItems";
  const PYQ_BASE = "http://1.6.83.11:8081/cgi-bin/koha/opac-search.pl";

  /* ───────────── subject guessing ───────────── */

  function cleanSubject(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/profile\s*\|\s*mycourses/gi, "")
      .trim()
      .slice(0, 80);
  }

  function guessSubject() {
    const candidates = [
      document.title,
      (document.querySelector("h1, h2, .page-title, .subject-name, .course-name") || {}).textContent,
    ];
    for (const c of candidates) {
      const t = cleanSubject(c);
      if (t && t.length > 3) return t;
    }
    // Fall back to a query param if present.
    const m = location.search.match(/[?&](subject|course|name)=([^&]+)/i);
    if (m) return cleanSubject(decodeURIComponent(m[2]));
    return "";
  }

  /* ───────────── Koha PYQ search ───────────── */

  function kohaUrl(subject) {
    return `${PYQ_BASE}?idx=&q=${encodeURIComponent(subject)}&weight_search=1`;
  }

  function parseKohaResults(html) {
    const results = [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Koha result entries: links to detail pages (biblionumber) with a title.
    const links = doc.querySelectorAll("a[href*='biblionumber'], a.title, .title a");
    links.forEach((a) => {
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      let href = a.getAttribute("href") || "";
      if (href && !/^https?:/i.test(href)) {
        href = "http://1.6.83.11:8081" + (href.startsWith("/") ? "" : "/") + href;
      }
      if (title && title.length > 3) results.push({ title, href });
    });
    // De-dupe by title.
    const seen = new Set();
    return results.filter((r) => {
      if (seen.has(r.title)) return false;
      seen.add(r.title);
      return true;
    });
  }

  function showPyqPanel(subject, results, fallbackUrl) {
    let panel = document.getElementById("pesu-pyq-panel");
    if (panel) panel.remove();

    panel = document.createElement("div");
    panel.id = "pesu-pyq-panel";
    Object.assign(panel.style, {
      position: "fixed",
      right: "16px",
      bottom: "60px",
      width: "360px",
      maxHeight: "60vh",
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

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "8px";
    const title = document.createElement("strong");
    title.textContent = `PYQs: ${subject || "(no subject)"}`;
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.background = "transparent";
    close.style.color = "#e7e6e1";
    close.style.border = "none";
    close.style.cursor = "pointer";
    close.style.fontSize = "14px";
    close.addEventListener("click", () => panel.remove());
    header.appendChild(title);
    header.appendChild(close);
    panel.appendChild(header);

    if (!results || results.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No results parsed. ";
      const link = document.createElement("a");
      link.textContent = "Open library search";
      link.href = fallbackUrl;
      link.target = "_blank";
      link.style.color = "#d3a963";
      empty.appendChild(link);
      panel.appendChild(empty);
    } else {
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
      panel.appendChild(list);
    }

    (document.body || document.documentElement).appendChild(panel);
  }

  function fetchPyqs(subject) {
    const url = kohaUrl(subject);
    if (!chrome.runtime?.id) {
      window.open(url, "_blank");
      return;
    }
    chrome.runtime.sendMessage({ action: "FETCH_PYQ", url }, (res) => {
      if (!res || !res.ok) {
        window.open(url, "_blank");
        return;
      }
      const results = parseKohaResults(res.html || "");
      showPyqPanel(subject, results, url);
    });
  }

  function injectPyqButton() {
    if (document.getElementById("pesu-pyq-btn")) return;

    const btn = document.createElement("button");
    btn.id = "pesu-pyq-btn";
    btn.type = "button";
    btn.textContent = "Search PYQs";
    btn.title = "Search previous-year question papers in the PESU library";
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
      const guessed = guessSubject();
      const subject = window.prompt("Subject to search PYQs for:", guessed) || guessed;
      const finalSubject = subject.trim();
      if (!finalSubject) return;
      try {
        chrome.storage.local.set({ [PYQ_SUBJECT_KEY]: finalSubject });
      } catch {
        /* ignore */
      }
      fetchPyqs(finalSubject);
    });

    (document.body || document.documentElement).appendChild(btn);
  }

  function injectInlinePyqLinks() {
    const titles = document.querySelectorAll("h3, h4, .subject, .course-name");
    titles.forEach((el) => {
      if (el.dataset.pesuPyq === "1") return;
      const text = (el.textContent || "").trim();
      if (!text || text.length < 4 || text.length > 80) return;
      el.dataset.pesuPyq = "1";

      const link = document.createElement("a");
      link.textContent = " (PYQ)";
      link.href = "#";
      link.style.fontSize = "0.85em";
      link.style.marginLeft = "6px";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        fetchPyqs(text);
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
