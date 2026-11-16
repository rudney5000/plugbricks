import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { brickIntegrity, normalizeLineEndings, portableRelative } from "../src/platform.js";

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
});

describe("paths are stored with /", () => {
  it.each([
    ["C:\\proj", "C:\\proj\\bricks\\postgres", "bricks/postgres"],
    ["C:\\proj", "C:\\shared\\bricks\\postgres", "../shared/bricks/postgres"],
    ["C:\\proj", "C:\\proj\\services\\orders\\plugin.json", "services/orders/plugin.json"],
  ])("Windows (path.win32): %s -> %s gives %s", (from, to, expected) => {
    expect(portableRelative(from, to, path.win32)).toBe(expected);
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
