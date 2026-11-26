// "plugbricks dev <brick>" (D37): the loop of a person who writes a service. Rebuilds the image of one brick from
// services/<brick>, takes the new contract of its subgraph, and restarts that service alone (and the router when the
// contract changed) in a platform that is already up. Docker Compose only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeContainer, defaultAttach, resolveTarget, type AttachDeps } from "./attach.js";
import { ROUTER_NAME } from "./drivers/common.js";
import { SERVICE_FOLDER } from "./create.js";
import { issue } from "./issues.js";
import { BRICKS_DIR, contractRefresh, PlugbricksError, readProject } from "./platform.js";
import { composeBase, defaultExec, generate, type RuntimeDeps } from "./runtime.js";

/** How long the restarted service may take to be healthy. */
export const DEV_WAIT_SECONDS = 120;

export interface DevResult {
  image: string;
  /** The Compose service restarted. */
  service: string;
  /** The contract files taken from the brick's folder; none when only the code changed. */
  changed: string[];
  /** The services recreated: the brick's, and the router when its contract changed. */
  restarted: string[];
}

const fail = (code: Parameters<typeof issue>[0], params: Record<string, string>): never => {
  throw new PlugbricksError([issue(code, "", params)]);
};

/**
 * One turn of the loop. Everything that can be refused is checked first, the composition of the new schema included; the
 * installed copy and the platform change only once the image is built. Changes the platform: the caller holds its lock.
 */
export function devRebuild(root: string, brick: string, opts: { service?: string }, deps: RuntimeDeps & AttachDeps = {}): DevResult {
  const project = readProject(root);
  if (!Object.hasOwn(project.lock.bricks, brick)) fail("BRICK_NOT_INSTALLED", { name: brick });
  const { platform, root: dir, target } = resolveTarget(root, brick, opts.service);
  const dockerfile = `${SERVICE_FOLDER}/${brick}/Dockerfile`;
  if (!existsSync(join(dir, dockerfile))) fail("DEV_NO_SOURCE", { brick });
  const manifest = JSON.parse(readFileSync(join(dir, BRICKS_DIR, brick, "plugin.json"), "utf8")) as {
    services: { name: string; image: string }[];
  };
  const image = manifest.services.find((s) => s.name === target.container)!.image;
  if (image.includes("@")) fail("DEV_IMAGE_BY_DIGEST", { brick, image });
  // The platform is up: the service has a container, running or not.
  composeContainer(deps.exec ?? defaultExec, dir, platform, target.name, false);
  const refresh = contractRefresh(dir, brick);

  const attach = deps.attach ?? defaultAttach;
  deps.log?.(`$ docker build -t ${image} -f ${dockerfile} .`);
  // Attached: the person sees the build as docker shows it.
  const built = attach("docker", ["build", "-t", image, "-f", dockerfile, "."], { cwd: dir });
  if (built !== 0) fail("DEV_BUILD_FAILED", { image, status: String(built) });

  refresh.apply();
  const { plan } = generate(dir, "compose", deps);
  const restarted = [target.name, ...(refresh.changed.length && plan.router ? [ROUTER_NAME] : [])];
  // --no-deps: this service and, when the schema changed, the router; the databases and the others keep running.
  const args = [
    ...composeBase(plan),
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    String(DEV_WAIT_SECONDS),
    ...restarted,
  ];
  deps.log?.(`$ docker ${args.join(" ")}`);
  const started = attach("docker", args, { cwd: dir });
  if (started !== 0) {
    // Why it does not start is in its logs.
    const id = composeContainer(deps.exec ?? defaultExec, dir, platform, target.name, false);
    attach("docker", ["logs", "--tail", "50", id], { cwd: dir });
    fail("DEV_RESTART_FAILED", { name: target.name, brick, status: String(started) });
  }
  return { image, service: target.name, changed: refresh.changed, restarted };
}
