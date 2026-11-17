import { describe, expect, it } from "vitest";
import { k8sTestTarget } from "./helpers/k8s-guard.js";

// The Kubernetes end-to-end test deletes namespaces and volumes. This pins which clusters it may touch.
describe("k8sTestTarget", () => {
  const kubeconfig = "/tmp/kube.yaml";

  it.each(["platform", "k3d-platform", "docker-desktop", "minikube", "k3d-pbtest", "k3d-pbtest-", "my-k3d-pbtest-x", "K3D-PBTEST-X", " k3d-pbtest-x", "pbtest-local"])(
    "skips the context %j and says why",
    (context) => {
      const t = k8sTestTarget({ PLUGBRICKS_K8S_CONTEXT: context, PLUGBRICKS_K8S_KUBECONFIG: kubeconfig });
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.reason).toBe(`PLUGBRICKS_K8S_CONTEXT "${context}" does not start with "k3d-pbtest-"`);
    },
  );

  it("skips when the context is not set, even if a kubeconfig is", () => {
    expect(k8sTestTarget({ PLUGBRICKS_K8S_KUBECONFIG: kubeconfig })).toEqual({ ok: false, reason: "PLUGBRICKS_K8S_CONTEXT is not set" });
    expect(k8sTestTarget({ PLUGBRICKS_K8S_CONTEXT: "", PLUGBRICKS_K8S_KUBECONFIG: kubeconfig })).toEqual({
      ok: false,
      reason: "PLUGBRICKS_K8S_CONTEXT is not set",
    });
  });

  it("skips when the kubeconfig is not set: the current kubeconfig is never used", () => {
    expect(k8sTestTarget({ PLUGBRICKS_K8S_CONTEXT: "k3d-pbtest-ci" })).toEqual({ ok: false, reason: "PLUGBRICKS_K8S_KUBECONFIG is not set" });
  });

  it("accepts a k3d-pbtest-* context with a kubeconfig, and derives the k3d cluster name", () => {
    expect(k8sTestTarget({ PLUGBRICKS_K8S_CONTEXT: "k3d-pbtest-local", PLUGBRICKS_K8S_KUBECONFIG: kubeconfig })).toEqual({
      ok: true,
      context: "k3d-pbtest-local",
      kubeconfig,
      cluster: "pbtest-local",
    });
  });
});
