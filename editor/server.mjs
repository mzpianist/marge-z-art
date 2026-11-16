// =============================================================================
// MARGE Z EDITOR — local server
// A dashboard for the site's content (the text, links, photos and colours of
// each page), so changing something doesn't mean hunting through src/content/.
// Start it with `npm run editor` or the "Marge Z Editor" shortcut on the
// Desktop (made by `npm run editor:shortcut`). It opens in the browser and
// saves straight into the data files below; nothing here is part of the
// published site, and it only answers requests from this computer.
//
// Saved changes show up in the local site preview right away. The Publish
// button commits them and pushes to `main`, which deploys margezart.com.
// =============================================================================

import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, rename, access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4410;
const SITE_PORT = 4331; // Astro's dev server, used for "View on site" links
const SITE_URL = `http://localhost:${SITE_PORT}`;
const NO_OPEN = process.argv.includes("--no-open");

const run = promisify(execFile);

// The files the editor may write, each read and saved as a whole. `title`
// names them on the Publish screen and in commit messages.
const DATASETS = {
  home: { file: "src/content/home.json", title: "Home" },
  about: { file: "src/content/about.json", title: "About me" },
  resume: { file: "src/content/resume.json", title: "Resume / CV" },
  artistResume: { file: "src/content/artistResume.json", title: "Artist resume" },
  press: { file: "src/content/press.json", title: "In media" },
  art: { file: "src/content/art.json", title: "Art" },
  music: { file: "src/content/music.json", title: "Music" },
  projects: { file: "src/content/projects.json", title: "Other projects" },
  shop: { file: "src/content/shop.json", title: "Shop" },
  contact: { file: "src/content/contact.json", title: "Contact" },
  palettes: { file: "src/content/palettes.json", title: "Colours" },
  site: { file: "src/content/site.json", title: "Site settings" },
};

// Uploaded photos go here. They're resized to fit inside PHOTO_MAX and saved
// as WebP (animated GIFs are kept as they are). The data files refer to a
// photo by its bare filename.
const PHOTO_DIR = "src/assets";
const PHOTO_MAX = 1600;

// ---------- Reading & writing data files ----------

const hash = (text) => createHash("sha1").update(text).digest("hex");
const str = (v) => (typeof v === "string" ? v.trim() : "");

async function load(name) {
  const text = await readFile(path.join(ROOT, DATASETS[name].file), "utf8");
  return { data: JSON.parse(text), version: hash(text) };
}

// Writes via a temp file + rename, so the site preview never reads a
// half-written file.
async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  await writeFile(tmp, text);
  await rename(tmp, file);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const luminance = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

// The whole site is drawn in these colours, so a bad pair would make every
// page unreadable: keep the same rule the editor shows on screen.
function checkPalettes(list) {
  if (list.length < 2) throw httpError(400, "Keep at least two colour pairs so the site has something to change between.");
  for (const p of list) {
    const ok = [p?.bg, p?.fg].every((c) => /^#[0-9a-f]{6}$/i.test(c ?? ""));
    if (!ok) throw httpError(400, "Each colour pair needs a background and a text colour.");
    if (contrast(p.bg, p.fg) < 4.5) {
      throw httpError(400, `“${p.name || p.bg}” doesn't have enough contrast to read (it needs at least 4.5).`);
    }
  }
}

async function save(name, data, version) {
  const current = await load(name);
  if (current.version !== version) {
    throw httpError(
      409,
      `${DATASETS[name].file} was changed outside the editor since you opened it. ` +
        "The editor has reloaded the latest version; please make your change again.",
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data) !== Array.isArray(current.data)) {
    throw httpError(400, "That doesn't look like the right kind of data for this file.");
  }
  if (name === "palettes") checkPalettes(data);
  const text = JSON.stringify(data, null, 2) + "\n";
  await writeAtomic(path.join(ROOT, DATASETS[name].file), text);
  return { version: hash(text) };
}

// ---------- Photos ----------

function slugify(s) {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "photo"
  );
}

const exists = (p) => access(p).then(() => true, () => false);

