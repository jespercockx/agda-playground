// Downloads the Agda/ALS runtime artifacts for the release pinned in
// `playground.config.json` and places them in `static/`, then regenerates
// `src/lib/runtime-manifest.ts`.
//
// The distribution repository (jespercockx/agda-als-dist) publishes one GitHub
// release per Agda version, tagged `v<agda>-als-<sha>`. `runtime.release` names
// the tag this site ships; its `dist-manifest.json` describes the artifacts, and
// every download is checked against the byte length and SHA-256 the manifest
// records. Downloaded files are cached under `.runtime-cache/` (gitignored) so a
// warm checkout needs no network at all.
//
// The optional `runtime.manifestSha256` authenticates the tag itself by pinning
// the manifest bytes. Without it the manifest is fetched on every run and only
// the artifact hashes inside it are trusted.
//
// `PLAYGROUND_RUNTIME_BASE_URL` overrides the GitHub download URL, with the
// release tag appended — useful for testing or an air-gapped mirror.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractZip } from "./lib/zip.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.join(projectRoot, "static");
const cacheRoot = path.join(projectRoot, ".runtime-cache");
const manifestOutput = path.join(projectRoot, "src", "lib", "runtime-manifest.ts");

const config = JSON.parse(
  await readFile(path.join(projectRoot, "playground.config.json"), "utf8"),
);

const runtime = config.runtime;
if (!runtime?.repository || !runtime.release) {
  throw new Error(
    "playground.config.json must set `runtime.repository` (the dist repo) " +
      "and `runtime.release` (the release tag to download).",
  );
}
const release = { tag: runtime.release, manifestSha256: runtime.manifestSha256 };

// Only `same-origin` needs the interface tree extracted into `static/`; the
// `cross-origin` mode fetches it from the configured URL at runtime instead.
const syncInterfaces = (config.interfaces?.mode ?? "none") === "same-origin";

const baseUrlOverride = process.env.PLAYGROUND_RUNTIME_BASE_URL?.replace(/\/+$/, "");

function releaseUrl(tag, asset) {
  if (baseUrlOverride) return `${baseUrlOverride}/${tag}/${asset}`;
  return `https://github.com/${runtime.repository}/releases/download/${tag}/${asset}`;
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function downloadTo(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  // Buffer the whole response before writing: Node's fetch applies socket
  // backpressure for a slow Writable, and undici then trips an internal
  // assertion when the connection closes mid-stream. The largest artifact is
  // the ~170 MB interface archive, which fits comfortably in memory.
  await writeFile(partial, Buffer.from(await response.arrayBuffer()));
  await rename(partial, destination);
}

/**
 * Return a verified local copy of `url`, downloading it only when the cache has
 * no file of the expected size under its content hash. The cache directory is
 * named by SHA-256, so a hit is trusted without re-hashing.
 */
async function ensureCached(url, sha256, byteLength, label) {
  const name = path.basename(new URL(url).pathname);
  const destination = path.join(cacheRoot, sha256, name);
  if ((await fileSize(destination)) === byteLength) return destination;

  console.log(`Downloading ${label} (${name}) …`);
  await downloadTo(url, destination);

  const actualBytes = await fileSize(destination);
  if (actualBytes !== byteLength) {
    await rm(destination, { force: true });
    throw new Error(`${label}: downloaded ${actualBytes} bytes, expected ${byteLength}`);
  }
  const actualSha = await sha256File(destination);
  if (actualSha !== sha256) {
    await rm(destination, { force: true });
    throw new Error(`${label}: sha256 ${actualSha}, expected ${sha256}`);
  }
  return destination;
}

/** Copy a cached artifact into `static/` under its basename unless it is current. */
async function publish(source, sha256, byteLength) {
  const destination = path.join(staticRoot, path.basename(source));
  if ((await fileSize(destination)) === byteLength && (await sha256File(destination)) === sha256) {
    return false;
  }
  await mkdir(staticRoot, { recursive: true });
  await copyFile(source, destination);
  return true;
}

/** Fetch and (when pinned) authenticate a release's dist-manifest.json. */
async function loadManifest(release) {
  const url = releaseUrl(release.tag, "dist-manifest.json");
  if (!release.manifestSha256) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(await response.text());
  }

  const cached = path.join(cacheRoot, release.manifestSha256, "dist-manifest.json");
  if ((await fileSize(cached)) == null) {
    console.log(`Downloading dist-manifest.json for ${release.tag} …`);
    await downloadTo(url, cached);
    const actual = await sha256File(cached);
    if (actual !== release.manifestSha256) {
      await rm(cached, { force: true });
      throw new Error(
        `dist-manifest.json for ${release.tag} has sha256 ${actual}, ` +
          `but runtime.manifestSha256 pins ${release.manifestSha256}`,
      );
    }
  }
  return JSON.parse(await readFile(cached, "utf8"));
}

/**
 * Download the standard-library interface archive and extract it into
 * `static/stdlib-interfaces/<agdaVersion>/`, yielding
 * `…/<agdaVersion>/src/**\/*.agdai`. Skipped when the extracted tree already
 * matches the archive hash (a stamp file records it), or when the release does
 * not publish an archive.
 */
