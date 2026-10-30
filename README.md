# Agda Playground

A template for building an interactive, type-checkable Agda website that runs
entirely in the browser. Drop `.agda` or `.lagda.md` files into `content/`, and
GitHub Pages serves an editor plus the Agda Language Server compiled to
WebAssembly — code never leaves the visitor's machine.

This repository is the canonical starter. For a worked example with a full book
of content, see
[`jespercockx/plfa-playground`](https://github.com/jespercockx/plfa-playground).

## What works

- Agda type checking, compiler highlighting, goals, errors, and warnings
- Language-server hover types plus buffer- and import-aware name completion
- Agda/Emacs-style Unicode composition (`\to` → `→`, `\all` → `∀`, …)
- Give, Refine, and case-split interactions that edit and re-check the source
- Top-level type inference and normalization
- The bundled Agda standard library
- Browser-local autosave and persistent source/interface caches (IndexedDB)
- Responsive layout and a resizable goal inspector

## Quickstart

1. Use this template (or clone it) into a new repository.
2. Add your sources to `content/`. The starter ships with none, so the editor
   opens an empty `Main.agda`.
3. Run it locally:

   ```sh
   npm ci
   npm run dev
   ```

   The first run downloads the pinned Agda runtime (see
   [Runtime and distribution](#runtime-and-distribution)) and caches it under
   `.runtime-cache/`. Open <http://localhost:5173> and press Ctrl/Cmd+Enter to
   check the module.

4. Enable GitHub Pages: **Settings → Pages → Source = GitHub Actions**, and
   **Settings → Actions → General → Workflow permissions = Read and write**.
   Every push to `master` that passes CI is deployed to
   `https://<owner>.github.io/<repository>/`.

## Content

Sources live in `content/` and are described by `playground.config.json`.

- `.agda` files are shown as a single code block; `.lagda.md` files are rendered
  as Markdown with their ` ```agda ` blocks editable and checkable.
- A Markdown file may start with frontmatter whose `title:` sets its display
  name:

  ```markdown
  ---
  title: Natural numbers
  ---
  ```

- Files in the content root belong to no group; files in a subdirectory form a
  group named after that directory. For example `content/part1/Foo.agda` is in
  group `part1`; a root with only top-level files renders without any group
  headers.
- Groups are ordered by the key order of `groups` in `playground.config.json`,
  then any extra groups alphabetically. Within a group, chapters follow the
  `order` list, then alphabetically.

```sh
npm run sync:content
```

regenerates the display sources, the Agda project archive, and the content index
under `static/content/`. `npm run dev` and `npm run build` run it automatically.

### Module names

Agda derives a module's name from its path relative to the library root, so the
path inside the project archive has to match the `module … where` header you
write. `modulePrefix` sets the directory the content is placed under:

- The starter sets `"modulePrefix": ""`, so `content/Main.agda` declares
  `module Main where`.
- A project with modules named `mylib.Widget` would set `"modulePrefix": "mylib"`
  and place the file at `content/Widget.agda`.

When `modulePrefix` is omitted it defaults to `library`.

### Configuration reference

`playground.config.json` keys:

| Key | Purpose |
| --- | --- |
| `title` | Site title shown in the UI |
| `library` | Agda library name; names the generated `<library>.agda-lib` and is the default `modulePrefix` |
| `modulePrefix` | Directory content modules are placed under (`""` for the root) |
| `source` | Upstream source URL, linked in the footer |
| `license`, `licenseFile` | License label and the file to copy into `static/content/` for display |
| `groups` | Display titles for content directories |
| `order` | Explicit chapter order per group |
| `playgroundSource` | Initial text of the built-in editor document; `""` opens a blank `Main.agda` |
| `dependencies` | Agda library dependencies of the generated project (default `["standard-library"]`) |
| `runtime` | Which `agda-als-dist` release to download (see below) |
| `interfaces` | Standard-library interface mode (see below) |
| `importRewrite` | Optional import-rewrite map (see below) |

### Optional: import rewriting

If your sources import broad standard-library modules, you can rewrite those
imports onto narrow adapter modules for faster checking. Each adapter is an
ordinary checked Agda module; the displayed source stays the original text.
Because Agda reports positions against the displayed text, every replacement
module name must be **exactly the same UTF-8 width** as the name it replaces, so
that ranges, highlighting, errors, goals, and editor scroll synchronization stay
aligned.

This is off by default (identity). The worked example
([`plfa-playground`](https://github.com/jespercockx/plfa-playground)) shows a full
`importRewrite` spec: a `modules` map of adapter sources, an `imports` map of
`[from, to]` pairs, optional `conditionalImports`, and `stripSections`.

## Runtime and distribution

The Agda compiler and language server are a 33 MB WASI executable (about 10 MB
over the wire as gzip). It is **not** committed to this repository. Instead,
`runtime` in `playground.config.json` pins a release of
[`jespercockx/agda-als-dist`](https://github.com/jespercockx/agda-als-dist), and
`scripts/sync-runtime.mjs` downloads it:

```json
"runtime": {
  "repository": "jespercockx/agda-als-dist",
  "release": "v2.8.0-als-e6541f8"
}
```

Before `npm run dev` and `npm run build`, the script fetches the release's
`dist-manifest.json`, checks every artifact against the byte length and SHA-256
it records, and copies them into `static/`. Downloads are cached under
`.runtime-cache/` (gitignored), so later builds are offline; CI caches the same
directory.

Add `"manifestSha256": "<hash>"` to authenticate the tag itself by pinning the
manifest bytes. It is optional: without it the manifest is fetched on every run
and only the artifact hashes inside it are trusted.

To bump the runtime, change `runtime.release` (and update `manifestSha256` if you
use it). Only **Agda 2.8.0 and later** are supported:
earlier releases predate the `--setup` primitive installer and the
`_build/<version>/agda/` interface layout the runtime relies on. See the dist
repo's [`UPDATING.md`](https://github.com/jespercockx/agda-als-dist/blob/main/UPDATING.md)
for how a release is produced.

For an air-gapped mirror or local testing, `PLAYGROUND_RUNTIME_BASE_URL`
overrides the GitHub download base, with the release tag appended.

## Precompiling interfaces

Agda recompiles a module from source unless it finds a precompiled interface
(`.agdai`) for it, and a broad import such as `import Data.Nat` pulls in a large
part of the library — minutes on the first check. Two mechanisms avoid that:
precompiling your own content with a local Agda, and fetching the standard
library's interfaces on demand.

### Precompiling your own content

With a native Agda of the matching version available, the optional fast path
precompiles per-chapter archives so the first visit does not type-check the
standard library and every earlier chapter:

```sh
npm run precompile:content -- /path/to/agda-2.8.0
```

It refreshes the deduplicated archives under `static/content/interfaces/` and the
dependency index. The script checks with whatever `agda` is on `PATH` by default;
pass the path to a matching binary as shown, or point `AGDA` at it. Skip this step
if you do not have a native Agda of the pinned version, or if you prefer to keep
your repository free of precompiled data: everything still works, just with a
slower first check.

### Standard-library interfaces

The `interfaces` setting fetches the standard library's interfaces on demand
instead of compiling them: Agda decides which interface it wants, and only the
ones a check needs are fetched, one request per file.

- `{ "mode": "none" }` — never fetch; compile everything from source. This is
  what the starter ships. Omitted `interfaces` behaves like this.
- `{ "mode": "same-origin" }` — `sync:runtime` downloads the release's interface
  archive at build time and extracts it into `static/stdlib-interfaces/<agdaVersion>/`;
  the site serves it and therefore carries the whole tree (about 190 MB of
  files). Reloads reuse the interfaces from IndexedDB and make no further
  requests. Switch this on once your content imports the standard library.
- `{ "mode": "cross-origin", "baseUrl": "https://…" }` — fetch each interface
  from `baseUrl` at runtime. `baseUrl` must be a **CORS host** serving the tree
  as `<baseUrl>/src/<Module>.agdai`. A GitHub release asset will not work:
  release downloads carry no `access-control-allow-origin`, so a cross-origin
  isolated page cannot fetch them. Pages, `raw.githubusercontent.com`, and
  jsDelivr do set the header.

Interfaces are version-specific: the tree must be built by the same Agda version
the site ships. A missing or mismatched file is ignored and Agda compiles that
module normally, so a partial or stale tree costs time, never correctness.

## Build and verify

```sh
npm run check
npm test
npm run build
```

The static site is written to `build/`. The deploy workflow
(`.github/workflows/deploy-pages.yml`) builds with `BASE_PATH=/<repository>` and
publishes to GitHub Pages after CI passes.

With a local Chromium/Chrome available, the browser regression benchmark checks
the content in a real browser:

```sh
npm run dev   # in another terminal
PLAYGROUND_URL=http://127.0.0.1:5173 npm run benchmark:content
```

Set `CHROME_EXECUTABLE` if Chrome is not on `PATH`; `CHAPTERS=A,B` narrows a run
to named chapters.

## Architecture

```text
  ┌──────────────┐  LSP over a transport   ┌──────────────────┐
  │  main thread │ ───────────────────────▶ │  ALS worker      │
  │  CodeMirror  │                          │  Agda (WASI)     │
  │  LSP client  │ ◀─────────────────────── │  stdio over SPSC │
  └──────┬───────┘                          └────────┬─────────┘
         │  drive requests (JSON)                     │  file syscalls
         ▼                                            ▼
  ┌────────────────────────────────────────────────────────────┐
  │  drive worker — in-memory filesystem, stdlib, content,     │
  │  IndexedDB cache, on-demand .agdai fetch (interfaces)      │
  └────────────────────────────────────────────────────────────┘
```

The main thread hosts CodeMirror and an LSP client. A dedicated worker runs the
Agda Language Server under WASI, and a second worker owns its in-memory
filesystem together with the bundled standard library and your content. Shared
single-producer/single-consumer (SPSC) buffers connect the workers without a
remote backend; file contents cross that bridge as binary data rather than
JSON/Base64.

The compiler is unmodified, stock Agda. Checks reuse Agda's own interfaces and
one long-lived interaction process.

## Limitations

- **First-load download.** The first visit downloads the ~10 MB gzip wasm and the
  primitive data archive; the browser caches them afterwards.
- **First-visit reload.** The app needs `SharedArrayBuffer`, so the page must be
  cross-origin isolated with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot set response
  headers, so the bundled `static/coi-serviceworker.js` supplies them, at the
  cost of one automatic reload on the first visit.
- **Per-site build size.** `interfaces.mode: "same-origin"` makes every
  deployment carry the full ~190 MB interface tree, even if no visitor imports
  the standard library. The starter ships `none` (fetch nothing) to keep the
  build small; `cross-origin` (host nothing, fetch from a CORS host) is the
  other alternative.
- **Vite cap.** `vite` is held below 8.3 on purpose; see the comment in
  `package.json`. Bumping it silently breaks the WASM worker.

## Hosting elsewhere

The build is a plain static site (`build/`), so any static host works. The only
requirement is that pages are cross-origin isolated, either by sending the two
COOP/COEP headers or by relying on the bundled `coi-serviceworker.js`. To deploy
under a subpath, build with `BASE_PATH=/<subpath>`; all runtime URLs are
base-aware.

## Repository layout

```text
content/                 your Agda sources
playground.config.json   site configuration
scripts/                 content and runtime pipelines
src/                     the SvelteKit app
static/                  generated and static assets
.github/workflows/       CI and GitHub Pages deploy
```
## Origins and credits

The browser-native Agda playground began as
[`agda-web/als-demo`](https://github.com/agda-web/als-demo) by Andy Pan. This
repository started as a fork of
[`SeungheonOh/plfa-playground`](https://github.com/SeungheonOh/plfa-playground)
by [Seungheon Oh](https://github.com/SeungheonOh), who built the original
in-browser PLFA playground on top of it — many thanks for that work. 
A version of the PLFA playground based on the template in this repository can be found at
[`jespercockx/agda-playground`](https://github.com/jespercockx/agda-playground).

## License and notices

The app is MIT (see [`LICENSE`](LICENSE)). The runtime artifacts, the bundled
standard library, and the language server retain their own upstream licenses; see
[`NOTICE.md`](NOTICE.md).
