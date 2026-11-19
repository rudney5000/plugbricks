import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { K8sTarget, Runtime } from "../runtime.js";

export const ACTION_NAMES = ["add", "enable", "disable", "remove", "up"] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

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
  role: "admin" | "viewer";
  state: "running" | "succeeded" | "failed";
  exitCode: number | null;
  output: string[];
  issues: string[];
  startedAt: string;
  finishedAt: string | null;
}

export interface Actor {
  name: string;
  sub: string;
  role: "admin" | "viewer";
}

/** The schema's brick name pattern; the admin refuses anything else before running the CLI. */
export const BRICK_NAME = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

export interface ValidAction {
  ok: true;
  input: ActionInput;
}

export interface InvalidAction {
  ok: false;
  code: string;
}

function validSource(source: unknown): source is string {
  if (typeof source !== "string" || source.length === 0) return false;
  if (source.includes("\0")) return false;
  // Relative to the platform root: no option-looking path, no absolute POSIX or Windows path.
  if (source.startsWith("-") || source.startsWith("/") || source.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(source)) return false;
  // No segment may climb out of the root, whichever separator the platform accepts.
  return !source.split(/[\\/]/).some((part) => part === "..");
}

/**
 * Validates an action body before anything runs. The codes are stable and short: the UI shows them,
 * and the tests match them, never the message.
 */
export function validateAction(body: unknown): ValidAction | InvalidAction {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, code: "INVALID_ACTION" };
  const input = body as Record<string, unknown>;
  const allowed = new Set(["action", "brick", "source"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false, code: "UNEXPECTED_FIELD" };

  const action = input.action;
  if (typeof action !== "string" || !ACTION_NAMES.includes(action as ActionName)) return { ok: false, code: "INVALID_ACTION" };
  const name = action as ActionName;
  const brick = input.brick;
  const source = input.source;
  const hasBrick = brick !== undefined;
  const hasSource = source !== undefined;

  if (name === "up") return hasBrick || hasSource ? { ok: false, code: "UNEXPECTED_FIELD" } : { ok: true, input: { action: name } };
  if (name === "add") {
    if (hasBrick) return { ok: false, code: "UNEXPECTED_FIELD" };
    return validSource(source) ? { ok: true, input: { action: name, source } } : { ok: false, code: "INVALID_SOURCE" };
  }
  if (hasSource) return { ok: false, code: "UNEXPECTED_FIELD" };
  return typeof brick === "string" && BRICK_NAME.test(brick)
    ? { ok: true, input: { action: name, brick } }
    : { ok: false, code: "INVALID_BRICK" };
}