async function syncInterfacesTree(release, manifest) {
  if (!syncInterfaces) return false;
  const spec = manifest.interfaces;
  if (!spec?.asset) {
    console.warn(
      `${manifest.agdaVersion}: ${release.tag} has no \`interfaces\` archive, ` +
        "so same-origin interfaces are unavailable",
    );
    return false;
  }

  const destination = path.join(staticRoot, "stdlib-interfaces", manifest.agdaVersion);
  const stampPath = path.join(destination, ".stamp");
  const stamp = `${spec.asset}:${spec.sha256}`;
  if ((await readFile(stampPath, "utf8").catch(() => null)) === stamp) return false;

  const archive = await ensureCached(
    releaseUrl(release.tag, spec.asset),
    spec.sha256,
    spec.byteLength,
    "standard-library interfaces",
  );
  await rm(destination, { recursive: true, force: true });
  const written = extractZip(await readFile(archive), destination, (name) =>
    name.startsWith(`${spec.root ?? "src"}/`),
  );
  await writeFile(stampPath, stamp);
  console.log(`Extracted ${written} interface files into ${path.relative(projectRoot, destination)}`);
  return true;
}

async function readRelease(release) {
  const manifest = await loadManifest(release);

  const wasm = await ensureCached(
    releaseUrl(release.tag, manifest.wasm.path),
    manifest.wasm.sha256,
    manifest.wasm.byteLength,
    "ALS wasm",
  );
  const compressed = await ensureCached(
    releaseUrl(release.tag, manifest.wasm.compressedPath),
    manifest.wasm.compressedSha256,
    manifest.wasm.compressedByteLength,
    "compressed ALS wasm",
  );
  const data = await ensureCached(
    releaseUrl(release.tag, manifest.data.path),
    manifest.data.sha256,
    manifest.data.byteLength,
    "Agda data archive",
  );
  const stdlib = await ensureCached(
    releaseUrl(release.tag, manifest.stdlib.path),
    manifest.stdlib.sha256,
    manifest.stdlib.byteLength,
    "Agda standard library archive",
  );

  const copied = (
    await Promise.all([
      publish(wasm, manifest.wasm.sha256, manifest.wasm.byteLength),
      publish(compressed, manifest.wasm.compressedSha256, manifest.wasm.compressedByteLength),
      publish(data, manifest.data.sha256, manifest.data.byteLength),
      publish(stdlib, manifest.stdlib.sha256, manifest.stdlib.byteLength),
    ])
  ).filter(Boolean).length;
  const interfaces = await syncInterfacesTree(release, manifest);

  return {
    copied: copied + (interfaces ? 1 : 0),
    entry: {
      agdaVersion: manifest.agdaVersion,
      stdlibVersion: manifest.stdlibVersion,
      path: `/${path.basename(manifest.wasm.path)}`,
      compressedPath: `/${path.basename(manifest.wasm.compressedPath)}`,
      byteLength: manifest.wasm.byteLength,
      cacheBust: manifest.wasm.cacheBust,
      data: {
        path: `/${path.basename(manifest.data.path)}`,
        byteLength: manifest.data.byteLength,
        interfaceDir: manifest.data.interfaceDir,
      },
      stdlib: {
        path: `/${path.basename(manifest.stdlib.path)}`,
        byteLength: manifest.stdlib.byteLength,
      },
    },
  };
}

function renderManifest(entries) {
  const versions = entries
    .map(
      (entry) => `  {
    agdaVersion: ${JSON.stringify(entry.agdaVersion)},
    stdlibVersion: ${JSON.stringify(entry.stdlibVersion)},
    path: ${JSON.stringify(entry.path)},
    compressedPath: ${JSON.stringify(entry.compressedPath)},
    byteLength: ${entry.byteLength},
    cacheBust: ${JSON.stringify(entry.cacheBust)},
    data: {
      path: ${JSON.stringify(entry.data.path)},
      byteLength: ${entry.data.byteLength},
      interfaceDir: ${JSON.stringify(entry.data.interfaceDir)},
    },
    stdlib: {
      path: ${JSON.stringify(entry.stdlib.path)},
      byteLength: ${entry.stdlib.byteLength},
    },
  },`,
    )
    .join("\n");

  return `// Generated by scripts/sync-runtime.mjs. Do not edit by hand.
//
// The pinned agda-als-dist release (see \`runtime.release\` in
// playground.config.json). \`path\` values are root-relative static asset URLs;
// the controller applies SvelteKit's base path and a cache-bust suffix.

export interface RuntimeDataSpec {
  path: string;
  byteLength: number;
  /** Virtual location of Agda's primitive interfaces inside \`path\`. */
  interfaceDir: string;
}

export interface RuntimeStdlibSpec {
  path: string;
  byteLength: number;
}

export interface RuntimeVersionSpec {
  agdaVersion: string;
  stdlibVersion: string;
  path: string;
  compressedPath: string;
  /** Uncompressed wasm length, used as \`Content-Length\` when inflating the gzip copy. */
  byteLength: number;
  /** Artifact-derived token appended to asset URLs to defeat stale caches. */
  cacheBust: string;
  data: RuntimeDataSpec;
  stdlib: RuntimeStdlibSpec;
}

export const runtimeManifest = [
${versions}
] as const satisfies readonly RuntimeVersionSpec[];
`;
}

await mkdir(staticRoot, { recursive: true });

const result = await readRelease(release);

await writeFile(manifestOutput, renderManifest([result.entry]));

console.log(
  `Synced the Agda ${result.entry.agdaVersion} runtime release; ` +
    `${result.copied} artifact(s) updated in static/.`,
);
