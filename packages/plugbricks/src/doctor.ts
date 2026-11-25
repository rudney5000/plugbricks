// "plugbricks doctor" (D31): checks what `up` needs and says what to fix, before `up` fails with a Docker or kubectl
// error. Read-only: it writes nothing, starts nothing, and takes no platform lock; every external call is a query.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PlugbricksError, readProject, BRICKS_DIR, isBrickEnabled, type Project } from "./platform.js";
import { defaultExec, k8sTargetFlags, type Exec, type K8sTarget, type Runtime } from "./runtime.js";
import { isRestrictedToCurrentUser, type RestrictOptions } from "./secrets.js";
import { formatMessage } from "./messages.js";
import { PLATFORM_DEFAULTS } from "./schemas.js";

export type CheckState = "ok" | "warning" | "problem";

export interface Check {
  /** Stable identifier of what is checked: tools match on it, never on the text. */
  id: "node" | "platform" | "secrets" | "docker" | "compose" | "ports" | "project-name" | "images" | "kubectl" | "context" | "cluster";
  state: CheckState;
  detail: string;
  /** What to do, for a warning or a problem. */
  fix?: string;
}

export interface DoctorDeps {
  exec?: Exec;
  /** Whether a TCP port of 127.0.0.1 is free; tests pass their own. */
  portFree?: (port: number) => boolean;
  /** The Node version to check; tests pass their own. */
  nodeVersion?: string;
  k8s?: K8sTarget;
  restrict?: RestrictOptions;
}

const ok = (id: Check["id"], detail: string): Check => ({ id, state: "ok", detail });
const warning = (id: Check["id"], detail: string, fix: string): Check => ({ id, state: "warning", detail, fix });
const problem = (id: Check["id"], detail: string, fix: string): Check => ({ id, state: "problem", detail, fix });

/** Free when a server can listen on it; asked in a child process, since the CLI is synchronous. */
function defaultPortFree(port: number): boolean {
  const script = `require("net").createServer().once("error", () => process.exit(1)).listen(${port}, "127.0.0.1", () => process.exit(0));`;
  return spawnSync(process.execPath, ["-e", script], { timeout: 5000 }).status === 0;
}

/** `>=22.12.0` against `22.23.5`; true when the range has another form, which this check does not read. */
export function satisfiesMinimum(version: string, range: string): boolean {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const v = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!min || !v) return true;
  for (let i = 1; i <= 3; i++) {
    if (Number(v[i]) !== Number(min[i])) return Number(v[i]) > Number(min[i]);
  }
  return true;
}

function nodeCheck(version: string): Check {
  const engines = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines?.node as string | undefined;
  if (!engines) return ok("node", `Node ${version}`);
  return satisfiesMinimum(version, engines)
    ? ok("node", `Node ${version} (plugbricks needs ${engines})`)
    : problem("node", `Node ${version}, and plugbricks needs ${engines}`, `install Node ${engines.replace(/^>=\s*/, "")} or later`);
}

/** The images of the enabled bricks, with the brick that names them. */
function imagesOf(project: Project): { brick: string; image: string }[] {
  const out: { brick: string; image: string }[] = [];
  for (const brick of Object.keys(project.lock.bricks).sort()) {
    if (!isBrickEnabled(project.platform, brick)) continue;
    const file = join(project.root, BRICKS_DIR, brick, "plugin.json");
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf8")) as { services: { image: string }[] };
    for (const s of m.services) out.push({ brick, image: s.image });
  }
  return out;
}

/** The command `create` printed for a brick whose code is in services/<brick> (D28), or undefined. */
function buildCommand(project: Project, brick: string, image: string): string | undefined {
  if (!existsSync(join(project.root, "services", brick, "Dockerfile"))) return undefined;
  return `docker build -t ${image} -f services/${brick}/Dockerfile .`;
}

