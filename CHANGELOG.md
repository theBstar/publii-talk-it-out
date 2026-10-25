# Changelog

## 0.1.3 — 2026-10-25

Fixes from testing with a real microphone in a normal, noisy room.

- **Sentences no longer run together.** The microphone's automatic gain control is now off: it boosted the room between sentences until the pauses looked like speech. The speech detector also keeps adapting to background noise while you talk, and ends an utterance relative to how loud you were speaking.
- **Commands work mid-sentence.** If you don't pause before "New paragraph." or "Editor, make this a heading.", the command is still recognised and run in order with the surrounding dictation.
- **A bare "stop" no longer turns the mic off** while dictating; say "stop listening". This stops a stray word from someone nearby from ending your session.
- **Fewer invented phrases.** Whisper's habit of hearing "Thank you." or "Please subscribe to our channel." in background noise is filtered by how much real voice was in the clip.
- Quiet speech is normalised in volume before transcription.
- After "undo", the cursor sits at the end of the restored text, so the next words you dictate don't replace it.

## 0.1.2 — 2026-10-25

- Corrected the speech model download sizes on the settings page and in the README. Macs with GPU acceleration download the full-precision encoder, so the recommended model is about 210 MB rather than 80 MB, and Large v3 Turbo is about 2.9 GB rather than 800 MB.

## 0.1.1 — 2026-10-25

- **Microphone on macOS:** Publii 0.47.6 is signed without Apple's microphone entitlement, so it receives pure silence. Talk It Out now detects this, stops listening, and explains the fix instead of showing a flat meter.
- Added `scripts/patch-publii-mic.sh`, which adds the entitlement to your copy of Publii and re-signs it locally. It backs up the original app, `--restore` undoes it, and your sites and settings aren't touched.
- The settings page's microphone test shows the fix commands when it detects silence.
- Proposed the proper fix upstream: [GetPublii/Publii#2732](https://github.com/GetPublii/Publii/pull/2732).

## 0.1.0 — 2026-10-21

First release.

- Dictation into Publii's WYSIWYG, Block and Markdown editors, with automatic spacing and capitalisation.
- Voice commands for editing in place: replace, delete, select, format, convert blocks, insert headings, move the cursor, set the title, read back and save. Saving never publishes.
- Draft mode: talk through an article, then insert it as dictated or have Claude structure it.
- On-device speech recognition (Whisper via transformers.js, WebGPU with WebAssembly fallback), or an optional OpenAI-compatible cloud endpoint.
- Optional Claude integration for drafting and free-form edits, with a running cost estimate.
- Settings page with microphone and recognition test, Claude key check, and autostart instructions.
- Warning when running on a Publii version it hasn't been tested with (tested with 0.47).