// Saves an uploaded photo as src/assets/<name>.webp (.gif for GIFs). A name
// already taken by another photo gets a -2, -3, ... suffix rather than being
// overwritten, so a photo used elsewhere on the site is never replaced.
async function savePhoto({ name, dataUrl }) {
  // Any file type is accepted here (browsers often don't label iPhone HEIC
  // photos as images); sharp or sips decides whether it really is one.
  const match = /^data:([^,;]*)[^,]*;base64,(.+)$/s.exec(dataUrl ?? "");
  if (!match) throw httpError(400, "That file isn't an image.");
  const input = Buffer.from(match[2], "base64");
  const isGif = match[1] === "image/gif" || input.subarray(0, 4).toString("latin1") === "GIF8";

  const dir = path.join(ROOT, PHOTO_DIR);
  const base = slugify(str(name).replace(/\.[a-z0-9]+$/i, ""));
  const ext = isGif ? "gif" : "webp";
  let file = `${base}.${ext}`;
  for (let n = 2; await exists(path.join(dir, file)); n++) file = `${base}-${n}.${ext}`;

  if (isGif) {
    await writeFile(path.join(dir, file), input);
    return { image: file };
  }
  const toWebp = (buf) =>
    sharp(buf)
      .rotate() // respect the phone's orientation flag
      .resize({ width: PHOTO_MAX, height: PHOTO_MAX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84 })
      .toFile(path.join(dir, file));
  try {
    await toWebp(input);
  } catch {
    // sharp can't read iPhone HEIC photos; macOS's built-in `sips` can.
    try {
      await toWebp(await convertWithSips(input));
    } catch {
      throw httpError(400, "Couldn't read that image. Try a JPG, PNG, WebP, GIF or HEIC photo.");
    }
  }
  return { image: file };
}

