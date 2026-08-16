#!/usr/bin/env node

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const defaultSource = "web/dist";
const defaultDest = "android/app/src/main/assets";

function usage() {
  console.log(`Usage: node scripts/sync-android-assets.mjs [options]

Copies the built web assets into the Kotlin Android app's asset directory.

Options:
  --source <dir>  Source directory (default: web/dist)
  --dest <dir>    Destination directory (default: android/app/src/main/assets)
  --help          Show this help

Default paths are resolved from the repository root. Explicit relative paths
are resolved from the current working directory.
`);
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a directory path`);
  }
  return value;
}

function parseArgs(args) {
  const options = { source: undefined, dest: undefined, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--source") {
      options.source = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--source=")) {
      options.source = arg.slice("--source=".length);
      if (!options.source) throw new Error("--source requires a directory path");
      continue;
    }
    if (arg === "--dest") {
      options.dest = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--dest=")) {
      options.dest = arg.slice("--dest=".length);
      if (!options.dest) throw new Error("--dest requires a directory path");
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function resolveCliPath(value, fallback) {
  return resolve(value === undefined ? repoRoot : process.cwd(), value ?? fallback);
}

function pathIsWithin(parent, candidate) {
  const pathDifference = relative(parent, candidate);
  return (
    pathDifference === "" ||
    (!pathDifference.startsWith("..") && !isAbsolute(pathDifference))
  );
}

function realpathWithMissingTail(inputPath) {
  let currentPath = resolve(inputPath);
  const missingSegments = [];

  while (true) {
    try {
      let canonicalPath = realpathSync(currentPath);
      for (const segment of missingSegments.reverse()) {
        canonicalPath = join(canonicalPath, segment);
      }
      return resolve(canonicalPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) return resolve(inputPath);
      missingSegments.push(currentPath.slice(parentPath.length + 1));
      currentPath = parentPath;
    }
  }
}

function requireSourceDirectory(sourcePath) {
  let sourceStats;
  try {
    sourceStats = statSync(sourcePath);
  } catch {
    throw new Error(`source directory does not exist: ${sourcePath}`);
  }
  if (!sourceStats.isDirectory()) {
    throw new Error(`source path is not a directory: ${sourcePath}`);
  }

  const sourceRoot = realpathSync(sourcePath);
  const indexPath = join(sourceRoot, "index.html");
  let indexStats;
  try {
    indexStats = statSync(indexPath);
  } catch {
    throw new Error(`source/index.html does not exist: ${indexPath}`);
  }
  if (!indexStats.isFile()) {
    throw new Error(`source/index.html is not a file: ${indexPath}`);
  }

  return sourceRoot;
}

function validateDestination(destinationPath, sourceRoot) {
  const rootPath = parse(destinationPath).root;
  if (destinationPath === rootPath) {
    throw new Error(`refusing to use a filesystem root as destination: ${destinationPath}`);
  }

  const canonicalDestination = realpathWithMissingTail(destinationPath);
  const canonicalCwd = realpathWithMissingTail(process.cwd());
  const canonicalRepoRoot = realpathWithMissingTail(repoRoot);
  if (canonicalDestination === canonicalCwd || canonicalDestination === canonicalRepoRoot) {
    throw new Error(`refusing to use a working directory as destination: ${destinationPath}`);
  }

  let destinationStats;
  try {
    destinationStats = lstatSync(destinationPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (destinationStats?.isSymbolicLink()) {
    throw new Error(`destination must not be a symbolic link: ${destinationPath}`);
  }
  if (destinationStats && !destinationStats.isDirectory()) {
    throw new Error(`destination path is not a directory: ${destinationPath}`);
  }

  const sourceOverlapsDestination =
    pathIsWithin(sourceRoot, canonicalDestination) ||
    pathIsWithin(canonicalDestination, sourceRoot);
  if (sourceOverlapsDestination) {
    throw new Error(`source and destination must not overlap: ${sourceRoot} and ${destinationPath}`);
  }

  return destinationPath;
}

function localReferencePath(rawReference) {
  const reference = rawReference.trim();
  if (
    reference === "" ||
    reference.startsWith("#") ||
    reference.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(reference)
  ) {
    return null;
  }

  const withoutQueryOrHash = reference.split(/[?#]/, 1)[0];
  if (withoutQueryOrHash === "") return null;

  let decodedReference;
  try {
    decodedReference = decodeURIComponent(withoutQueryOrHash);
  } catch {
    throw new Error(`invalid URL encoding in index.html reference: ${rawReference}`);
  }
  if (decodedReference === "" || decodedReference.startsWith("#")) return null;
  if (decodedReference.startsWith("//")) return null;

  return decodedReference.startsWith("/")
    ? decodedReference.slice(1)
    : decodedReference;
}

function extractIndexReferences(indexHtml) {
  const withoutComments = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
  const attributePattern =
    /(?:^|[\s<])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  const references = [];
  let match;

  while ((match = attributePattern.exec(withoutComments)) !== null) {
    references.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return references;
}

function validateIndexReferences(sourceRoot) {
  const indexPath = join(sourceRoot, "index.html");
  let indexHtml;
  try {
    indexHtml = readFileSync(indexPath, "utf8");
  } catch (error) {
    throw new Error(`could not read source/index.html: ${error.message}`);
  }

  const localReferences = new Set();
  for (const rawReference of extractIndexReferences(indexHtml)) {
    const relativeReference = localReferencePath(rawReference);
    if (relativeReference === null) continue;

    let referencedPath;
    try {
      referencedPath = resolve(sourceRoot, relativeReference);
    } catch {
      throw new Error(`invalid local index.html reference: ${rawReference}`);
    }
    if (!pathIsWithin(sourceRoot, referencedPath)) {
      throw new Error(`index.html reference escapes source: ${rawReference}`);
    }

    let referencedStats;
    try {
      referencedStats = statSync(referencedPath);
    } catch {
      throw new Error(`index.html reference does not exist: ${rawReference}`);
    }
    if (!referencedStats.isFile()) {
      throw new Error(`index.html reference is not a file: ${rawReference}`);
    }
    localReferences.add(relative(sourceRoot, referencedPath));
  }

  return localReferences;
}

function inspectSourceTree(sourceRoot) {
  const directories = [];
  const files = [];
  let bytes = 0n;

  function visit(directoryPath, relativeDirectory) {
    let entries;
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw new Error(`could not read source directory ${directoryPath}: ${error.message}`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(directoryPath, entry.name);
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        let fileStats;
        try {
          fileStats = statSync(absolutePath);
        } catch (error) {
          throw new Error(`could not inspect source file ${absolutePath}: ${error.message}`);
        }
        files.push({ absolutePath, relativePath, size: fileStats.size });
        bytes += BigInt(fileStats.size);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not supported in source assets: ${absolutePath}`);
      }
      throw new Error(`unsupported source directory entry: ${absolutePath}`);
    }
  }

  visit(sourceRoot, "");
  return { bytes, directories, files };
}

