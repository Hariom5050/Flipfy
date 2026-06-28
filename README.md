# Flipfy

Flipfy is a privacy-first browser tool for converting flipbook inputs into PDFs.

## Run locally

Open `index.html` directly in a modern browser, or serve the folder with any static file server:

```powershell
py -m http.server 4173
```

Then open `http://localhost:4173`.

## Privacy model

- No uploads
- No server processing
- No tracking or analytics
- No accounts
- No browser storage persistence

The app uses native browser APIs and a Web Worker. It accepts a ZIP flipbook, a single PDF flipbook as a direct PDF output, or image pages such as JPG, PNG, WebP, BMP, and GIF, then assembles them into a downloadable PDF in the browser.

ZIP flipbooks are scanned locally for a PDF or the best numbered page-image folder. SWF and proprietary flipbook packages are detected and rejected with an explanation because modern browsers cannot safely decode those formats without additional runtimes.
