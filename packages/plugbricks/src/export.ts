import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { exportedScriptsDir, renderCompose } from "./drivers/compose.js";
import { renderK8s, renderK8sSecret, K8S_NAMESPACE_FILE, K8S_RESOURCES_FILE, K8S_SECRET_NAME } from "./drivers/k8s.js";
import { writeFileAtomic } from "./fsutil.js";
import { issue } from "./issues.js";
import { planProject, type Plan } from "./plan.js";
import { PlugbricksError, readProject } from "./platform.js";
import { COMPOSE_ENV_FILE, type Runtime } from "./runtime.js";
import { readSecrets, writePrivateFile } from "./secrets.js";

/** Folders of a project that plugbricks owns and rewrites: an export written there would be lost or leaked. */
const OWN_FOLDERS = [".generated", ".secrets", ".platform"];

/** The value the example Secret of Kubernetes holds, so that applying it unchanged is obviously wrong. */
export const EXAMPLE_SECRET_VALUE = "CHANGE-ME";

export interface ExportResult {
  runtime: Runtime;
  plan: Plan;
  /** The folder written, absolute. */
  dir: string;
  /** Files written, relative to it, with "/". */
  files: string[];
  /** True when the real secret values were written (`--with-secrets`). */
  withSecrets: boolean;
  /** The images the files name: the runtime must be able to pull or find each of them. */
  images: string[];
}

/** Every image the exported files name, without duplicates, sorted. */
export function imagesOf(plan: Plan): string[] {
  const images = new Set<string>();
  for (const s of plan.services) images.add(s.image);
  for (const r of plan.requirements) {
    if (r.wait) images.add(r.wait.image);
    images.add(r.provision.image);
  }
  if (plan.router) {
    images.add(plan.router.image);
    if (plan.router.auth) images.add(plan.router.auth.wait.image);
  }
  return [...images].sort();
}

function checkTarget(root: string, dir: string): void {
  for (const own of OWN_FOLDERS) {
    const rel = relative(join(root, own), dir);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new PlugbricksError([issue("EXPORT_DIR_IN_PLATFORM", "", { dir, folder: own })]);
    }
  }
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)
      throw new PlugbricksError([issue("EXPORT_DIR_NOT_EMPTY", "", { dir })]);
  }
}

/**
 * `plugbricks export <dir>` (D34): writes what `generate` would write, plus what it keeps elsewhere, into a folder of the
 * person's own, usable without plugbricks: `docker compose up -d` there, or `kubectl apply -f` of its manifests.
 *
 * It changes nothing of the platform: no lock, no secret created. Without `withSecrets` the folder holds no secret value,
 * only a file that names them; with it, the values already in .secrets/ are copied to a private file that a `.gitignore`
 * of the folder ignores. The folder must not exist or be empty: an export never overwrites.
 */