function resetDestination(destinationPath) {
  rmSync(destinationPath, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  mkdirSync(destinationPath, { recursive: true });
}

function copySourceTree(sourceTree, destinationPath) {
  for (const directory of sourceTree.directories) {
    mkdirSync(join(destinationPath, directory), { recursive: true });
  }
  for (const file of sourceTree.files) {
    const destinationFile = join(destinationPath, file.relativePath);
    mkdirSync(dirname(destinationFile), { recursive: true });
    copyFileSync(file.absolutePath, destinationFile);
  }
}

function syncAssets({ source, dest }) {
  const sourcePath = resolveCliPath(source, defaultSource);
  const destinationPath = resolveCliPath(dest, defaultDest);

  const sourceRoot = requireSourceDirectory(sourcePath);
  const safeDestination = validateDestination(destinationPath, sourceRoot);
  const localReferences = validateIndexReferences(sourceRoot);
  const sourceTree = inspectSourceTree(sourceRoot);

  resetDestination(safeDestination);
  copySourceTree(sourceTree, safeDestination);

  console.log("Android assets synchronized.");
  console.log(`source: ${sourcePath}`);
  console.log(`dest: ${safeDestination}`);
  console.log(`validatedLocalReferences: ${localReferences.size}`);
  console.log(`copiedDirectories: ${sourceTree.directories.length}`);
  console.log(`copiedFiles: ${sourceTree.files.length}`);
  console.log(`copiedBytes: ${sourceTree.bytes}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  syncAssets(options);
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedScript === resolve(scriptPath)) {
  try {
    main();
  } catch (error) {
    console.error(`sync-android-assets: ${error.message}`);
    process.exitCode = 1;
  }
}
