import { describe, expect, it } from "vitest";
import { resolveHermesHomeDisplay } from "./health-grid-state";

describe("resolveHermesHomeDisplay", () => {
  it("shows a resolved path when the backend provides one", () => {
    expect(resolveHermesHomeDisplay({
      path: "/home/hermes/.hermes",
      statusReady: true,
      statusError: false,
      androidRemoteOnly: true,
    })).toMatchObject({ tone: "ok", value: "/home/hermes/.hermes", sub: "数据目录已识别" });
  });

  it("does not call an Android Remote path omission a loading state", () => {
    expect(resolveHermesHomeDisplay({
      path: undefined,
      statusReady: true,
      statusError: false,
      androidRemoteOnly: true,
    })).toMatchObject({ tone: "ok", value: "远程后端", sub: "数据目录由远程后端管理" });
  });

  it("keeps an actual status failure visible", () => {
    expect(resolveHermesHomeDisplay({
      path: undefined,
      statusReady: false,
      statusError: true,
      androidRemoteOnly: true,
    })).toMatchObject({ tone: "err", value: "读取失败" });
  });

  it("distinguishes a loaded response without a path from an initial load", () => {
    expect(resolveHermesHomeDisplay({
      path: undefined,
      statusReady: true,
      statusError: false,
      androidRemoteOnly: false,
    })).toMatchObject({ tone: "warn", sub: "后端未返回目录路径" });
    expect(resolveHermesHomeDisplay({
      path: undefined,
      statusReady: false,
      statusError: false,
      androidRemoteOnly: false,
    })).toMatchObject({ tone: "warn", sub: "正在读取数据目录" });
  });
});
