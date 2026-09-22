# History image refs for flat-projection hosts (v2, approved 2026-09-18)

Problem: the Codex app-server host renders assembled history into one prompt string and
appends every loadable history image as a flat list after it (oldest first, current
request's images last). Nothing ties an image to its message. Vast answered about the
wrong screenshot.

Design (reviewed by three Codex runs; positional fallback removed, cache keyed by
binding, refs repeated in host-generated text, authoritative map in developer text):

1. Every history image keeps traveling. Nothing is dropped, pruned, or "not attached".
2. Each history image fact gets a derived copy with a black band APPENDED above the
   pixels printing `VCREF XXXX-XXXX` in large white bold type (alphabet without I/1/O/0).
   The copy is normalized to the host's 1200 px long edge first so the host does not
   shrink the band further. Speaker, time, file name stay in text.
3. Ref = sha256(sessionId, message idempotency key or fallback, fact index) -> 8 symbols.
4. Text binding in three places: a short line appended to the message; the ref inside
   the derived file's `fileName` and basename so the host's own `[media attached …]`
   note repeats it (that note renders last in the chunk and survives suffix truncation);
   the authoritative ref map in the per-turn developer addition with the binding rule.
5. Labeling is mandatory on the Codex path (`runtimeSettings.executionHost.id ===
   "codex-app-server"`). If a single image still fails, the ORIGINAL is sent and the
   developer map names it as unlabeled with its identity; the turn never breaks.
6. Cache: `<workspaceDir>/media/inbound/vc-labeled/<ref>-<srcHash12>.<jpg|png>`, keyed by
   source bytes + ref, temp-then-rename, single-flight per key, per-agent byte quota
   with LRU cleanup. workspaceDir comes from `runtimeContext.workspaceDir` and must
   contain the source file.
7. Embedded hosts: byte-identical output (they keep images inside messages).

Modules: `history-image-refs.js` (pure), `image-labeler.js` (cache + python worker),
`tools/label_image.py` (PIL; pillow-heif when present), wiring in
`attributed-context-engine.js`. Ship gate: box harness `/root/vc-harness/flat-projection-harness.mjs`
with the real Codex render + real host loader over Vast's transcript: one image item per
history fact, every derived file present, refs one-to-one with the developer map, band
legible in the post-loader bytes.
