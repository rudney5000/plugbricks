export type LiveState = "healthy" | "starting" | "unhealthy" | "stopped" | "not deployed" | "unknown";
export type Role = "admin" | "viewer";

export interface AdminBrick {
  name: string;
  version: string;
  tags: string[];
  enabled: boolean;
  deployed: boolean;
  state: LiveState;
  reason: string | null;
  restarts: number;
  port: number | null;
  subgraph: boolean;
  extends: string;
  provides: string[];
  requires: string;
}

export interface RouterConfig {
  sha256: string;
  size: number;
  source: string;
  federatedSdl: string | null;
  composition: { subgraphs: number; extendedEntities: string[] };
}

export interface RouterView {
  state: LiveState;
  address: string | null;
  image: string;
  digest: string | null;
  subgraphs: { brick: string; name: string; state: LiveState }[];
  config: RouterConfig | null;
}

export interface Problem {
  code: string;
  path: string;
  message: string;
}

export interface BricksResponse {
  platform: string;
  runtime: string;
  router: RouterView | null;
  summary: { total: number; healthy: number; down: number; stopped: number };
  bricks: AdminBrick[];
  problems: Problem[];
}

export interface Session {
  authenticated: boolean;
  dev: boolean;
  role: Role | null;
  name: string;
  project: string;
  runtime: string;
}

export type ActionName = "add" | "enable" | "disable" | "remove" | "up";

export interface ActionInput {
  action: ActionName;
  brick?: string;
  source?: string;
}

export interface ActionRecord {
  id: string;
  action: ActionName;
  brick?: string;
  source?: string;
  user: string;
  role: Role;
  state: "running" | "succeeded" | "failed";
  exitCode: number | null;
  output: string[];
  issues: string[];
  startedAt: string;
  finishedAt: string | null;
}

export interface AuditEntry {
  time: string;
  user: string;
  role: string;
  action: string;
  brick: string;
  result: "Accepted" | "Success" | "Refused" | "Failed";
  details: string;
}
