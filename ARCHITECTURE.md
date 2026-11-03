# Architecture

Developer-facing overview of how the app works. For configuration and
content authoring see the [README](README.md).

## Runtime model

Three threads, connected by shared single-producer/single-consumer (SPSC)
buffers so file contents cross as binary data rather than JSON/Base64:

```text
  ┌──────────────┐  LSP over a transport    ┌──────────────────┐
  │  main thread │ ───────────────────────▶ │  ALS worker      │
  │  CodeMirror  │                          │  Agda (WASI)     │
  │  LSP client  │ ◀─────────────────────── │  stdio over SPSC │
  └──────┬───────┘                          └────────┬─────────┘
         │  drive requests (JSON)                    │  file syscalls
         ▼                                           ▼
  ┌────────────────────────────────────────────────────────────┐
  │  drive worker — in-memory filesystem, stdlib, content,     │
  │  IndexedDB cache, on-demand .agdai fetch (interfaces)      │
  └────────────────────────────────────────────────────────────┘
```

- **Main thread** (`src/routes/+page.svelte`, `src/lib/controller.svelte.ts`):
  the Svelte UI (editor, chapter tree, reader pane, goal inspector) and a
  CodeMirror 6 LSP client. The controller owns boot: it fetches the runtime
  assets, mounts archives on the drive, spawns the workers, and applies the
  import rewrite before syncing editor text to the drive.
- **ALS worker** (`src/lib/worker/als.ts`): stock Agda Language Server under
  WASI via `@runno/wasi`. `patch-wasi.ts` / `proxy-wasi-drive.ts` route its
  file syscalls to the drive worker; `wrap-poll-oneoff.ts` bridges WASI
  one-shot polling to the browser event loop.
- **Drive worker** (`src/lib/worker/drive.ts`): the in-memory filesystem the
  compiler sees, holding the stdlib, the content project, Agda's primitives,
  and everything Agda writes (interfaces). Persists to IndexedDB, namespaced
  `als-dist-<agdaVersion>-content-<contentHash>` so a stale cache can never be
  reused across runtime or content changes. When Agda path-opens or
  path-stats a missing stdlib `.agdai`, the drive fetches that one file from
  `interfaces.baseUrl` (see below) and serves it before replying.

LSP messages are JSON; drive requests are length-prefixed JSON with binary
payloads (`src/lib/agda/transport.js`, `src/lib/worker/types.d.ts`).

## Boot flow

1. `scripts/sync-runtime.mjs` (predev/build) downloads the pinned
   `agda-als-dist` release, verifies every artifact against the byte length
   and SHA-256 in its `dist-manifest.json`, copies them into `static/`, and
   generates `src/lib/runtime-manifest.ts` — the app's only source of runtime
   paths, sizes, and cache-bust tokens.
2. `scripts/sync-content.mjs` builds `static/content/` from `content/` +
   `playground.config.json`: raw display sources, `project.zip` (modules at
   library paths plus generated `.agda-lib`), and `manifest.json` (chapter
   index, content hash, optional import-rewrite spec).
3. In the browser, the controller fetches `manifest.json`, `project.zip`, the
   stdlib zip, and the wasm (`compressedPath` via `DecompressionStream`, raw
   `path` as fallback), mounts them on the drive, and starts the ALS worker
   over the SPSC transport.

Every fetch is base-aware through `asset()` because the Pages deploy serves
under `BASE_PATH=/<repo-name>`.

## Import rewriting

`src/lib/agda/browser-source.js` (`browserAgdaSource(filePath, source,
rewrite)`) applies the optional `importRewrite` spec from the config. It runs
in two places: at build time in `sync-content.mjs` (what goes into
`project.zip`) and at runtime in the controller (what gets synced to the drive
when the visitor edits). **Invariant:** each replacement module name must have
exactly the same UTF-8 byte width as the original, because Agda reports
positions against the displayed source. The unit test in `src/index.test.js`
covers this path.

## Interfaces (`.agdai`)

Agda recompiles from source unless it finds an interface. Two mechanisms:

- **Own content:** `npm run precompile:content` (local native Agda of the
  pinned version) writes per-chapter archives under
  `static/content/interfaces/`; these are committed and mounted via
  `mountDriveArchives`.
- **Standard library:** the `interfaces` config, resolved to a base URL in the
  controller: `none` (nothing), `same-origin` (sync-runtime extracts the
  release's interface tree into `static/stdlib-interfaces/`, so the site
  serves it), or `cross-origin` (a CORS host; GitHub release assets do not
  work — they send no `access-control-allow-origin`). Fetched interfaces
  persist in the same IndexedDB cache, so reloads re-request nothing.

A missing or mismatched interface is ignored: Agda just compiles that module,
so a stale tree costs time, never correctness.

## Scripts

| Script | Purpose |
| --- | --- |
| `sync-runtime.mjs` | download + verify pinned runtime, generate `runtime-manifest.ts` |
| `sync-content.mjs` | content/ → `static/content/` |
| `precompile-content.mjs` | optional: build content `.agdai` with a local Agda |
| `index-content-interfaces.mjs` | dependency index for the precompiled archives |
| `benchmark-content.mjs` | real-browser regression check (Playwright) |

## Source map

```text
src/routes/+page.svelte        UI: layout, chapter tree, reader, editor
src/lib/controller.svelte.ts   boot, workers, LSP routing, cache namespace
src/lib/agda/                  LSP transport, highlighting, goals, handlers
src/lib/codemirror/            CodeMirror language, completion, hover, input
src/lib/worker/als.ts          the ALS wasm worker
src/lib/worker/drive.ts        virtual filesystem + IndexedDB + .agdai fetch
src/lib/worker/patch-wasi.ts   syscall routing between the two workers
src/lib/runtime-manifest.ts    generated; see above
scripts/                       build pipeline (see table)
```

## CI and deploy

`ci.yml` runs check/test/build with `.runtime-cache` cached (keyed on
`playground.config.json`). `deploy-pages.yml` is triggered by `workflow_run`
on CI success, builds with `BASE_PATH=/<repo-name>`, and publishes to GitHub
Pages. Repo settings required: Pages source = GitHub Actions, workflow
permissions = read and write.