const KEEP_ACTIONS = 50;
const KEEP_LINES = 2000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface RunnerOptions {
  root: string;
  runtime: Runtime;
  k8s?: K8sTarget;
  /** Tests point the runner at a fake CLI; the real one is the built bin run by this node. */
  cli?: { cmd: string; args: string[] };
  /** How long an action may run before SIGKILL; tests may shorten it. */
  timeoutMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Runs one action at a time as the CLI itself, in a child process. The platform lock (D16) is still
 * the last word against a terminal command; the runner only serialises what this admin accepts.
 */
export class ActionRunner {
  private readonly actions = new Map<string, ActionRecord>();
  private runningId: string | null = null;

  constructor(private readonly o: RunnerOptions) {}

  get running(): string | null {
    return this.runningId;
  }

  list(): ActionRecord[] {
    return [...this.actions.values()].reverse();
  }

  get(id: string): ActionRecord | undefined {
    return this.actions.get(id);
  }

  start(actor: Actor, input: ActionInput): { ok: true; id: string } | { ok: false; code: "BUSY"; running: string } {
    if (this.runningId) return { ok: false, code: "BUSY", running: this.runningId };
    const id = randomBytes(12).toString("base64url");
    const record: ActionRecord = {
      id,
      action: input.action,
      ...(input.brick !== undefined ? { brick: input.brick } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      user: actor.sub && actor.sub !== actor.name ? `${actor.name} (${actor.sub})` : actor.name,
      role: actor.role,
      state: "running",
      exitCode: null,
      output: [],
      issues: [],
      startedAt: this.now().toISOString(),
      finishedAt: null,
    };
    this.actions.set(id, record);
    this.runningId = id;
    for (const key of this.actions.keys()) {
      if (this.actions.size <= KEEP_ACTIONS) break;
      if (key !== this.runningId) this.actions.delete(key);
    }
    // The first line says the request was accepted; the second carries the outcome.
    this.audit(record, "Accepted", `accepted (id ${id})`);
    this.exec(record);
    return { ok: true, id };
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private argv(record: ActionRecord): string[] {
    if (record.action === "add") return ["add", record.source ?? ""];
    if (record.action === "up") {
      const args = ["up", "--runtime", this.o.runtime];
      if (this.o.runtime === "k8s") {
        if (this.o.k8s?.context) args.push("--context", this.o.k8s.context);
        if (this.o.k8s?.kubeconfig) args.push("--kubeconfig", this.o.k8s.kubeconfig);
        if (this.o.k8s?.allowContext) args.push("--allow-context", this.o.k8s.allowContext);
      }
      return args;
    }
    return [record.action, record.brick ?? ""];
  }

  private exec(record: ActionRecord): void {
    const cmd = this.o.cli?.cmd ?? process.execPath;
    const base = this.o.cli?.args ?? [fileURLToPath(new URL("../bin.js", import.meta.url))];
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PLUGBRICKS_OIDC_CLIENT_SECRET;

    let pending = "";
    const line = (text: string) => {
      record.output.push(text);
      if (record.output.length > KEEP_LINES) record.output.splice(0, record.output.length - KEEP_LINES);
      const match = /^error ([A-Z][A-Z0-9_]+)/.exec(text.trim());
      if (match && !record.issues.includes(match[1])) record.issues.push(match[1]);
    };
    const chunk = (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const l of lines) line(l);
    };
    const finish = (code: number | null, extra?: string) => {
      if (record.finishedAt) return;
      if (extra) line(extra);
      if (pending) {
        line(pending);
        pending = "";
      }
      record.finishedAt = this.now().toISOString();
      record.exitCode = code;
      record.state = code === 0 ? "succeeded" : "failed";
      if (this.runningId === record.id) this.runningId = null;
      const duration = Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt));
      const refused = (code === 1 || code === 2) && record.issues.length > 0;
      const result = code === 0 ? "Success" : refused ? "Refused" : "Failed";
      const issues = record.issues.length ? `; ${record.issues.join(", ")}` : "";
      this.audit(record, result, `finished in ${duration}ms (exit ${code ?? "unknown"}${issues}; id ${record.id})`);
    };

    let timer: NodeJS.Timeout | undefined;
    try {
      const child = spawn(cmd, [...base, ...this.argv(record)], {
        cwd: this.o.root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (text: string) => chunk(text));
      child.stderr?.on("data", (text: string) => chunk(text));
      child.on("error", (e: Error) => {
        if (timer) clearTimeout(timer);
        finish(null, `failed to start the CLI: ${e.message}`);
      });
      child.on("close", (code: number | null) => {
        if (timer) clearTimeout(timer);
        finish(code);
      });
      timer = setTimeout(() => {
        line(`timed out after ${Math.round((this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} minutes; killed`);
        child.kill("SIGKILL");
      }, this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
    } catch (e) {
      finish(null, `failed to start the CLI: ${(e as Error).message}`);
    }
  }

  private audit(record: ActionRecord, result: "Accepted" | "Success" | "Refused" | "Failed", details: string): void {
    try {
      const dir = join(this.o.root, ".admin");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ignore = join(dir, ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n", { mode: 0o600 });
      appendFileSync(
        join(dir, "audit.log"),
        `${JSON.stringify({
          time: this.now().toISOString(),
          user: record.user,
          role: record.role,
          action: record.action,
          brick: record.brick ?? record.source ?? "",
          result,
          details,
        })}\n`,
        { mode: 0o600 },
      );
    } catch (e) {
      this.o.log?.(`admin: cannot write the audit log: ${(e as Error).message}`);
    }
  }
}
