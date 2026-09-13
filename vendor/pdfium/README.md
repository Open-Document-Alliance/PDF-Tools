# PDFium Windows renderer runtime

This directory vendors the official Google Chromium PDFium prebuilt library
for Windows, used as the system-renderer fallback on `win32` when the native
`@napi-rs/canvas` binding is unavailable or blocked — the Windows counterpart
to the macOS `qlmanage`/`sips` fallback described in `vendor/qpdf-wasm/` and
`## Password Support` in `CLAUDE.md` (a different subsystem, same isolation
philosophy).

## Who loads it

`vendor/pdfium/runtime/<arch>/pdfium.dll` is loaded by exactly one module,
`server/pdfium-render-host.mjs`. That module is never imported directly by the
long-lived server process: it is spawned as a disposable child process by
`server/pdfjs-subprocess.js`'s `runSystemCommand`, the same sandboxed spawn
path already used for `qlmanage`/`sips` on darwin (whitelisted command,
`shell: false`, argument-shape validation, a hard timeout, and a concurrency
cap of one system-render child at a time). If a malformed or hostile PDF makes
`pdfium.dll` hang, only that disposable child process is killed — never the
worker thread serving other concurrent requests, which an in-process FFI call
could not guarantee.

PNG encoding happens in pure JavaScript after `pdfium.dll` returns a raw RGBA
bitmap; PDFium's C API has no PNG encoder.

## What ships

`vendor/pdfium/runtime/` contains `win-x64/pdfium.dll` and
`win-arm64/pdfium.dll`, the unmodified `bin/pdfium.dll` from the official
Windows release assets. `vendor/pdfium/licenses/` is the release archive's own
bundled third-party notice directory (both architectures ship an identical
set for a given tag), plus the top-level MIT license of the
`bblanchon/pdfium-binaries` build-recipe repository itself — see the `notices`
section of `runtime.provenance.json` for why that one file is handled
separately.

`vendor/pdfium/sources.lock.json` pins the upstream tag, commit, and the
SHA-256 of both the release archive and the extracted DLL for each
architecture. `vendor/pdfium/runtime.provenance.json` binds the committed
files to that lock file. Neither is hand-edited; regenerate the runtime with:

```bash
node scripts/vendor-pdfium-runtime.mjs
```

which refuses to promote a download that does not match `sources.lock.json`.
To pick up a new PDFium release, update the tag/commit/asset hashes in
`sources.lock.json` first (from a trusted read of the new release), then
re-run the promotion script.

## Why prebuilt, not built from source

Unlike `vendor/qpdf-wasm/`, which builds QPDF from pinned source with a
reproducible Docker recipe, PDFium here is not compiled by this project.
`bblanchon/pdfium-binaries` already publishes official Google Chromium PDFium
builds (no XFA, no V8/JavaScript forms — `pdf_enable_v8=false`,
`pdf_enable_xfa=false`), so `scripts/vendor-pdfium-runtime.mjs`'s job is
narrower: download the pinned release asset, verify it byte-for-byte against
`sources.lock.json`, and promote it. Building PDFium from source requires
Chromium's `depot_tools`/`gclient` toolchain, which is a materially larger
undertaking than QPDF's plain Autotools/CMake build; the tradeoff was
accepted deliberately in exchange for trusting the same upstream binaries
Chromium itself ships.

## Licensing

Every bundled component is permissive (BSD, MIT, zlib, Apache-2.0, the
FreeType License, or the Unicode License) — no GPL or LGPL component is
linked into this build. All are compatible with this project's MIT license.
See `runtime.provenance.json`'s `notices` section for the component-by-license
breakdown and `licenses/manifest.json` for the SHA-256 of each notice file.
