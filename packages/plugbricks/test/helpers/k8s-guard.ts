// Decides whether the Kubernetes end-to-end test may run, and against which cluster. It is the only
// place that reads the environment, so the rule is testable without a cluster.

/** The only context names the test accepts: the ones k3d gives to a throwaway cluster named pbtest-*. */
export const TEST_CONTEXT_PREFIX = "k3d-pbtest-";

export type K8sTestTarget = { ok: true; context: string; kubeconfig: string; cluster: string } | { ok: false; reason: string };

/**
 * PLUGBRICKS_K8S_CONTEXT must start with "k3d-pbtest-" and PLUGBRICKS_K8S_KUBECONFIG must be set:
 * nothing else, however it is spelled, ever reaches a cluster. "platform" and "k3d-platform" fall
 * under this rule like every other name that is not a throwaway test cluster.
 */
export function k8sTestTarget(env: Record<string, string | undefined>): K8sTestTarget {
  const context = env.PLUGBRICKS_K8S_CONTEXT;
  if (!context) return { ok: false, reason: "PLUGBRICKS_K8S_CONTEXT is not set" };
  if (!context.startsWith(TEST_CONTEXT_PREFIX) || context.length === TEST_CONTEXT_PREFIX.length) {
    return { ok: false, reason: `PLUGBRICKS_K8S_CONTEXT "${context}" does not start with "${TEST_CONTEXT_PREFIX}"` };
  }
  const kubeconfig = env.PLUGBRICKS_K8S_KUBECONFIG;
  if (!kubeconfig) return { ok: false, reason: "PLUGBRICKS_K8S_KUBECONFIG is not set" };
  return { ok: true, context, kubeconfig, cluster: context.slice("k3d-".length) };
}
