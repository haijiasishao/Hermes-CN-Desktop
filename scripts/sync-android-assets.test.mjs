import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "scripts/sync-android-assets.mjs");

async function makeTempWorkspace() {
  return mkdtemp(join(tmpdir(), "hermes-android-assets-"));
}

async function writeFixtureFile(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function snapshotTree(rootPath) {
  const entries = [];

  async function visit(directoryPath, relativeDirectory) {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = join(directoryPath, child.name);
      const relativePath = relativeDirectory
        ? join(relativeDirectory, child.name)
        : child.name;
      if (child.isDirectory()) {
        entries.push(`${relativePath}/`);
        await visit(absolutePath, relativePath);
      } else {
        entries.push(`${relativePath}:${(await readFile(absolutePath)).toString("hex")}`);
      }
    }
  }

  await visit(rootPath, "");
  return entries;
}

function runSync(sourcePath, destinationPath) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--source", sourcePath, "--dest", destinationPath],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

async function assertFileContains(filePath, expected) {
  assert.equal(await readFile(filePath, "utf8"), expected);
}

test("syncs all files, removes stale assets, and is deterministic", async () => {
  const workspace = await makeTempWorkspace();
  try {
    const source = join(workspace, "source");
    const destination = join(workspace, "destination");
    await writeFixtureFile(
      join(source, "index.html"),
      `<!doctype html>
<script src="./assets/app%20bundle.js?cache=1#entry"></script>
<link href="%2E/assets/style.css#theme">
<link href="./.hidden/asset.txt?version=2">
`,
    );
    await writeFixtureFile(join(source, "assets", "app bundle.js"), "new javascript\n");
    await writeFixtureFile(join(source, "assets", "style.css"), "body { color: red; }\n");
    await writeFixtureFile(join(source, ".hidden", "asset.txt"), "hidden asset\n");
    await writeFixtureFile(join(source, ".root-file"), "preserve hidden files\n");
    await mkdir(join(source, "empty-directory"), { recursive: true });

    await writeFixtureFile(join(destination, "assets", "old-hash-000.js"), "stale\n");
    await writeFixtureFile(join(destination, ".old-hash"), "stale hidden\n");

    const firstRun = runSync(source, destination);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.match(firstRun.stdout, /Android assets synchronized/);
    assert.match(firstRun.stdout, /copiedFiles: 5/);
    assert.match(firstRun.stdout, /copiedBytes: \d+/);
    assert.ok(firstRun.stdout.includes(`source: ${source}`));
    assert.ok(firstRun.stdout.includes(`dest: ${destination}`));

    assert.deepEqual(await snapshotTree(destination), await snapshotTree(source));
    await assertFileContains(join(destination, "assets", "app bundle.js"), "new javascript\n");
    await assertFileContains(join(destination, ".root-file"), "preserve hidden files\n");
    await assert.rejects(stat(join(destination, "assets", "old-hash-000.js")));

    const firstSnapshot = await snapshotTree(destination);
    const secondRun = runSync(source, destination);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.deepEqual(await snapshotTree(destination), firstSnapshot);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fails on a missing index reference without changing destination", async () => {
  const workspace = await makeTempWorkspace();
  try {
    const source = join(workspace, "source");
    const destination = join(workspace, "destination");
    await writeFixtureFile(join(source, "index.html"), '<script src="./missing.js"></script>\n');
    await writeFixtureFile(join(destination, "keep.txt"), "keep me\n");
    const before = await snapshotTree(destination);

    const result = runSync(source, destination);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not exist/);
    assert.deepEqual(await snapshotTree(destination), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fails on a path traversal reference without changing destination", async () => {
  const workspace = await makeTempWorkspace();
  try {
    const source = join(workspace, "source");
    const destination = join(workspace, "destination");
    await writeFixtureFile(join(source, "index.html"), '<script src="../outside.js"></script>\n');
    await writeFixtureFile(join(workspace, "outside.js"), "outside\n");
    await writeFixtureFile(join(destination, "keep.txt"), "keep me\n");
    const before = await snapshotTree(destination);

    const result = runSync(source, destination);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /escapes source/);
    assert.deepEqual(await snapshotTree(destination), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fails for a missing source without changing destination", async () => {
  const workspace = await makeTempWorkspace();
  try {
    const source = join(workspace, "missing-source");
    const destination = join(workspace, "destination");
    await writeFixtureFile(join(destination, "keep.txt"), "keep me\n");
    const before = await snapshotTree(destination);

    const result = runSync(source, destination);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source directory does not exist/);
    assert.deepEqual(await snapshotTree(destination), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ignores external, data, blob, and hash references", async () => {
  const workspace = await makeTempWorkspace();
  try {
    const source = join(workspace, "source");
    const destination = join(workspace, "destination");
    await writeFixtureFile(
      join(source, "index.html"),
      `<link href="https://example.com/external.css">
<link href="http://example.com/external.css">
<link href="//cdn.example.com/external.css">
<link href="data:text/css,body%7B%7D">
<script src="blob:https://example.com/id"></script>
<a href="#same-document">same document</a>
<script src="./app.js?cache=1#main"></script>
`,
    );
    await writeFixtureFile(join(source, "app.js"), "console.log('local');\n");

    const result = runSync(source, destination);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await snapshotTree(destination), await snapshotTree(source));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI help is available", () => {
  const result = execFileSync(process.execPath, [scriptPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(result, /--source <dir>/);
  assert.match(result, /--dest <dir>/);
});
