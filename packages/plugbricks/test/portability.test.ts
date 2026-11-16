import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { brickIntegrity, brickSource, isText, normalizeLineEndings, PlugbricksError, portableRelative } from "../src/platform.js";

// Linux, macOS and Windows must produce the same platform.json and platform.lock.
const pkg = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkg, ".test-work/portability");
const goldenLock = JSON.parse(readFileSync(join(pkg, "test/fixtures/cli/add-provider-then-consumer/expected/platform.lock"), "utf8"));

/** Copies a brick, rewriting every text file with CRLF line endings (what git autocrlf does on Windows). */
function copyAsCrlf(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else writeFileSync(p, readFileSync(p, "utf8").replace(/\r?\n/g, "\r\n"));
    }
  };
  walk(dest);
}

beforeAll(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
});

describe("brick integrity ignores line endings", () => {
  it.each(["postgres", "orders"])("%s: CRLF copy has the same hash as the LF original and as the golden lock", (name) => {
    const lf = join(pkg, "examples", name);
    const crlf = join(work, `${name}-crlf`);
    copyAsCrlf(lf, crlf);
    expect(readFileSync(join(crlf, "plugin.json"), "utf8")).toContain("\r\n");
    expect(brickIntegrity(crlf, name)).toBe(brickIntegrity(lf, name));
    expect(brickIntegrity(lf, name)).toBe(goldenLock.bricks[name].integrity);
  });

  it("isText: valid UTF-8 without control bytes is text; a binary without any NUL byte is not", () => {
    expect(isText(Buffer.from("héllo\r\nworld\n\tok"))).toBe(true);
    expect(isText(Buffer.from([0x30, 0x82, 0x01, 0x0d, 0x0a, 0x02, 0x01, 0x05]))).toBe(false); // control bytes (DER-like)
    expect(isText(Buffer.from([0x41, 0x0d, 0x0a, 0xff, 0xfe]))).toBe(false); // invalid UTF-8
  });

  it("a real content change still changes the hash", () => {
    const changed = join(work, "postgres-changed");
    cpSync(join(pkg, "examples/postgres"), changed, { recursive: true });
    writeFileSync(join(changed, "provision/create-database.sh"), readFileSync(join(changed, "provision/create-database.sh"), "utf8") + "# edit\n");
    expect(brickIntegrity(changed, "postgres")).not.toBe(brickIntegrity(join(pkg, "examples/postgres"), "postgres"));
  });

  it("binary files (a NUL byte) are hashed as is: CRLF bytes inside them are data", () => {
    const a = join(work, "bin-a");
    const b = join(work, "bin-b");
    for (const d of [a, b]) mkdirSync(d, { recursive: true });
    writeFileSync(join(a, "logo.bin"), Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x02]));
    writeFileSync(join(b, "logo.bin"), Buffer.from([0x00, 0x01, 0x0a, 0x02]));
    expect(brickIntegrity(a, "x")).not.toBe(brickIntegrity(b, "x"));
  });

  it("normalizeLineEndings: CRLF becomes LF, a lone CR is kept, binary is untouched", () => {
    expect(normalizeLineEndings(Buffer.from("a\r\nb\r\n")).toString()).toBe("a\nb\n");
    expect(normalizeLineEndings(Buffer.from("a\rb\n")).toString()).toBe("a\rb\n");
    const bin = Buffer.from([0x00, 0x0d, 0x0a]);
    expect(normalizeLineEndings(bin)).toBe(bin);
  });

  it("normalizeLineEndings returns the very same buffer when there is no CR (no copy)", () => {
    const lf = Buffer.from("line one\nline two\n");
    expect(normalizeLineEndings(lf)).toBe(lf);
  });
});

describe("paths are stored with /", () => {
  it.each([
    ["C:\\proj", "C:\\proj\\bricks\\postgres", "bricks/postgres"],
    ["C:\\proj", "C:\\shared\\bricks\\postgres", "../shared/bricks/postgres"],
    ["C:\\proj", "C:\\proj\\services\\orders\\plugin.json", "services/orders/plugin.json"],
  ])("Windows (path.win32): %s -> %s gives %s", (from, to, expected) => {
    expect(portableRelative(from, to, path.win32)).toBe(expected);
  });

  it("Windows (path.win32): a folder on another drive has no relative path", () => {
    expect(portableRelative("C:\\proj", "D:\\bricks\\postgres", path.win32)).toBeUndefined();
  });

  it("Windows (path.win32): a brick on another drive is refused with BRICK_PATH_NOT_PORTABLE", () => {
    let error: unknown;
    try {
      brickSource("C:\\proj", "D:\\bricks\\postgres", "postgres", path.win32);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PlugbricksError);
    expect((error as PlugbricksError).code).toBe("BRICK_PATH_NOT_PORTABLE");
    expect((error as PlugbricksError).issues[0].message).toBe(
      'brick "postgres" cannot be used on every OS: its folder is on another drive (D:) than the platform; copy the brick under the platform folder',
    );
    expect(brickSource("C:\\proj", "C:\\proj\\bricks\\postgres", "postgres", path.win32)).toBe("bricks/postgres");
  });

  it("POSIX (path.posix) keeps /", () => {
    expect(portableRelative("/proj", "/proj/bricks/postgres", path.posix)).toBe("bricks/postgres");
  });

  it.skipIf(process.platform === "win32")(
    "a brick whose path contains a backslash is refused before anything is written (Linux, macOS only: Windows cannot create such a name)",
    () => {
      const project = join(work, "backslash");
      mkdirSync(project, { recursive: true });
      const io = { cwd: project, stdout: () => {}, stderr: (l: string) => errors.push(l) };
      const errors: string[] = [];
      expect(main(["init", "--name", "demo"], io)).toBe(0);
      cpSync(join(pkg, "examples/postgres"), join(project, "my\\bricks"), { recursive: true });
      const before = readFileSync(join(project, "platform.lock"), "utf8");
      expect(main(["add", "my\\bricks"], io)).toBe(1);
      expect(errors.join("\n")).toMatch(/^error BRICK_PATH_NOT_PORTABLE: /m);
      expect(readFileSync(join(project, "platform.lock"), "utf8")).toBe(before);
      expect(readdirSync(join(project, ".platform/bricks"))).toEqual([]);
    },
  );
});

