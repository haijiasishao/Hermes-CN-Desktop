import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildMediaDownloadUrl,
  downloadMediaFile,
  hasMediaFileRefs,
  parseMediaFileRefs,
} from "./media-file-link";

describe("hasMediaFileRefs", () => {
  it("detects MEDIA: with Unix absolute path", () => {
    expect(hasMediaFileRefs("MEDIA:/data/联合督导总台账.xlsx")).toBe(true);
  });

  it("detects MEDIA: with path containing spaces", () => {
    expect(hasMediaFileRefs("MEDIA:/tmp/my files/report.pdf")).toBe(true);
  });

  it("detects MEDIA: on its own line in multiline text", () => {
    const text = "Here is your file:\nMEDIA:/tmp/output.csv\nLet me know if you need more.";
    expect(hasMediaFileRefs(text)).toBe(true);
  });

  it("does not match MEDIA: without absolute path", () => {
    expect(hasMediaFileRefs("MEDIA:relative/path.txt")).toBe(false);
  });

  it("does not match MEDIA: embedded in prose", () => {
    expect(hasMediaFileRefs("Use MEDIA:/path to reference files")).toBe(false);
  });

  it("does not match plain text without MEDIA:", () => {
    expect(hasMediaFileRefs("Hello, this is a normal message.")).toBe(false);
  });

  it("does not match MEDIA: without file extension", () => {
    expect(hasMediaFileRefs("MEDIA:/tmp/noext")).toBe(false);
  });
});

describe("parseMediaFileRefs", () => {
  it("extracts filename from Unix path", () => {
    const refs = parseMediaFileRefs("MEDIA:/data/reports/联合督导总台账.xlsx");
    expect(refs).toHaveLength(1);
    expect(refs[0].filename).toBe("联合督导总台账.xlsx");
    expect(refs[0].path).toBe("/data/reports/联合督导总台账.xlsx");
  });

  it("extracts multiple refs from multiline text", () => {
    const text = "MEDIA:/tmp/a.txt\nSome text\nMEDIA:/tmp/b.pdf";
    const refs = parseMediaFileRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].filename).toBe("a.txt");
    expect(refs[1].filename).toBe("b.pdf");
  });

  it("returns empty array for text without MEDIA:", () => {
    expect(parseMediaFileRefs("No files here.")).toEqual([]);
  });
});

describe("buildMediaDownloadUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds URL with encoded path and token", () => {
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: {
        apiBaseUrl: "http://192.168.1.10:9119",
        sessionToken: "tok123",
      },
    });

    const url = buildMediaDownloadUrl("/data/联合督导总台账.xlsx");
    expect(url).toContain("http://192.168.1.10:9119/api/files/download?path=");
    expect(url).toContain(encodeURIComponent("/data/联合督导总台账.xlsx"));
    expect(url).toContain("token=tok123");
  });

  it("returns null when no API base URL is available", () => {
    vi.stubGlobal("window", {});
    const url = buildMediaDownloadUrl("/tmp/file.txt");
    expect(url).toBeNull();
  });

  it("handles paths with spaces correctly", () => {
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: {
        apiBaseUrl: "http://localhost:9119",
        sessionToken: "t",
      },
    });

    const url = buildMediaDownloadUrl("/tmp/my files/doc.pdf");
    expect(url).toContain(encodeURIComponent("/tmp/my files/doc.pdf"));
  });
});

// ---------------------------------------------------------------------------
// downloadMediaFile: native Tauri bridge for cookie-auth environments
// ---------------------------------------------------------------------------

describe("downloadMediaFile (native bridge path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses hermesDesktop.downloadFile when available (Tauri/Android)", async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      ok: true,
      filename: "report.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      dataBase64: "dGVzdA==",
      size: 4,
    });
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: {
        apiBaseUrl: "http://192.168.1.10:9119",
        sessionToken: "tok_test",
        platform: "tauri",
      },
      hermesDesktop: {
        windowType: "tauri",
        request: vi.fn(),
        downloadFile: mockDownload,
      },
    });

    const result = await downloadMediaFile("/data/report.xlsx");

    expect(mockDownload).toHaveBeenCalledOnce();
    expect(mockDownload).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/data/report.xlsx" }),
    );
    expect(result).toEqual(
      expect.objectContaining({ ok: true, filename: "report.xlsx" }),
    );
    expect(result.dataBase64).toBe("dGVzdA==");
  });

  it("falls back to URL-based download when hermesDesktop.downloadFile is absent", async () => {
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: {
        apiBaseUrl: "http://localhost:9119",
        sessionToken: "tok123",
      },
      hermesDesktop: undefined,
    });

    const result = await downloadMediaFile("/tmp/file.txt");

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        fallbackUrl: expect.stringContaining("/api/files/download?path="),
      }),
    );
    expect(result.fallbackUrl).toContain("token=tok123");
  });

  it("encodes Unicode and spaces in path for native bridge", async () => {
    const mockDownload = vi.fn().mockResolvedValue({
      ok: true,
      filename: "联合督导总台账.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      dataBase64: "AAAA",
      size: 3,
    });
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: {
        apiBaseUrl: "http://192.168.1.10:9119",
        sessionToken: "tok_test",
        platform: "tauri",
      },
      hermesDesktop: {
        windowType: "tauri",
        request: vi.fn(),
        downloadFile: mockDownload,
      },
    });

    await downloadMediaFile("/data/联合 督导 总台账.xlsx");

    expect(mockDownload).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/data/联合 督导 总台账.xlsx" }),
    );
  });
});
