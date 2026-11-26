# PESU Auto PDF Unlocker

A Chrome extension (Manifest V3) that replaces the locked PDF iframes on
[PESU Academy](https://www.pesuacademy.com) with a full-featured, in-browser
viewer: selectable text, automatic OCR, download in multiple formats, a
dark-mode toggle for the site, and a 75% attendance helper.

## Features

- **Selectable text on locked PDFs** — fetches the signed PDF in the
  background and renders it with PDF.js, so you can select/copy text.
- **Automatic OCR** — runs Tesseract.js locally on slides that have no text
  layer, so even scanned/image PDFs become searchable.
- **Download queue during OCR** — downloads requested while OCR is running
  are queued and exported automatically once every page has text, so no
  slide is saved without a text layer. Formats: PDF, Word (.docx),
  PowerPoint (.pptx).
- **Open in a new tab** — opens the already-fetched PDF bytes in the
  browser's native PDF viewer.
- **Dark mode for the website** — a toggle (popup or viewer) applies a
  dark theme to PESU Academy pages. PDF documents keep their original
  colours.
- **75% attendance helper** — adds a `75% plan` column next to attendance
  tables showing `Skip N classes` (when at/above 75%) or
  `Attend N classes` (when below 75%).
- **PYQ search** — floating "Search PYQs" button + inline links to search
  previous-year question papers per subject.
- **Update notifications** — desktop notifications when a course page gains
  new slides/assignments.
- **Black & white is gone in favour of dark mode** — see note above.

## Installation (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Visit `https://www.pesuacademy.com` — the extension activates
   automatically.

> Note: the folder must not contain files whose names start with `_`
> (Chrome reserves them). The published tree is clean.

## Usage

- Open any course slide/PDF on PESU Academy. The locked iframe is replaced
  by the viewer.
- Use the toolbar: **Open** (new tab), **Download** (PDF/DOCX/PPTX menu),
  **Try OCR** (force OCR), zoom controls.
- Toggle **Dark mode** from the extension popup or the page.
- On the attendance page, the `75% plan` column appears automatically.

## Project structure

```
.
├── manifest.json          # MV3 manifest (v4.0)
├── background.js          # service worker: OPEN_TAB, FETCH_SIGNED_PDF
├── content.js             # content script: PDF iframe upgrade + dark mode
├── attendance.js          # 75% attendance helper column
├── viewer.html / viewer.js# in-browser PDF viewer + OCR + export
├── exporter.js            # PDF/DOCX/PPTX packaging
├── naming.js              # slide/module name helpers
├── popup.html / popup.js  # popup UI (dark mode toggle)
├── pdf.min.js, pdf.worker.min.js
├── tesseract*.js, worker.min.js, tesseract-core.wasm
└── eng.traineddata.gz     # Tesseract language data
```

## Development

- Syntax check: `node --check <file>.js`
- The viewer is testable locally with the harness in
  `C:\Users\saish\AppData\Local\Temp\opencode\viewer-test` (not part of repo).
- Keep the working tree free of files starting with `_`.

## License

MIT (add your preferred license here).
