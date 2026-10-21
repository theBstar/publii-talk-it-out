# Changelog

## 0.1.0 — 2026-10-21

First release.

- Dictation into Publii's WYSIWYG, Block and Markdown editors, with automatic spacing and capitalisation.
- Voice commands for editing in place: replace, delete, select, format, convert blocks, insert headings, move the cursor, set the title, read back and save. Saving never publishes.
- Draft mode: talk through an article, then insert it as dictated or have Claude structure it.
- On-device speech recognition (Whisper via transformers.js, WebGPU with WebAssembly fallback), or an optional OpenAI-compatible cloud endpoint.
- Optional Claude integration for drafting and free-form edits, with a running cost estimate.
- Settings page with microphone and recognition test, Claude key check, and autostart instructions.
- Warning when running on a Publii version it hasn't been tested with (tested with 0.47).
