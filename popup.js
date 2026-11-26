const DARK_KEY = "pesuDark";

const toggle = document.getElementById("dark");

function render(on) {
  toggle.checked = !!on;
}

try {
  chrome.storage.local.get({ [DARK_KEY]: false }, (res) => render(res && res[DARK_KEY]));
} catch {
  render(false);
}

toggle.addEventListener("change", () => {
  try {
    chrome.storage.local.set({ [DARK_KEY]: toggle.checked });
  } catch {
    /* storage unavailable; the switch still shows the choice */
  }
});
