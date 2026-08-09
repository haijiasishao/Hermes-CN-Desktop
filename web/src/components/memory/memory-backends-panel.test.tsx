import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const query = {
  data: undefined,
  error: null,
  isError: false,
  isFetching: false,
  isLoading: false,
  refetch: vi.fn().mockResolvedValue({ data: undefined }),
};

const configCalls: string[] = [];

vi.mock("@/hooks/use-memory", () => ({
  VISIBLE_MEMORY_PROVIDERS: ["openviking", "hindsight"],
  useMemoryProviders: () => ({
    ...query,
    data: {
      active: "",
      options: [
        { name: "openviking", available: true },
        { name: "hindsight", available: false },
      ],
    },
  }),
  useMemoryProviderStatus: () => query,
  useMemoryProviderConfig: (provider: string) => {
    configCalls.push(provider);
    return {
      ...query,
      data: {
        name: provider,
        label: provider === "openviking" ? "OpenViking" : "Hindsight",
        fields: [],
        setup: { dependencies_installed: true },
      },
    };
  },
  useSaveMemoryProviderConfig: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useSetupMemoryProvider: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useSetMemoryProvider: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { MemoryBackendsPanel } from "./memory-backends-panel";

describe("MemoryBackendsPanel", () => {
  it("renders the two supported backends as links on the config page", () => {
    configCalls.length = 0;
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter><MemoryBackendsPanel view="config" /></MemoryRouter>,
    );

    expect(html).toContain("OpenViking");
    expect(html).toContain("Hindsight");
    expect(html).toContain("/openviking");
    expect(html).toContain("/hindsight");
    expect(html).not.toContain("Honcho");
    expect(html).not.toContain("Mem0");
    expect(html).not.toContain("Supermemory");
  });

  it("reads both provider configs on config view", () => {
    configCalls.length = 0;
    ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter><MemoryBackendsPanel view="config" /></MemoryRouter>,
    );

    // Config view should trigger config queries for both providers
    expect(configCalls).toContain("openviking");
    expect(configCalls).toContain("hindsight");
  });

  it("renders provider controls only on the provider page", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter><MemoryBackendsPanel view="openviking" /></MemoryRouter>,
    );

    expect(html).toContain("OpenViking 控制台");
    expect(html).toContain("设为当前");
    expect(html).not.toContain("深度控制台");
  });

  it("shows 设为当前 button on provider detail page", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter><MemoryBackendsPanel view="openviking" /></MemoryRouter>,
    );

    // Provider detail should show "设为当前" since status is not active
    expect(html).toContain("设为当前");
  });
});
