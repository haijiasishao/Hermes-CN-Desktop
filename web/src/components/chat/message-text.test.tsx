import ReactDOMServer from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageText } from "./message-text";

describe("MessageText media download card", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a native download button instead of a raw unauthenticated anchor", () => {
    vi.stubGlobal("window", {
      __HERMES_RUNTIME__: {
        apiBaseUrl: "http://192.168.0.10:9119",
        sessionToken: "test-session-token",
      },
      hermesDesktop: {
        downloadFile: vi.fn(),
      },
    });

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageText text="MEDIA:/data/联合 督导 总台账.xlsx" />,
    );

    expect(html).toContain("联合 督导 总台账.xlsx");
    expect(html).toContain("<button");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("/api/files/download");
  });

  it("keeps the MEDIA reference actionable while runtime bridge is unavailable", () => {
    vi.stubGlobal("window", {});

    const html = ReactDOMServer.renderToStaticMarkup(
      <MessageText text="MEDIA:/tmp/report.txt" />,
    );

    expect(html).toContain("<button");
    expect(html).not.toContain("mediaFilePlaceholder");
  });
});
