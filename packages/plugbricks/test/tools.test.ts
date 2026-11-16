import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// tools.json pins the external tools of milestone 3. Nothing is downloaded here: this checks
// that the file is complete and coherent, so a later install step can trust it.
const tools = JSON.parse(readFileSync(new URL("../../../tools.json", import.meta.url), "utf8")).tools;
const PLATFORMS = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64", "windows-arm64"];
const names = Object.keys(tools);

describe("tools.json", () => {
  it("pins the four milestone 3 tools", () => {
    expect(names.sort()).toEqual(["k3d", "kubectl", "score-compose", "score-k8s"]);
  });

  it.each(names)("%s: one entry per OS and architecture, each with version and sha256 (or an explicit reason)", (name) => {
    const t = tools[name];
    expect(t.version).toMatch(/^v?\d+\.\d+\.\d+$/);
    expect(t.checksums).toMatch(/^https:\/\//);
    expect(Object.keys(t.platforms).sort()).toEqual([...PLATFORMS].sort());
    for (const [platform, p] of Object.entries<any>(t.platforms)) {
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
    const all = names.flatMap((n) => Object.values<any>(tools[n].platforms).map((p) => p.sha256).filter(Boolean));
    expect(new Set(all).size).toBe(all.length);
  });

  it("linux-amd64 hashes match the binaries verified and run in experiment D and decision D1", () => {
    expect(tools["score-k8s"].platforms["linux-amd64"].sha256).toBe("36a99aea22b5f87a5e6545854086b6dcb2f8d3cafc7f52e02d4b52ae6d62d944");
    expect(tools["score-compose"].platforms["linux-amd64"].sha256).toBe("7257a7eed0079f92382668ff3ea4abc3158d93bce4b5b2f40b1476d84d313564");
    expect(tools["k3d"].platforms["linux-amd64"].sha256).toBe("06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0");
  });
});
