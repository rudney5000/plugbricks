import type { AuditEntry, BricksResponse, Session } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new ApiError(res.status, `${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const getSession = () => get<Session>("/api/session");
export const getBricks = () => get<BricksResponse>("/api/bricks");
export const getAudit = () => get<{ entries: AuditEntry[] }>("/api/audit");