async function convertWithSips(input) {
  const dir = await mkdtemp(path.join(tmpdir(), "marge-z-editor-"));
  try {
    await writeFile(path.join(dir, "in"), input);
    await run("sips", ["-s", "format", "jpeg", path.join(dir, "in"), "--out", path.join(dir, "out.jpg")]);
    return await readFile(path.join(dir, "out.jpg"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- Publishing ----------
// Publishing commits only the files the editor manages (the data files and
// photos above) and pushes them to GitHub, where the Deploy workflow rebuilds
// margezart.com. Anything else that's uncommitted is left alone.

const DATA_FILES = Object.values(DATASETS).map((d) => d.file);
// The code that reads the data files. If it has unpublished changes, the
// data might depend on them, so publishing waits until they're committed.
const LOADERS = "src/content/*.ts";

const git = async (args, timeout = 20_000) =>
  (await run("git", args, { cwd: ROOT, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;

// `git status` entries for the given paths, as { code, file }.
async function gitChanges(paths) {
  const out = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  const parts = out.split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    changes.push({ code, file: parts[i].slice(3) });
    if (code.includes("R") || code.includes("C")) i++; // skip a rename's old path
  }
  return changes;
}

async function publishStatus() {
  const problem = (message) => ({ problem: message, changes: [], pending: [], files: [] });
  try {
    await git(["rev-parse", "--git-dir"]);
  } catch {
    return problem("This folder isn't connected to GitHub yet (it's not a git repository). Ask Claude to set that up.");
  }
  let branch;
  try {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return problem("Nothing has been committed in this folder yet. Ask Claude to make the first commit and connect GitHub.");
  }
  if (branch !== "main") {
    return problem(`This folder is on the “${branch}” branch, and only “main” goes live. Ask Claude to switch back to main.`);
  }
  const gitDir = path.resolve(ROOT, (await git(["rev-parse", "--git-dir"])).trim());
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    if (await exists(path.join(gitDir, marker))) {
      return problem("A git merge or rebase is in progress in this folder. Ask Claude to finish it first.");
    }
  }
  const all = await gitChanges([LOADERS, ...DATA_FILES, PHOTO_DIR]);
  const loaders = all.filter((c) => c.file.startsWith("src/content/") && c.file.endsWith(".ts"));
  if (loaders.length) {
    return problem(
      `Some site code that reads this content hasn't been published yet (${loaders.map((c) => c.file).join(", ")}). ` +
        "Ask Claude to commit it first.",
    );
  }

  const changes = [];
  const files = [];
  for (const ds of Object.values(DATASETS)) {
    const change = all.find((c) => c.file === ds.file);
    if (!change) continue;
    changes.push({ title: ds.title, action: change.code === "??" ? "add" : "update", label: "text" });
    files.push(ds.file);
  }
  // Photos count only if some data file uses them (or they're being
  // replaced/removed); leftovers from a swapped-out upload stay unpublished.
  const dataText = (await Promise.all(DATA_FILES.map((f) => readFile(path.join(ROOT, f), "utf8")))).join("\n");
  for (const { code, file } of all.filter((c) => c.file.startsWith(PHOTO_DIR + "/"))) {
    const untracked = code === "??";
    if (untracked && !dataText.includes(JSON.stringify(path.basename(file)))) continue;
    const action = code.includes("D") ? "remove" : untracked || code.includes("A") ? "add" : "update";
    changes.push({ title: "Photos", action, label: path.basename(file) });
    files.push(file);
  }

  let pending;
  try {
    pending = (await git(["log", "--format=%s", "@{u}..HEAD"])).split("\n").filter(Boolean);
  } catch {
    return problem("This branch isn't linked to GitHub yet. Ask Claude to set that up.");
  }
  return { changes, files, pending };
}

function commitMessage(changes) {
  const titles = [...new Set(changes.map((c) => c.title))];
  const subject =
    changes.length === 1
      ? `${changes[0].title}: ${changes[0].action} ${changes[0].label}`
      : titles.length === 1
        ? `Update ${titles[0]}`
        : `Update ${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  const body = changes.map((c) => `- ${c.title}: ${c.action} ${c.label}`).join("\n");
  return { subject, body: `${body}\n\nPublished from the Marge Z Editor.` };
}

async function publish() {
  const status = await publishStatus();
  if (status.problem) throw httpError(409, status.problem);
  if (!status.changes.length && !status.pending.length) throw httpError(409, "Everything is already published.");

  try {
    await git(["fetch", "--quiet", "origin"], 60_000);
  } catch {
    throw httpError(502, "Couldn't reach GitHub. Check the internet connection and try again. Nothing was published.");
  }
  if (Number(await git(["rev-list", "--count", "HEAD..@{u}"])) > 0) {
    throw httpError(
      409,
      "GitHub has changes that aren't on this computer yet (made somewhere else). " +
        "Ask Claude to bring them in, then publish again. Nothing was published.",
    );
  }

  if (status.changes.length) {
    const { subject, body } = commitMessage(status.changes);
    await git(["add", "-A", "--", ...status.files]);
    await git(["commit", "--quiet", "-m", subject, "-m", body, "--only", "--", ...status.files]);
  }
  try {
    await git(["push", "--quiet"], 120_000);
  } catch (err) {
    const reason = String(err.stderr || err.message).trim().split("\n")[0];
    throw httpError(
      502,
      `Saved a snapshot on this computer, but couldn't send it to GitHub (${reason}). Try Publish again in a moment.`,
    );
  }
  return { sha: (await git(["rev-parse", "HEAD"])).trim() };
}

// Deploy progress for a pushed commit, from the GitHub CLI if it's set up.
async function deployStatus(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw httpError(400, "Bad commit id.");
  try {
    const { stdout } = await run(
      "gh",
      ["run", "list", "--commit", sha, "--workflow", "deploy.yml", "--limit", "1", "--json", "status,conclusion,url"],
      { cwd: ROOT, timeout: 20_000 },
    );
    const [runInfo] = JSON.parse(stdout);
    return runInfo ? { available: true, ...runInfo } : { available: true, status: "waiting" };
  } catch {
    return { available: false };
  }
}

// ---------- HTTP ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

// Only answer this computer's own browser: the Host header must be ours (stops
// DNS-rebinding tricks), and writes must be same-origin JSON (stops other
// websites from posting to the editor while it's running).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function isTrusted(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) return false;
  if (req.method === "GET") return true;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ""))) return false;
  return (req.headers["content-type"] ?? "").startsWith("application/json");
}

