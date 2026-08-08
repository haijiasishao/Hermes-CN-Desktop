/**
 * MEDIA: file reference detection and download URL construction.
 *
 * The assistant sometimes returns file paths in the form:
 *   MEDIA:/absolute/path/to/file.ext
 * This module detects these patterns and constructs protected download URLs
 * through the Dashboard `/api/files/download` endpoint.
 */

import { runtime } from "./runtime";

// Matches MEDIA: followed by an absolute path (Unix or Windows-style).
// Must be on its own line or surrounded by whitespace to avoid false positives
// inside code blocks or regular prose.
const MEDIA_LINE_RE = /^MEDIA:(\/[^\r\n]*\.[a-zA-Z0-9]{1,10}|[A-Z]:\\[^\r\n]*\.[a-zA-Z0-9]{1,10})$/;

export interface MediaFileRef {
  /** Original path from the MEDIA: line. */
  path: string;
  /** Display filename (last path component). */
  filename: string;
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
    apiBaseUrl = runtime.getApiUrl("");
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
