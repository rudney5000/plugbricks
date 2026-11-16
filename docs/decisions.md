# Design decisions

Decisions taken before they are implemented, with the evidence behind them.
Each entry says which milestone implements it. Status: **accepted** = agreed, not built yet.

---

## D1. plugbricks ships its own pinned Score provisioners

- **Status:** accepted, implemented in milestone 3 (drivers).
- **Context:** experiment D showed that the built-in score-k8s `postgres` provisioner runs
  `mirror.gcr.io/postgres:17-alpine`, a floating tag. Our manifests forbid floating tags
  (`IMAGE_FLOATING_TAG`), so a brick delivered by Score would bypass that rule.
- **Decision:** the drivers **generate** the Score provisioners from the manifests of the
  installed bricks (`provides`, `ready`, `provision`, `inject`), into
  `.generated/k8s/provisioners.yaml` and `.generated/compose/provisioners.yaml`. Nothing is
  written by hand. The Score projects are initialised with
  `init --no-default-provisioners --provisioners <generated file>`, so a built-in
  provisioner can never be picked by accident.
- **Consequences:** a test checks that every image in the generated provisioner files
  passes `checkImagePin`. A Score resource type that no installed brick provides fails at
  `generate` time instead of silently using a built-in.

### Evidence: `--no-default-provisioners` in the pinned versions

Checked on 2026-11-16. Every archive was verified against the release `checksums.txt`
before extraction (linux/amd64).

| Tool | Version | sha256 of the archive | Flag in `init --help` | Behaviour |
|---|---|---|---|---|
| score-k8s | 0.23.0 | `36a99aea22b5f87a5e6545854086b6dcb2f8d3cafc7f52e02d4b52ae6d62d944` | yes | no provisioner loaded, `generate` fails |
| score-k8s | 0.22.0 | `d32f190d6278943d85cfecfacdee31146ff56b5fa148d6fe2850da1fa237d2f0` | yes | same |
| score-compose | 0.50.0 | `7257a7eed0079f92382668ff3ea4abc3158d93bce4b5b2f40b1476d84d313564` | yes | same |
| score-compose | 0.49.0 | `4d69d33049c5042e47e432d28f1021aee068c75ab766341e2689cb9b85646c6d` | yes | same |

The help text says only "Disable generation of the default provisioners file", so the
behaviour was checked as well, offline, for each version:

1. `init --no-default-provisioners --no-sample`: exit 0, `.score-k8s/` (or `.score-compose/`)
   holds only `state.yaml` (plus `mounts/` for score-compose), no `zz-default.provisioners.yaml`.
2. `provisioners list`: 0 rows. No provisioner is compiled into the binary.
3. `generate` of a workload with a `postgres` resource fails, exit 1:
   - score-k8s: `resource 'postgres.default#client.db' is not supported by any provisioner`
   - score-compose: `failed to provision: resource 'postgres.default#client.db' is not supported by any provisioner`

Proposed pins for milestone 3: **score-k8s 0.23.0** (validated end to end in experiment D)
and **score-compose 0.50.0** (released the same day). score-k8s 0.22.0 and 0.23.0 generated
identical manifests for the experiment D scenario; score-compose has not been run end to
end yet.

---

## D2. The wait patch depends on one score-k8s annotation only, guarded by a contract test

- **Status:** accepted, implemented in milestone 3 (Kubernetes driver).
- **Context:** the experiment D patch template finds the consumer Deployment through
  `k8s.score.dev/workload-name` (set by score-k8s itself on the Deployment) and the
  provider Service through `k8s.score.dev/source-workload` (set by the built-in
  provisioner template). If score-k8s renames either, the patch silently stops matching:
  no initContainer, and the consumer fails at start exactly as without the patch.
- **Decision:**
  - Because of D1 the provider manifests come from **our** provisioners, so the
    provider-side link uses our own key: `plugbricks/consumer: <workload name>`. It has no
    domain prefix because we do not own a domain. `plugbricks` is a valid annotation
    prefix (a single DNS label); this was not checked against a cluster yet.
  - The only remaining score-k8s dependency is `k8s.score.dev/workload-name` on the
    Deployment.
  - A contract test, `test/contract/score-k8s.test.ts`, runs the pinned score-k8s binary
    (version and sha256 in a single `tools.json`) with `generate` on a fixture workload
    that consumes `database`. No cluster is needed. It asserts:
    1. the Deployment carries `k8s.score.dev/workload-name` with the workload name;
    2. the wait patch adds exactly one initContainer, targeting the provider Service.
  - Locally the test is skipped when the binary is absent. When `CI` is set and the binary
    is missing, the test **fails**, so it can never pass silently.
- **Consequences:** bumping score-k8s in `tools.json` reruns the contract test before
  anything else uses the new version.

---

## D3. A volume is deleted only when it is listed, and only with --prune-volumes

- **Status:** accepted. The lock side is implemented (milestone 2); the driver side comes
  with milestone 3.
- **Context:** the first version of `remove` dropped volumes with `retention: delete` from
  the lock and relied on the driver to delete "whatever is no longer in the lock". Deleting
  by absence is unsafe: a hand-edited lock, a lock from another branch, a failed write or a
  volume created outside plugbricks would all look like "absent", and the data would be gone.
