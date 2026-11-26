export type LiveState = "healthy" | "starting" | "unhealthy" | "stopped" | "not deployed" | "unknown";
export type Role = "admin" | "viewer";

/** A brick another one needs: a capability it requires, an entity it extends, or a link its manifest declares. */
export interface AdminDependency {
  brick: string;
  kind: "capability" | "extends" | "declared";
  /** The capability, the entities, or the manifest's own description. */
  label: string;
  optional: boolean;
  installed: boolean;
  enabled: boolean;
}

/** What a brick's API asks of a token (D22). */
export interface AdminAuthorization {
  /** "roles": the API enforces the roles below; "open": it requires oidc and declares none, so any valid token may call it; "none": no token is involved. */
  state: "roles" | "open" | "none";
  /** The role each operation class asks for; null when the class is left out (any valid token). */
  queries: string | null;
  mutations: string | null;
  /** "<brick>/<role>": the roles the brick's own service account is given on the bricks it depends on. */
  grants: string[];
}

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
  /** A web brick's entry page, http://127.0.0.1:<webPort><path> (D17); null for any other brick. */
  webUrl: string | null;
  /** The address of a subgraph that runs elsewhere (D33); null for any other brick. */
  external: string | null;
  extends: string;
  provides: string[];
  requires: string;
  /** Why `remove` would be refused (CAPABILITY_IN_USE, EXTENDS_IN_USE, DEPENDENCY_IN_USE), from the CLI's own check. */
  removeBlockedBy: { code: string; message: string }[];
  /** The bricks this one needs, in name order. */
  dependsOn: AdminDependency[];
  authorization: AdminAuthorization;
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