async function readJson(req, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "That file is too big.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

// Serves a file from `dir` (relative to ROOT), refusing paths that escape it.
async function serveFrom(res, dir, rel) {
  const base = path.join(ROOT, dir);
  const file = path.join(base, decodeURIComponent(rel));
  if (!file.startsWith(base + path.sep)) return send(res, 404, "Not found", "text/plain");
  try {
    const body = await readFile(file);
    send(res, 200, body, TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

const FONT_DIR = "node_modules/@fontsource-variable/bricolage-grotesque/files";

async function handle(req, res) {
  if (!isTrusted(req)) return send(res, 403, { error: "Forbidden" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const route = `${req.method} ${pathname}`;

  if (route === "GET /") return serveFrom(res, "editor", "index.html");
  // Photos and the site's typeface, for the editor's own screen.
  if (req.method === "GET" && pathname.startsWith("/assets/")) return serveFrom(res, PHOTO_DIR, pathname.slice(8));
  if (req.method === "GET" && pathname.startsWith("/public/")) return serveFrom(res, "public", pathname.slice(8));
  if (route === "GET /font.woff2") return serveFrom(res, FONT_DIR, "bricolage-grotesque-latin-wght-normal.woff2");

  if (route === "GET /api/data") {
    const out = { preview: SITE_URL };
    for (const name of Object.keys(DATASETS)) out[name] = { ...(await load(name)), file: DATASETS[name].file };
    return send(res, 200, out);
  }
  const dataset = /^\/api\/data\/(\w+)$/.exec(pathname)?.[1];
  if (req.method === "PUT" && dataset && Object.hasOwn(DATASETS, dataset)) {
    const { data, version } = await readJson(req);
    return send(res, 200, await save(dataset, data, version));
  }
  if (route === "POST /api/photo") return send(res, 200, await savePhoto(await readJson(req)));

  if (route === "GET /api/publish") {
    const { files, ...status } = await publishStatus();
    return send(res, 200, status);
  }
  if (route === "POST /api/publish") return send(res, 200, await publish());
  if (route === "GET /api/deploy") return send(res, 200, await deployStatus(url.searchParams.get("sha")));

  send(res, 404, { error: "Not found" });
}

// Saves, uploads and publishes run one at a time, so a save can't land
// halfway through a publish. Reads don't wait.
let writes = Promise.resolve();
const server = http.createServer((req, res) => {
  const respond = () =>
    handle(req, res).catch((err) => {
      if (!err.status) console.error(err);
      send(res, err.status ?? 500, { error: err.status ? err.message : `Something went wrong: ${err.message}` });
    });
  if (req.method === "GET") respond();
  else writes = writes.then(respond);
});

// ---------- Site preview ----------

// Starts Astro's dev server alongside the editor (unless one is already
// running) so "View on site" links show saved changes immediately.
let sitePreview = null;

async function ensureSitePreview() {
  try {
    await fetch(SITE_URL, { signal: AbortSignal.timeout(1500) });
    return; // already running
  } catch {}
  sitePreview = spawn(path.join(ROOT, "node_modules", ".bin", "astro"), ["dev", "--port", String(SITE_PORT)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  sitePreview.on("exit", (code) => {
    if (code) console.log(`  (The site preview stopped unexpectedly. Run \`npm run dev\` to see the error.)`);
    sitePreview = null;
  });
}

function shutdown() {
  sitePreview?.kill();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, shutdown);

const openInBrowser = (url) => !NO_OPEN && execFile("open", [url]);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Already open (e.g. the shortcut was double-clicked twice): just show it.
    console.log(`The editor is already running at http://localhost:${PORT}`);
    openInBrowser(`http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Marge Z Editor is running at ${url}`);
  console.log(`  Site preview: ${SITE_URL}`);
  console.log(`\n  Keep this window open while you edit. Close it (or press Ctrl+C) to stop.\n`);
  openInBrowser(url);
  await ensureSitePreview();
});
