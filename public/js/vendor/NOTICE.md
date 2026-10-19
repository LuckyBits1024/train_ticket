# Vendored browser libraries

These files are served locally so the ticket studio keeps working offline.

## pdf.js

- Package: `pdfjs-dist@3.11.174` (legacy UMD build)
- Files: `pdfjs/pdf.min.js`, `pdfjs/pdf.worker.min.js`, `pdfjs/cmaps/*`, `pdfjs/standard_fonts/*`
- License: Apache-2.0 (see `pdfjs/LICENSE`)
- Source: https://www.npmjs.com/package/pdfjs-dist

## qrcode

- Package: `qrcode@1.5.1`
- File: `qrcode.min.js`
- License: MIT
- Source: https://github.com/soldair/node-qrcode

No CDN, telemetry, or remote font is used at runtime.