function composeChecks(project: Project | undefined, exec: Exec, root: string, portFree: (port: number) => boolean): Check[] {
  const checks: Check[] = [];
  const run = (args: string[]) => exec("docker", args, { cwd: root, timeoutMs: 15_000 });

  const server = run(["version", "--format", "{{.Server.Version}} {{.Server.Os}}"]);
  if (server.error) {
    return [problem("docker", "the docker command was not found", "install Docker (Docker Engine or Docker Desktop)")];
  }
  if (server.status !== 0) {
    const why = (server.stderr || server.stdout).trim().split("\n")[0] ?? "";
    return [
      problem(
        "docker",
        `Docker does not answer${why ? `: ${why}` : ""}`,
        "start Docker; on Linux, a user outside the docker group needs to be added to it (then log in again)",
      ),
    ];
  }
  const [version, os] = server.stdout.trim().split(" ");
  if (os !== "linux") {
    checks.push(problem("docker", `Docker ${version} runs ${os} containers`, "switch Docker to Linux containers"));
    return checks;
  }
  checks.push(ok("docker", `Docker ${version}, Linux containers`));

  const compose = run(["compose", "version", "--short"]);
  if (compose.error || compose.status !== 0) {
    checks.push(problem("compose", "the Docker Compose v2 plugin is missing (docker compose)", "install the Compose plugin of Docker"));
    return checks;
  }
  checks.push(ok("compose", `Docker Compose ${compose.stdout.trim()}`));
  if (!project) return checks;

  // Another platform with the same name shares the Compose project: its containers and its volumes (D31).
  const here = resolve(project.root, ".generated/compose");
  const dirs = run([
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project.platform.name}`,
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  const others = [...new Set(dirs.stdout.split("\n").map((d) => d.trim()))].filter((d) => d && resolve(d) !== here);
  checks.push(
    others.length
      ? problem(
          "project-name",
          `another platform named "${project.platform.name}" has containers on this machine, from ${others
            .map((d) => d.replace(/[\\/]\.generated[\\/]compose$/, ""))
            .join(", ")}`,
          `rename one of them (the "name" of platform.json), or stop the other one first with "plugbricks down" in its folder`,
        )
      : ok("project-name", `no other platform named "${project.platform.name}" on this machine`),
  );

  // The ports this platform publishes: free, or held by this platform when it is already up.
  const ours = run(["ps", "--filter", `label=com.docker.compose.project=${project.platform.name}`, "--format", "{{.Ports}}"]).stdout;
  const ports: { port: number; field: string }[] = [];
  if (project.lock.federation) ports.push({ port: project.platform.router?.port ?? PLATFORM_DEFAULTS.routerPort, field: "router.port" });
  for (const [brick, b] of Object.entries(project.platform.bricks)) {
    if (b.webPort !== undefined && isBrickEnabled(project.platform, brick))
      ports.push({ port: b.webPort, field: `bricks.${brick}.webPort` });
  }
  const busy = ports.filter(({ port }) => !portFree(port) && !(others.length === 0 && ours.includes(`127.0.0.1:${port}->`)));
  checks.push(
    busy.length
      ? problem(
          "ports",
          busy.map(({ port, field }) => `port ${port} (${field}) is used by another program`).join("; "),
          "change the port in platform.json, or stop what listens on it",
        )
      : ok(
          "ports",
          ports.length ? `ports ${ports.map((p) => p.port).join(", ")} free, or used by this platform` : "this platform publishes no port",
        ),
  );

  // Images: on the machine, or pulled by up. One that create wrote the code of and that is not built yet is a warning.
  const images = imagesOf(project);
  const missing = images.filter(({ image }) => run(["image", "inspect", "--format", "{{.Id}}", image]).status !== 0);
  const unbuilt = missing.flatMap(({ brick, image }) => {
    const command = buildCommand(project, brick, image);
    return command ? [{ image, command }] : [];
  });
  if (unbuilt.length) {
    checks.push(
      warning(
        "images",
        `${unbuilt.map((u) => u.image).join(", ")} ${unbuilt.length === 1 ? "is" : "are"} not built on this machine, and up would try to pull ${unbuilt.length === 1 ? "it" : "them"}`,
        unbuilt.map((u) => u.command).join("; then "),
      ),
    );
  } else {
    const pulled = missing.length;
    const here = images.length - pulled;
    checks.push(ok("images", `${here} image${here === 1 ? "" : "s"} on this machine${pulled ? `, ${pulled} to be pulled by up` : ""}`));
  }
  return checks;
}

function k8sChecks(project: Project | undefined, exec: Exec, root: string, target: K8sTarget | undefined): Check[] {
  const client = exec("kubectl", ["version", "--client"], { cwd: root, timeoutMs: 15_000 });
  if (client.error || client.status !== 0) return [problem("kubectl", "the kubectl command was not found", "install kubectl")];
  const checks: Check[] = [ok("kubectl", "kubectl is installed")];

  let flags: string[];
  try {
    flags = k8sTargetFlags(target);
  } catch (e) {
    if (!(e instanceof PlugbricksError)) throw e;
    const i = e.issues[0];
    checks.push(problem("context", formatMessage(i.code, i.params), "name the cluster with --context <name> (and --kubeconfig <file>)"));
    return checks;
  }
  const config = target?.kubeconfig !== undefined ? ["--kubeconfig", target.kubeconfig] : [];
  const contexts = exec("kubectl", [...config, "config", "get-contexts", "--output", "name"], { cwd: root, timeoutMs: 15_000 });
  if (
    !contexts.stdout
      .split("\n")
      .map((c) => c.trim())
      .includes(target!.context!)
  ) {
    checks.push(
      problem("context", `the kubeconfig has no context "${target!.context}"`, "list the contexts with: kubectl config get-contexts"),
    );
    return checks;
  }
  checks.push(ok("context", `context "${target!.context}"`));

  const ready = exec("kubectl", [...flags, "get", "--raw", "/readyz", "--request-timeout=10s"], { cwd: root, timeoutMs: 20_000 });
  if (ready.status !== 0) {
    const why = (ready.stderr || ready.stdout).trim().split("\n")[0] ?? "";
    checks.push(problem("cluster", `the cluster does not answer${why ? `: ${why}` : ""}`, "start the cluster, or check the context"));
    return checks;
  }
  checks.push(ok("cluster", "the cluster answers"));

  if (project) {
    // A cluster pulls its images itself: one built on this machine must be imported or pushed (D28).
    const local = imagesOf(project).flatMap(({ brick, image }) => (buildCommand(project, brick, image) ? [image] : []));
    if (local.length) {
      checks.push(
        warning(
          "images",
          `${local.join(", ")} ${local.length === 1 ? "is" : "are"} built from services/: the cluster must be able to pull ${local.length === 1 ? "it" : "them"}`,
          "import into a local cluster (k3d image import <image> --cluster <name>, kind load docker-image <image>), or push to a registry the cluster reads",
        ),
      );
    }
  }
  return checks;
}

/** Every check, in order; a check that depends on a failed one is left out rather than reported twice. */
export function doctor(root: string, runtime: Runtime, deps: DoctorDeps = {}): Check[] {
  const exec = deps.exec ?? defaultExec;
  const checks: Check[] = [nodeCheck(deps.nodeVersion ?? process.versions.node)];

  let project: Project | undefined;
  try {
    project = readProject(root);
    const enabled = Object.keys(project.lock.bricks).filter((b) => isBrickEnabled(project!.platform, b)).length;
    const total = Object.keys(project.lock.bricks).length;
    checks.push(ok("platform", `platform "${project.platform.name}": ${total} brick(s), ${enabled} enabled`));
  } catch (e) {
    if (!(e instanceof PlugbricksError)) throw e;
    const i = e.issues[0];
    const notHere = i.code === "PLATFORM_NOT_INITIALIZED";
    checks.push(
      problem(
        "platform",
        formatMessage(i.code, i.params),
        notHere ? "run doctor in the folder of a platform (or with --dir), or create one: plugbricks init" : "fix the files named above",
      ),
    );
  }

  if (project) {
    const secrets = join(project.root, ".secrets");
    if (!existsSync(secrets)) checks.push(ok("secrets", ".secrets/ does not exist yet: generate and up create it, restricted to you"));
    else {
      const r = isRestrictedToCurrentUser(secrets, deps.restrict);
      checks.push(
        r.ok
          ? ok("secrets", ".secrets/ is readable by you only")
          : problem(
              "secrets",
              `.secrets/ is not restricted to you: ${r.detail}`,
              "restrict it (chmod 700 .secrets on Linux and macOS); up refuses to write a secret until then",
            ),
      );
    }
  }

  const portFree = deps.portFree ?? defaultPortFree;
  checks.push(...(runtime === "k8s" ? k8sChecks(project, exec, root, deps.k8s) : composeChecks(project, exec, root, portFree)));
  return checks;
}