export function exportPlatform(root: string, runtime: Runtime, out: string, opts: { withSecrets?: boolean } = {}): ExportResult {
  const project = readProject(root);
  const plan = planProject(project);
  const dir = resolve(out);
  checkTarget(project.root, dir);

  let values = new Map<string, string>();
  if (opts.withSecrets) {
    const read = readSecrets(join(project.root, COMPOSE_ENV_FILE));
    if (!read.ok) throw new PlugbricksError([read.issue]);
    values = read.values;
    const missing = plan.secrets.map((s) => s.env).filter((e) => !values.has(e));
    if (missing.length) throw new PlugbricksError([issue("EXPORT_SECRETS_MISSING", "", { names: missing.join(", ") })]);
  }

  const written: string[] = [];
  const put = (rel: string, content: string, mode = 0o644) => {
    writeFileAtomic(join(dir, rel), content, mode);
    written.push(rel);
  };
  const putPrivate = (rel: string, content: string) => {
    writePrivateFile(join(dir, rel), content);
    written.push(rel);
  };
  mkdirSync(dir, { recursive: true });

  const names = plan.secrets.map((s) => s.env).sort();
  if (runtime === "compose") {
    const files = renderCompose(plan, { exported: true });
    for (const [path, content] of Object.entries(files)) put(path.slice(".generated/compose/".length), content);
    // The provision scripts the file mounts, with the modes of the installed copy: a read-only mount keeps a script runnable.
    for (const sc of plan.scripts) {
      for (const f of sc.files) {
        let mode = 0o644;
        try {
          mode = statSync(join(project.root, sc.hostPath, f.path)).mode & 0o777;
        } catch {
          // the installed copy was read to build the plan; keep the default mode if it cannot be read again
        }
        const rel = `${exportedScriptsDir(sc.name)}/${f.path}`;
        // As bytes, so a binary file is not altered.
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), f.data);
        chmodSync(join(dir, rel), mode);
        written.push(rel);
      }
    }
    if (names.length) {
      if (opts.withSecrets)
        putPrivate(
          ".env",
          ["# Secrets of this platform. Never commit or share this file.", ...names.map((n) => `${n}=${values.get(n)}`), ""].join("\n"),
        );
      else
        put(
          ".env.example",
          ["# Copy to .env and give each secret a value: docker compose reads .env by itself.", ...names.map((n) => `${n}=`), ""].join(
            "\n",
          ),
        );
    }
  } else {
    const files = renderK8s(plan, { exported: true });
    put(K8S_NAMESPACE_FILE.slice(".generated/k8s/".length), files[K8S_NAMESPACE_FILE]);
    put(K8S_RESOURCES_FILE.slice(".generated/k8s/".length), files[K8S_RESOURCES_FILE]);
    if (names.length) {
      if (opts.withSecrets) {
        putPrivate("secret.yaml", renderK8sSecret(plan, values, "# Secrets of this platform. Never commit or share this file.\n"));
      } else {
        const example = new Map(names.map((n) => [n, EXAMPLE_SECRET_VALUE]));
        put(
          "secret.example.yaml",
          renderK8sSecret(
            plan,
            example,
            `# Copy to secret.yaml and replace every ${EXAMPLE_SECRET_VALUE} by a secret value before you apply it.\n`,
          ),
        );
      }
    }
  }
  if (opts.withSecrets && names.length) put(".gitignore", "# Holds secret values.\n.env\nsecret.yaml\n");
  put("README.md", exportReadme(plan, runtime, { withSecrets: !!opts.withSecrets, hasSecrets: names.length > 0 }));
  return { runtime, plan, dir, files: written.sort(), withSecrets: !!opts.withSecrets && names.length > 0, images: imagesOf(plan) };
}

/** The README of the exported folder: what it holds and the commands that run it, without plugbricks. */
export function exportReadme(plan: Plan, runtime: Runtime, o: { withSecrets: boolean; hasSecrets: boolean }): string {
  const images = imagesOf(plan);
  const lines: string[] = [
    `# ${plan.platform}`,
    "",
    "Exported by plugbricks (D34). You do not need plugbricks to run or change what is here, and plugbricks does not read this folder.",
    "",
  ];
  if (runtime === "compose") {
    lines.push("## Run it (Docker Compose)", "");
    if (o.hasSecrets) {
      lines.push(
        o.withSecrets
          ? "`.env` holds the secrets (the folder's `.gitignore` keeps it out of git). Share it as you would a password."
          : "Copy `.env.example` to `.env` and give every secret a value (a long random string of letters and digits): Docker Compose refuses to start with a secret missing.",
        "",
      );
    }
    lines.push(
      "```sh",
      "docker compose up -d",
      "docker compose down        # stop it; the volumes are kept",
      "```",
      "",
      `The router is published on 127.0.0.1 only${plan.router ? ` (port ${plan.router.port})` : ""}: change the \`ports\` of \`compose.yaml\` to open it, and put your own proxy with TLS in front of it.`,
      "",
    );
  } else {
    lines.push("## Run it (Kubernetes)", "");
    const steps = ["kubectl apply -f namespace.yaml"];
    if (o.hasSecrets)
      steps.push(
        o.withSecrets
          ? "kubectl apply -f secret.yaml"
          : "kubectl apply -f secret.yaml        # after copying secret.example.yaml and replacing every " + EXAMPLE_SECRET_VALUE,
      );
    steps.push("kubectl apply -f resources.yaml");
    lines.push(
      `Everything lives in the namespace \`${plan.platform}\`. The secrets are read from the Secret \`${K8S_SECRET_NAME}\`.`,
      "",
      "```sh",
      ...steps,
      "```",
      "",
      "Nothing is exposed outside the cluster: the router is a `ClusterIP` Service. Add your own Ingress, with TLS, in front of it.",
      "",
    );
  }
  lines.push(
    "## What to know",
    "",
    "- The images below must be reachable by your runtime. An image built from a `services/` folder of the project has to be built and pushed to a registry first.",
    runtime === "k8s"
      ? "- The volumes hold the data (databases, queues): back them up as you would any volume. Each volume claim asks for 1Gi; change it before you apply."
      : "- The volumes hold the data (databases, queues): back them up as you would any volume.",
    "- The passwords are yours to rotate. Changing one after the first start does not change the database that was already created with it.",
    "",
    "## Images",
    "",
    ...images.map((i) => `- \`${i}\``),
    "",
  );
  return lines.join("\n");
}
