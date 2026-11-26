// "plugbricks export" (D34): what leaves the project, and what must not. The golden scenarios (test/fixtures/cli/export-*)
// cover the commands and the refusals; this covers the content of the files. The exported Compose file is also read by the
// real `docker compose config` when Docker is there, and by hand (D34, "Tested").
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { imagesOf } from "../src/export.js";
import { planProject } from "../src/plan.js";
import { readProject } from "../src/platform.js";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkg, ".test-work/export");
const root = join(work, "demo");
const posix = process.platform !== "win32";

const cli = (args: string[]) => {
  const err: string[] = [];
  const out: string[] = [];
  const code = main(args, { cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
};
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Every file under dir, relative, with "/". */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, r) : [r];
  });
}

beforeEach(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "examples/postgres"), join(root, "bricks/postgres"), { recursive: true });
  expect(cli(["init", "--name", "demo"]).code).toBe(0);
  expect(cli(["add", "postgres"]).code).toBe(0);
  // An API that requires a database: its provision scripts have to leave with the Compose file.
  cpSync(join(pkg, "examples/orders-api"), join(root, "bricks/orders-api"), { recursive: true });
  expect(cli(["add", "orders-api"]).code).toBe(0);
});

describe("export, Docker Compose", () => {
  it("is read-only for the platform: no secret is created, no file of the project changes", () => {
    const before = filesUnder(root).sort();
    const lock = read("platform.lock");
    expect(cli(["export", "out"]).code).toBe(0);
    expect(existsSync(join(root, ".secrets"))).toBe(false);
    expect(existsSync(join(root, ".generated"))).toBe(false);
    expect(read("platform.lock")).toBe(lock);
    expect(
      filesUnder(root)
        .filter((f) => !f.startsWith("out/"))
        .sort(),
    ).toEqual(before);
  });

  it("writes a file that needs nothing of the project: no path out of its folder, no plugbricks command to run", () => {
    expect(cli(["export", "out"]).code).toBe(0);
    const compose = read("out/compose.yaml");
    expect(compose).not.toContain("../");
    expect(compose).not.toContain(".generated");
    expect(compose).not.toContain(".platform");
    expect(compose).not.toContain("run plugbricks");
    expect(compose).toContain("./scripts/postgres-database-scripts");
    expect(compose).toContain("./router-config.json");
    // Not "Generated ... Do not edit": the copy is the reader's.
    expect(compose).not.toContain("Do not edit");
    expect(read("out/README.md")).toContain("docker compose up -d");
  });

  it("keeps the mode of a provision script, which a read-only mount needs to run", () => {
    if (!posix) return;
    expect(cli(["export", "out"]).code).toBe(0);
    const script = "scripts/postgres-database-scripts/create-database.sh";
    const installed = join(root, ".platform/bricks/postgres/provision/create-database.sh");
    expect(statSync(join(root, "out", script)).mode & 0o777).toBe(statSync(installed).mode & 0o777);
  });

  it("copies the provision scripts byte for byte", () => {
    expect(cli(["export", "out"]).code).toBe(0);
    const rel = "scripts/postgres-database-scripts/create-database.sh";
    expect(
      readFileSync(join(root, "out", rel)).equals(readFileSync(join(root, ".platform/bricks/postgres/provision/create-database.sh"))),
    ).toBe(true);
  });

  it("holds no secret value unless asked: .env.example names them with nothing after the =", () => {
    expect(cli(["generate"]).code).toBe(0);
    const values = read(".secrets/secrets.env")
      .split("\n")
      .filter((l) => l.startsWith("PB_"))
      .map((l) => l.split("=")[1]);
    expect(values.length).toBeGreaterThan(0);
    expect(cli(["export", "plain"]).code).toBe(0);
    for (const f of filesUnder(join(root, "plain"))) for (const v of values) expect(read(`plain/${f}`), f).not.toContain(v);
    expect(read("plain/.env.example")).toMatch(/^PB_[A-Z0-9_]+=$/m);

    expect(cli(["export", "secret", "--with-secrets"]).code).toBe(0);
    expect(read("secret/.env")).toContain(values[0]);
    // The values are in the .env only, never in the compose file (it reads them from the environment).
    for (const f of filesUnder(join(root, "secret")).filter((f) => f !== ".env"))
      for (const v of values) expect(read(`secret/${f}`), f).not.toContain(v);
    expect(read("secret/.gitignore")).toContain(".env");
    if (posix) expect(statSync(join(root, "secret/.env")).mode & 0o777).toBe(0o600);
  });

  it("does not create a secret when --with-secrets finds one missing", () => {
    expect(cli(["export", "secret", "--with-secrets"]).err.join("\n")).toContain("EXPORT_SECRETS_MISSING");
    expect(existsSync(join(root, ".secrets"))).toBe(false);
    expect(existsSync(join(root, "secret"))).toBe(false);
  });

  it("refuses a secrets file that cannot be read, rather than writing half of it", () => {
    expect(cli(["generate"]).code).toBe(0);
    // A line that is not KEY=value
    writeFileSync(join(root, ".secrets/secrets.env"), `${read(".secrets/secrets.env")}garbage\n`);
    const r = cli(["export", "secret", "--with-secrets"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("SECRETS_FILE_INVALID");
    expect(existsSync(join(root, "secret"))).toBe(false);
  });

  it("lists the images its files name, and the README says so", () => {
    expect(cli(["export", "out"]).code).toBe(0);
    const images = imagesOf(planProject(readProject(root)));
    expect(images.length).toBeGreaterThan(2);
    for (const i of images) {
      expect(read("out/compose.yaml"), i).toContain(i);
      expect(read("out/README.md"), i).toContain(`\`${i}\``);
    }
  });
});

describe("export, Kubernetes", () => {
  it("writes the namespace, the resources and an example Secret that holds no value", () => {
    expect(cli(["generate", "--runtime", "k8s"]).code).toBe(0);
    const values = read(".secrets/secrets.env")
      .split("\n")
      .filter((l) => l.startsWith("PB_"))
      .map((l) => l.split("=")[1]);
    expect(cli(["export", "out", "--runtime", "k8s"]).code).toBe(0);
    expect(filesUnder(join(root, "out")).sort()).toEqual(["README.md", "namespace.yaml", "resources.yaml", "secret.example.yaml"]);
    for (const f of filesUnder(join(root, "out"))) for (const v of values) expect(read(`out/${f}`), f).not.toContain(v);
    expect(read("out/secret.example.yaml")).toContain("CHANGE-ME");
    expect(read("out/resources.yaml")).not.toContain("Do not edit");
    expect(read("out/README.md")).toContain("kubectl apply -f namespace.yaml");
  });

  it("with --with-secrets, the Secret holds the values and a .gitignore keeps it out of git", () => {
    expect(cli(["generate", "--runtime", "k8s"]).code).toBe(0);
    const first = read(".secrets/secrets.env")
      .split("\n")
      .find((l) => l.startsWith("PB_"))!
      .split("=");
    expect(cli(["export", "out", "--runtime", "k8s", "--with-secrets"]).code).toBe(0);
    // The YAML writer quotes a value that starts with a digit (the secrets are random): both forms are the same text.
    expect(read("out/secret.yaml")).toMatch(new RegExp(`^ +${first[0]}: "?${first[1]}"?$`, "m"));
    expect(read("out/.gitignore")).toContain("secret.yaml");
    if (posix) expect(statSync(join(root, "out/secret.yaml")).mode & 0o777).toBe(0o600);
  });
});
