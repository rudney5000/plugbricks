import type { ActionInput, ActionRecord, AuditEntry, BricksResponse, Session } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      code = body.error;
    } catch {
      // Not a JSON error: the status is all we have.
    }
    throw new ApiError(res.status, code ? `${code} (HTTP ${res.status})` : `${path}: HTTP ${res.status}`, code);
  }
  return (await res.json()) as T;
}

export const getSession = () => call<Session>("/api/session");
export const getBricks = () => call<BricksResponse>("/api/bricks");
export const getAudit = () => call<{ entries: AuditEntry[] }>("/api/audit");
export const getAction = (id: string) => call<ActionRecord>(`/api/actions/${encodeURIComponent(id)}`);

export const postAction = (input: ActionInput) =>
  call<{ id: string }>("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
