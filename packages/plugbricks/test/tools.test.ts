import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// tools.json pins the external tools of the Kubernetes end-to-end tests. Nothing is downloaded here: this checks
// that the file is complete and coherent, so a later install step can trust it.
const file = JSON.parse(readFileSync(new URL("../../../tools.json", import.meta.url), "utf8"));
const tools = file.tools;
const images = file.images;

interface PlatformEntry {
  version: string;
  available?: boolean;
  reason?: string;
  url?: string;
  sha256?: string;
  binary: string;
}
const PLATFORMS = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64", "windows-arm64"];
const names = Object.keys(tools);

describe("tools.json", () => {
  it("pins k3d and kubectl; Score is no longer used (decision D5)", () => {
    expect(names.sort()).toEqual(["k3d", "kubectl"]);
  });

  it.each(names)("%s: one entry per OS and architecture, each with version and sha256 (or an explicit reason)", (name) => {
    const t = tools[name];
    expect(t.version).toMatch(/^v?\d+\.\d+\.\d+$/);
    expect(t.checksums).toMatch(/^https:\/\//);
    expect(Object.keys(t.platforms).sort()).toEqual([...PLATFORMS].sort());
    for (const [platform, p] of Object.entries<PlatformEntry>(t.platforms)) {
      expect(p.version, `${name} ${platform}`).toBe(t.version);
      if (p.available === false) {
        expect(p.reason, `${name} ${platform}`).toMatch(/\S/);
        expect(p.sha256).toBeUndefined();
        continue;
      }
      expect(p.sha256, `${name} ${platform}`).toMatch(/^[a-f0-9]{64}$/);
      expect(p.url, `${name} ${platform}`).toMatch(/^https:\/\//);
      expect(p.url, `${name} ${platform} url names the version`).toContain(t.version);
      const [os, arch] = platform.split("-");
      expect(p.url, `${name} ${platform} url names the platform`).toMatch(new RegExp(`${os}[_/-]${arch}`));
      expect(p.binary.endsWith(".exe"), `${name} ${platform} binary`).toBe(os === "windows");
    }
  });

  it("no two entries share a sha256", () => {
    const all = names.flatMap((n) =>
      Object.values<PlatformEntry>(tools[n].platforms)
        .map((p) => p.sha256)
        .filter(Boolean),
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it("linux-amd64 hashes match the binaries downloaded and verified on 2026-11-17", () => {
    expect(tools["k3d"].platforms["linux-amd64"].sha256).toBe("06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0");
    expect(tools["kubectl"].platforms["linux-amd64"].sha256).toBe("c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4");
  });

  it("k3s image: pinned by digest, reference spells tag and digest, Kubernetes minor within one of kubectl", () => {
    const k3s = images.k3s;
    expect(k3s.repository).toBe("rancher/k3s");
    expect(k3s.tag).toMatch(/^v\d+\.\d+\.\d+-k3s\d+$/);
    expect(k3s.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(k3s.reference).toBe(`${k3s.repository}:${k3s.tag}@${k3s.digest}`);
    const minor = (v: string) => Number(/^v\d+\.(\d+)\./.exec(v)![1]);
    // kubectl supports a server one minor version older or newer than itself.
    expect(Math.abs(minor(k3s.tag) - minor(tools["kubectl"].version))).toBeLessThanOrEqual(1);
  });

  it("k3s digest is the one the registry returned on 2026-11-17", () => {
    expect(images.k3s.digest).toBe("sha256:21ea6e0fac4e3930c2ce8aa40ddd41a8b18cb3e9a0222c030dc005e7e88c4332");
  });
});
