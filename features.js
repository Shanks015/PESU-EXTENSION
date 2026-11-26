// Extra helpers for PESU Academy:
//   1. Quick search for previous-year question papers (PYQs) per subject.
//   2. Desktop notifications when a course page gains new slides/assignments.
(function () {
  "use strict";

  if (window.__pesuExtraFeatures) return;
  window.__pesuExtraFeatures = true;

  const PYQ_KEY = "pesuPyqSubject";
  const SEEN_KEY = "pesuSeenItems";

  /* ───────────── previous-year question paper search ───────────── */

  function guessSubject() {
    // Try the page title, then the first heading, then the URL.
    const candidates = [
      document.title,
      (document.querySelector("h1, h2, .page-title, .subject-name") || {}).textContent,
      location.pathname,
    ];
    for (const c of candidates) {
      const text = String(c || "").replace(/\s+/g, " ").trim();
      if (text && text.length > 3 && !/pesu/i.test(text.slice(0, 4))) {
        return text.slice(0, 80);
      }
    }
    return "";
  }

  function openPyqSearch(subject) {
    const q = encodeURIComponent(`PESU ${subject} previous year question paper`);
    const url = `https://www.google.com/search?q=${q}`;
    try {
      window.open(url, "_blank");
    } catch {
      location.href = url;
    }
  }

  function injectPyqButton() {
    if (document.getElementById("pesu-pyq-btn")) return;

    const btn = document.createElement("button");
    btn.id = "pesu-pyq-btn";
    btn.type = "button";
    btn.textContent = "Search PYQs";
    btn.title = "Search previous-year question papers for this subject";
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
      const subject = guessSubject();
      // Remember the last subject so the popup can reuse it.
      try {
        chrome.storage.local.set({ [PYQ_KEY]: subject });
      } catch {
        /* ignore */
      }
      openPyqSearch(subject);
    });

    (document.body || document.documentElement).appendChild(btn);
  }

  // Also add a small "PYQ" link next to obvious subject/course titles.
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
        openPyqSearch(text);
      });
      el.appendChild(link);
    });
  }

  /* ───────────── update notifications ───────────── */

  function collectItems() {
    // Gather candidate "content" entries: links inside lists/tables on the page.
    const items = new Set();
    const anchors = document.querySelectorAll("a[href]");
    anchors.forEach((a) => {
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      const href = a.getAttribute("href") || "";
      if (!text || text.length < 3) return;
      // Heuristic: only treat as content if the link looks like a slide/assignment/doc.
      if (!/slide|assignment|unit|module|doc|pdf|note|material/i.test(text + " " + href)) return;
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
      const title = "PESU Academy update";
      const message =
        novel.length === 1
          ? `New item: ${novel[0].split("::")[0]}`
          : `${novel.length} new items on this page`;
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          title,
          message,
          priority: 1,
        });
      } catch {
        /* notifications permission may be absent */
      }
    }

    seen[key] = current;
    // Keep storage bounded.
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

  // Re-scan after dynamic content loads.
  let queued = 0;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = setTimeout(() => {
      queued = 0;
      injectInlinePyqLinks();
    }, 600);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Periodic re-check for updates.
  setInterval(checkForUpdates, 5 * 60 * 1000);
})();