describe("the installed copy is exactly what was hashed", () => {
  const project = join(work, "crlf-project");
  const copy = join(project, ".platform/bricks/postgres");
  const script = join(copy, "provision/create-database.sh");

  beforeAll(() => {
    mkdirSync(project, { recursive: true });
    // A CRLF checkout of the brick, as git autocrlf would produce on Windows.
    copyAsCrlf(join(pkg, "examples/postgres"), join(project, "bricks/postgres"));
    const io = { cwd: project, stdout: () => {}, stderr: () => {} };
    expect(main(["init", "--name", "demo"], io)).toBe(0);
    expect(main(["add", "bricks/postgres"], io)).toBe(0);
  });

  it("the source really had CRLF", () => {
    expect(readFileSync(join(project, "bricks/postgres/provision/create-database.sh"), "utf8")).toContain("\r\n");
  });

  it("every file of the copy in .platform/bricks has LF only, and the lock integrity is the LF one", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));
    for (const f of walk(copy)) expect(readFileSync(f).includes(0x0d), f).toBe(false);
    const lock = JSON.parse(readFileSync(join(project, "platform.lock"), "utf8"));
    expect(lock.bricks.postgres.integrity).toBe(goldenLock.bricks.postgres.integrity);
    expect(brickIntegrity(copy, "postgres")).toBe(lock.bricks.postgres.integrity);
  });

  it.skipIf(process.platform === "win32")("the copied script keeps its executable bit (Linux, macOS)", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  // Without the provider's env the script must stop at its first real check. A CRLF script never
  // gets there: "set -eu\r" is already an error for /bin/sh.
  const reachesFirstCheck = (r: { status: number | null; stderr: string }) =>
    r.status !== 0 && r.stderr.includes("PGHOST is required");

  it.skipIf(process.platform === "win32")("the copied script runs under /bin/sh; the CRLF original does not (Linux, macOS)", () => {
    const env = { PATH: process.env.PATH };
    expect(reachesFirstCheck(spawnSync("/bin/sh", [script], { encoding: "utf8", env }))).toBe(true);
    const original = join(project, "bricks/postgres/provision/create-database.sh");
    expect(reachesFirstCheck(spawnSync("/bin/sh", [original], { encoding: "utf8", env }))).toBe(false);
  });

  const docker = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  const linuxDocker = docker.status === 0 && docker.stdout.trim() === "linux";
  const image = "postgres:16.4-alpine"; // the provision image of examples/postgres
  it.skipIf(!linuxDocker)(
    `the copied script runs under /bin/sh in a Linux container (${image})${linuxDocker ? "" : " (skipped: no Docker daemon with Linux containers)"}`,
    () => {
      const r = spawnSync("docker", ["run", "--rm", "-v", `${join(copy, "provision")}:/provision:ro`, image, "/bin/sh", "/provision/create-database.sh"], {
        encoding: "utf8",
      });
      expect(r.stderr).toContain("PGHOST is required");
      expect(reachesFirstCheck(r)).toBe(true);
    },
    300_000,
  );
});

describe("binary files are copied byte for byte, even without a NUL byte", () => {
  it("a DER-like file containing 0D 0A keeps every byte in .platform/bricks", () => {
    const project = join(work, "binary-project");
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    cpSync(join(pkg, "examples/postgres"), join(project, "bricks/postgres"), { recursive: true });
    const der = Buffer.from([0x30, 0x82, 0x01, 0x0d, 0x0a, 0x02, 0x01, 0x05, 0x0d, 0x0a, 0xa0, 0x03, 0x0d, 0x0a]);
    expect(der.includes(0x00)).toBe(false);
    writeFileSync(join(project, "bricks/postgres/ca.der"), der);
    const io = { cwd: project, stdout: () => {}, stderr: () => {} };
    expect(main(["init", "--name", "demo"], io)).toBe(0);
    expect(main(["add", "bricks/postgres"], io)).toBe(0);
    expect(readFileSync(join(project, ".platform/bricks/postgres/ca.der")).equals(der)).toBe(true);
    expect(main(["status"], io)).toBe(0);
  });
});
