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
- **PYQ search by course code** — floating "PYQs" button + inline links on
  MyCourses rows; each course is searched by its code (UE20CS301 → library
  subject key CS301), listing every question paper of that subject, with
  pagination across all Koha result pages. Records the library doesn't mark
  as question papers (general books) are filtered out. Every result has a
  **View** button (opens the paper's PDF in a new tab) and a **Download**
  button (saves it straight to `Downloads/PESU_QPs/`).
- **Update notifications** — desktop notifications when a course page gains
  new slides/assignments.

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
- On **MyCourses**, click a course's **PYQs** button (or the floating PYQ
  button) to list its question papers, searched by course code. Use
  **View** to read a paper in a new tab or **Download** to save it as
  `PESU_QPs/<title>.pdf`.

## PYQ search — how it works

The PESU library catalogues each question paper under the *subject* part of
the course code: `UE20CS301` is filed as `(CS301)`, `UE24CS251A` as
`(CS251)`. Searching Koha with the full code returns nothing, so the
extension strips the scheme prefix and section suffix to build the subject
key, queries the Koha OPAC for `KEY)`, filters results by their trailing
catalogue code, drops records not marked as question papers, and follows
pagination so every paper of the subject is listed. If no code match exists
it falls back to a title query and says so in the panel. (Course-code
mapping approach adapted from
[ndigvijay/PESU-MAX](https://github.com/ndigvijay/PESU-MAX).)

## Project structure

```
.
├── manifest.json          # MV3 manifest (v4.3)
├── background.js          # service worker: OPEN_TAB, DOWNLOAD_URL,
│                          #                 FETCH_SIGNED_PDF, FETCH_PYQ
├── content.js             # content script: PDF iframe upgrade + dark mode
├── attendance.js          # 75% attendance helper column
├── features.js            # PYQ search by course code (view/download) +
│                          #                 update notifications
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
