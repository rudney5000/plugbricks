// The images of the examples that the images workflow builds and publishes (D29): every one comes from an example
// manifest and an apis/ folder with a Dockerfile, under the registry of this repository, pinned to a version.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkImagePin } from "../src/image.js";
import { exampleImages, REGISTRY } from "../scripts/example-images.mjs";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const script = join(pkg, "scripts/example-images.mjs");

describe("the images of the examples (D29)", () => {
  it("lists one image per application example, built from apis/, pinned to a version", () => {
    const images = exampleImages();
    expect(images.map((i) => i.brick)).toEqual([
      "catalog-grpc",
      "keycloak",
      "orders-api",
      "orders-web",
      "queue-consumer",
      "shipping-api",
      "stock-api",
      "stock-rest",
    ]);
    for (const i of images) {
      // The tag is the version of the brick, and the one of the source it is built from: a fix ships as a new version (D29).
      const versionOf = (file: string) => JSON.parse(readFileSync(file, "utf8")).version as string;
      const version = versionOf(join(pkg, "examples", i.brick, "plugin.json"));
      // keycloak is a Dockerfile around the official image: it has no package of its own.
      const source = join(pkg, "../..", i.context, "package.json");
      if (existsSync(source)) expect(versionOf(source), i.brick).toBe(version);
      expect(i.image, i.brick).toBe(`${REGISTRY}${i.context.slice("apis/".length)}:${version}`);
      expect(checkImagePin(i.image).ok, i.image).toBe(true);
    }
  });

  it("leaves no example on an image only this repository can build", () => {
    for (const brick of readdirSync(join(pkg, "examples"))) {
      expect(readFileSync(join(pkg, "examples", brick, "plugin.json"), "utf8"), brick).not.toContain("plugbricks-example/");
    }
  });

  it("prints '<folder> <image>' per line for the workflow", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(exampleImages().map((i) => `${i.context} ${i.image}`));
  });
});
