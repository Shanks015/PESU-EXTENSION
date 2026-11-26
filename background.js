chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: "pesuacademy.com" }
          })
        ],
        actions: [new chrome.declarativeContent.ShowAction()]
      }
    ]);
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "OPEN_TAB") {
    const openTab = (url, done) => {
      if (!url) {
        done(false, "No URL");
        return;
      }
      try {
        chrome.tabs.create({ url }, () => {
          const error = chrome.runtime.lastError;
          done(!error, error && error.message);
        });
      } catch (err) {
        done(false, err.message || String(err));
      }
    };

    openTab(request.url, (ok, error) => {
      // A blob URL can be refused in some Chrome builds. The signed page URL is
      // the next best option before giving up.
      if (ok || !request.fallbackUrl || request.fallbackUrl === request.url) {
        sendResponse({ ok, error });
        return;
      }
      openTab(request.fallbackUrl, (again, nextError) => {
        sendResponse({ ok: again, error: nextError });
      });
    });

    return true;
  }

  if (request.action === "FETCH_SIGNED_PDF") {
    (async () => {
      try {
        const response = await fetch(request.url, {
          credentials: "include",
          redirect: "follow"
        });

        const buffer = await response.arrayBuffer();
        const header = new TextDecoder().decode(buffer.slice(0, 5));

        if (header !== "%PDF-") {
          sendResponse({
            ok: false,
            error: `Expected PDF, got "${header}" (HTTP ${response.status})`
          });
          return;
        }

        sendResponse({ ok: true, data: Array.from(new Uint8Array(buffer)) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();

    return true;
  }
});