export type HealthHomeTone = "ok" | "warn" | "err";

export interface HermesHomeDisplay {
  tone: HealthHomeTone;
  value: string;
  sub: string;
  detail: string;
}

export function resolveHermesHomeDisplay(input: {
  path?: string | null;
  statusReady: boolean;
  statusError: boolean;
  androidRemoteOnly: boolean;
}): HermesHomeDisplay {
  if (input.path) {
    return {
      tone: "ok",
      value: input.path,
      sub: "数据目录已识别",
      detail: "这是当前后端 profile 的配置、会话和环境变量根目录。",
    };
  }

  if (input.statusError) {
    return {
      tone: "err",
      value: "读取失败",
      sub: "状态接口不可用",
      detail: "无法从 Dashboard 状态接口读取数据目录信息，请检查远程连接。",
    };
  }

  if (input.androidRemoteOnly && input.statusReady) {
    return {
      tone: "ok",
      value: "远程后端",
      sub: "数据目录由远程后端管理",
      detail: "Android Remote 不读取或展示远程主机本地路径；配置、会话和环境由远程 Dashboard 管理。",
    };
  }

  if (!input.statusReady) {
    return {
      tone: "warn",
      value: "—",
      sub: "正在读取数据目录",
      detail: "正在等待 Dashboard 状态接口返回。",
    };
  }

  return {
    tone: "warn",
    value: "—",
    sub: "后端未返回目录路径",
    detail: "当前 Dashboard 未返回 Hermes Home 路径；这不等同于数据目录不可用。",
  };
}
