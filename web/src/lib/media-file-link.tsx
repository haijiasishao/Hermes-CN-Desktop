/**
 * MEDIA:/sandbox: file reference detection and download URL construction.
 *
 * The assistant sometimes returns file paths in the form:
 *   MEDIA:/absolute/path/to/file.ext
 * This module detects these patterns and constructs protected download URLs
 * through the Dashboard `/api/files/download` endpoint.
 */

import { runtime } from "./runtime";

// Matches MEDIA: followed by an absolute path (Unix or Windows-style). The
// producer may insert one or more spaces after the colon and a sentence may
// append Chinese/ASCII punctuation after the path; keep those out of `path`.
const MEDIA_LINE_RE = /^MEDIA:\s*((?:\/[^\r\n]*?\.[a-zA-Z0-9]{1,64}|[A-Z]:\\[^\r\n]*?\.[a-zA-Z0-9]{1,64}))(?:[。！？？，,.;；])?$/;
const SANDBOX_MARKDOWN_LINE_RE = /^\[([^\]\r\n]+)\]\(sandbox:(\/[^)\r\n]*)\)$/i;

export interface MediaFileRef {
  /** Original path from the MEDIA: line. */
  path: string;
  /** Display filename (last path component). */
  filename: string;
  /** Optional Markdown label supplied by a sandbox: link. */
  displayName?: string;
  /** Dashboard download URL, or null if runtime info is unavailable. */
  downloadUrl: string | null;
}

function fileNameFromMediaPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Build a Dashboard download URL for a remote file path.
 * Uses runtime API base URL + session token. Returns null when the runtime
 * info is not available (safe fallback — caller should show plain text).
 */
export function buildMediaDownloadUrl(filePath: string): string | null {
  let apiBaseUrl: string;
  let token: string | undefined;
  try {
    const configuredBaseUrl = window.__HERMES_RUNTIME__?.apiBaseUrl
      ?? window.__HERMES_RUNTIME__?.dashboardApiBaseUrl;
    apiBaseUrl = configuredBaseUrl || runtime.getApiUrl("");
    token = runtime.getSessionToken();
  } catch {
    return null;
  }
  if (!apiBaseUrl) return null;

  // Construct the download URL with proper encoding for paths with
  // Chinese characters and spaces.
  const encodedPath = encodeURIComponent(filePath);
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  let url = `${base}/api/files/download?path=${encodedPath}`;
  if (token) {
    url += `&token=${encodeURIComponent(token)}`;
  }
  return url;
}

/**
 * Parse a text block and extract MEDIA: file references.
 * Returns an array of { path, filename, downloadUrl } for each match.
 */
export function parseMediaFileRefs(text: string): MediaFileRef[] {
  const refs: MediaFileRef[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = MEDIA_LINE_RE.exec(trimmed);
    if (match) {
      const filePath = match[1];
      refs.push({
        path: filePath,
        filename: fileNameFromMediaPath(filePath),
        downloadUrl: buildMediaDownloadUrl(filePath),
      });
    }
  }
  return refs;
}

/**
 * Check whether text contains any MEDIA: file references.
 */
export function hasMediaFileRefs(text: string): boolean {
  return text.split("\n").some((line) => MEDIA_LINE_RE.test(line.trim()));
}

function decodeSandboxPath(rawPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return path.startsWith("/") ? path : null;
}

/** Parse Markdown links emitted by tools as `[label](sandbox:/absolute/path)`. */
export function parseSandboxFileRefs(text: string): MediaFileRef[] {
  const refs: MediaFileRef[] = [];
  for (const line of text.split("\n")) {
    const match = SANDBOX_MARKDOWN_LINE_RE.exec(line.trim());
    if (!match) continue;
    const filePath = decodeSandboxPath(match[2]);
    if (!filePath) continue;
    refs.push({
      path: filePath,
      filename: fileNameFromMediaPath(filePath),
      displayName: match[1].trim() || undefined,
      downloadUrl: buildMediaDownloadUrl(filePath),
    });
  }
  return refs;
}

export function hasSandboxFileRefs(text: string): boolean {
  return parseSandboxFileRefs(text).length > 0;
}


/** Result of a native (Tauri) or fallback file download attempt. */
export interface DownloadMediaResult {
  ok: boolean;
  filename?: string;
  mimeType?: string;
  dataBase64?: string;
  size?: number;
  /** Browser-only fallback URL (token-in-query) for <a> anchor download. */
  fallbackUrl?: string;
}

/**
 * Download a remote file through the native Tauri bridge when available
 * (cookie-auth safe — Rust carries the OAuth cookie jar or Bearer token).
 * Falls back to a token-in-query URL for plain browser environments.
 */
export async function downloadMediaFile(
  filePath: string,
): Promise<DownloadMediaResult> {
  const bridge = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  if (bridge?.downloadFile) {
    const result = await bridge.downloadFile({ filePath });
    return { ...result, filename: result.filename ?? fileNameFromMediaPath(filePath) };
  }
  // Browser fallback: return a URL with token-in-query so the caller can
  // open it or attach it to an <a> element.
  const fallbackUrl = buildMediaDownloadUrl(filePath);
  return { ok: true, fallbackUrl: fallbackUrl ?? undefined };
}

export { MEDIA_LINE_RE };
