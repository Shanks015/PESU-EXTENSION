const observer = new MutationObserver(() => upgradePdfIframes());
const pollInterval = setInterval(upgradePdfIframes, 800);

/* ───────────── dark mode ───────────── */

// One preference shared by the popup and this page (the PDF document keeps
// its original colours).
const DARK_KEY = "pesuDark";
const DARK_STYLE_ID = "pesu-dark-style";

function ensureDarkStyle() {
  if (document.getElementById(DARK_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = DARK_STYLE_ID;
  // A common, robust dark-mode transform that keeps text readable.
  style.textContent =
    "html.pesu-dark-mode{filter:invert(1) hue-rotate(180deg) !important;}" +
    "html.pesu-dark-mode img,html.pesu-dark-mode video,html.pesu-dark-mode canvas,html.pesu-dark-mode svg image{filter:invert(1) hue-rotate(180deg) !important;}";
  (document.head || document.documentElement).appendChild(style);
}

function applyDark(on) {
  ensureDarkStyle();
  document.documentElement.classList.toggle("pesu-dark-mode", !!on);
}

// Floating toggle so the mode is visible and usable even if the popup
// isn't open.
function injectDarkToggle() {
  if (document.getElementById("pesu-dark-btn")) return;
  const btn = document.createElement("button");
  btn.id = "pesu-dark-btn";
  btn.type = "button";
  btn.textContent = "Dark";
  Object.assign(btn.style, {
    position: "fixed",
    left: "16px",
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

  function sync() {
    const on = document.documentElement.classList.contains("pesu-dark-mode");
    btn.textContent = on ? "Light" : "Dark";
  }

  btn.addEventListener("click", () => {
    const next = !document.documentElement.classList.contains("pesu-dark-mode");
    applyDark(next);
    try {
      chrome.storage.local.set({ [DARK_KEY]: next });
    } catch {
      /* ignore */
    }
    sync();
  });

  (document.body || document.documentElement).appendChild(btn);
  sync();
}

if (chrome.runtime?.id && chrome.storage?.local) {
  chrome.storage.local.get({ [DARK_KEY]: false }, (res) => {
    if (chrome.runtime?.id) {
      applyDark(res && res[DARK_KEY]);
      injectDarkToggle();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[DARK_KEY]) return;
    applyDark(changes[DARK_KEY].newValue);
    const btn = document.getElementById("pesu-dark-btn");
    if (btn) btn.textContent = changes[DARK_KEY].newValue ? "Light" : "Dark";
  });
} else {
  injectDarkToggle();
}

function upgradePdfIframes() {
  // Stop cleanly if the extension was reloaded in the background
  if (!chrome.runtime?.id) {
    observer.disconnect();
    clearInterval(pollInterval);
    return;
  }

  const iframes = document.querySelectorAll(
    'iframe[src*="downloadslidecoursedoc"], iframe[id^="myIframe"]'
  );

  iframes.forEach((iframe) => {
    const rawSrc = iframe.getAttribute("src");
    if (!rawSrc || rawSrc.startsWith("chrome-extension://") || iframe.dataset.upgraded === "true") {
      return;
    }

    iframe.dataset.upgraded = "true";
    const cleanPdfUrl = new URL(rawSrc.split("#")[0], window.location.origin).href;
    const moduleName = window.ModuleName ? ModuleName.fromIframe(iframe, cleanPdfUrl) : "";
    iframe.src = chrome.runtime.getURL("viewer.html");

    iframe.addEventListener("load", () => {
      if (!chrome.runtime?.id) return;

      chrome.runtime.sendMessage(
        { action: "FETCH_SIGNED_PDF", url: cleanPdfUrl },
        (res) => {
          if (!res || !res.ok) {
            iframe.contentWindow.postMessage(
              {
                type: "PDF_ERROR",
                message: res?.error || "Background fetch failed",
                fallbackUrl: `${cleanPdfUrl}#view=FitH&toolbar=1&navpanes=1&scrollbar=1`
              },
              "*"
            );
            return;
          }

          const buffer = new Uint8Array(res.data).buffer;
          iframe.contentWindow.postMessage(
            { type: "PDF_BUFFER", buffer, name: moduleName, url: cleanPdfUrl },
            "*",
            [buffer]
          );
        }
      );
    }, { once: true });
  });
}

upgradePdfIframes();
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"]
});