- **Decision:**
  - `platform.lock` has two explicit lists, both required by its schema:
    - `retainedVolumes`: volumes of removed bricks with `retention: retain`. Never deleted.
    - `pendingDeletion`: volumes of removed bricks with `retention: delete`.
  - `plugbricks remove` writes these lists. Adding the brick back removes its entries from both:
    a retained volume is re-attached, a pending deletion is cancelled.
  - A driver deletes **only** the volumes in `pendingDeletion`, and **only** when run with an
    explicit flag: `plugbricks up --prune-volumes` (milestone 3). Without the flag, nothing is
    deleted and the pending list stays as it is. After a successful deletion the driver removes
    the entry from `pendingDeletion`.
  - A volume that is in neither list is **never** deleted, whatever the runtime contains.
  - The drivers get the list from `volumesToPrune(lock)` (in `src/platform.ts`), never by
    comparing the runtime with the lock.
  - `plugbricks` refuses a lock where the two lists contradict each other or the installed
    bricks (`LOCK_INCONSISTENT`): a volume both retained and pending deletion, or a volume of
    an installed brick in either list. Such a lock could make a driver delete live data.
- **Tests (scenarios in `test/fixtures/cli/`):** `remove-deletes-volume`,
  `remove-retains-volume`, `remove-then-add-reattaches`, `remove-then-add-cancels-deletion`,
  `volume-in-no-list-is-kept`, `installed-delete-volume-not-pruned`,
  `lock-inconsistent-pending-installed`, `lock-inconsistent-both-lists`. Each checks what
  `volumesToPrune` would return.

---

## D4. Linux, macOS and Windows behave the same

- **Status:** accepted, implemented before milestone 3. CI runs `npm ci`, `npm run typecheck` and
  `npm test` on `ubuntu-latest`, `macos-latest` and `windows-latest` with the exact Node version
  in `.node-version` (`.github/workflows/ci.yml`, actions pinned by commit SHA).
- **Line endings.** `.gitattributes` checks out every text file with LF on every OS (bricks,
  fixtures, the create template, shell scripts). Independently of git, brick integrity is
  computed after turning CRLF into LF in text files (no NUL byte in the first 8000 bytes, the
  git heuristic); binary files are hashed as is. A brick copied with CRLF therefore has the same
  `integrity` as with LF, and `status` stays clean. CI also fails if any tracked file is checked
  out with CRLF. Generated projects get the same `.gitattributes`.
- **Paths.** Every path stored in `platform.json` and `platform.lock` uses `/`, computed with the
  running OS's path rules and joined with `path.posix.sep` (`portableRelative`). A brick whose
  path, or one of whose file names, contains a backslash is refused with
  `BRICK_PATH_NOT_PORTABLE` (legal on Linux and macOS, a separator on Windows). The scenario
  tests fail if a backslash appears in either file.
- **`.secrets/` permissions.**
  - Linux, macOS: `chmod 700`, then `stat` to confirm the mode is exactly 700.
  - Windows: POSIX modes do not exist (Node's `chmod` only toggles read-only), so
    `npm create plugbricks` sets an ACL with
    `icacls .secrets /inheritance:r /grant:r <DOMAIN\user>:(OI)(CI)F`, then reads the ACL back
    with `icacls .secrets` and checks that no entry is inherited and no other account is listed.
  - If any step fails, on any OS, the generator prints
    `warning SECRETS_NOT_RESTRICTED: …` with the reason and still creates the project (exit 0):
    the folder is empty at that point. Nothing fails silently.
  - Milestone 3 (writing secrets) must run the same check and **refuse** to write a secret into a
    `.secrets/` that is not restricted, with the same code.
- **Symbolic links.** Creating one needs Developer Mode or administrator rights on Windows. The
  scenario that checks that bricks with symlinks are refused declares `"needs": ["symlinks"]`;
  the runner probes once whether a symlink can be created and, if not, skips that scenario with
  the reason in its title. It never fails or passes silently. The test helpers link
  `node_modules` with a junction on Windows, which needs no privilege.
- **Running npm and tar in tests.** npm is run as `node <npm-cli.js>` (on Windows `npm` is a `.cmd`
  file, which Node no longer spawns without a shell), and `npm pack` tarballs are extracted in
  JavaScript (the `tar` found first on Windows runners may be GNU tar from Git, which reads
  `C:\…` as a remote host).
- **Tools.** `tools.json` pins score-k8s 0.23.0, score-compose 0.50.0, k3d v5.9.0 and kubectl
  v1.37.2 for linux, darwin and windows on amd64 and arm64, each entry with its version and the
  sha256 from the official release checksum file. score-k8s, score-compose and k3d publish no
  windows/arm64 build: those entries say so explicitly (`available: false` and a reason). The
  checksum files were fetched over HTTPS from the official release pages; their sigstore
  signatures (published for score-k8s and score-compose) were not verified.

---

## Already applied (milestone 2)

Points 1 to 3 of experiment D are in the manifest schema:

- `requires.<capability>.timeoutSeconds` (default 120, maximum 900). On expiry: Compose
  driver fails with `WAIT_TIMEOUT`; on Kubernetes the initContainer exits non-zero, the
  pod ends in `Init:Error` / `CrashLoopBackOff`, and `plugbricks status` maps that to
  `WAIT_TIMEOUT`.
- `provides.<capability>.ready` (required): an exec array that must target
  `${provider.host}` (`READY_NOT_TARGETING_PROVIDER` otherwise).
- `healthcheck.timeoutSeconds` (default 3) and `healthcheck.startPeriodSeconds` (default 0),
  so one manifest behaves the same on both engines.
