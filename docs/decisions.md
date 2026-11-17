# Design decisions

Decisions taken before they are implemented, with the evidence behind them.
Each entry says which milestone implements it. Status: **accepted** = agreed, not built yet;
**implemented** = built and tested; **superseded** = replaced by a later decision, kept for its evidence.

---

## D1. plugbricks ships its own pinned Score provisioners

- **Status:** superseded by D5 (milestone 3): the drivers do not use Score at all. The concern
  behind D1 (no floating image tag reaches the runtime) holds, and D5 meets it without Score.
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

- **Status:** superseded by D5 (milestone 3): without score-k8s there is no annotation to depend
  on and no patch; the wait init container is written by the Kubernetes driver itself.
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

- **Status:** implemented. Lock side in milestone 2; driver side in milestone 3
  (`up --prune-volumes`, `confirmPruned`).
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
    explicit flag: `plugbricks up --prune-volumes`. Compose: `docker volume rm <platform>_<volume>`
    (a volume already gone counts as deleted); Kubernetes: `kubectl delete persistentvolumeclaim`.
    A failed deletion is reported as `VOLUME_PRUNE_FAILED` and the entry stays pending. Without the flag, nothing is
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
  computed after turning CRLF into LF in text files; binary files are hashed as is. A file is
  text only when, over its whole length, it is valid UTF-8 and has no control byte other than
  tab, LF, form feed and CR (`isText`). The git heuristic (no NUL in the first 8000 bytes) was
  not enough once the copy is normalized too: a certificate or compressed blob without a NUL
  byte would have lost its `0D 0A` byte pairs. `add` writes the copy in `.platform/bricks/`
  with the same normalization, so the installed copy is exactly what was hashed: a brick added
  from a CRLF checkout gets an LF copy (file modes kept), and its shell scripts run under
  `/bin/sh` in a Linux container. Hashing the normalized content without normalizing the copy
  would have hidden a CRLF script that then fails with `illegal option -^M`. CI also fails if any
  tracked file is checked out with CRLF. Generated projects get the same `.gitattributes`.
- **Paths.** Every path stored in `platform.json` and `platform.lock` uses `/`, computed with the
  running OS's path rules and joined with `path.posix.sep` (`portableRelative`, `brickSource`).
  `add` refuses with `BRICK_PATH_NOT_PORTABLE`, before writing anything, a brick whose folder is
  on another Windows drive than the platform (no relative path exists, and an absolute `D:/…`
  would mean nothing elsewhere), or whose folder name or one of whose file names contains a
  backslash (legal on Linux and macOS, a separator on Windows). The message names the brick and
  the exact folder, file or drive. `status` never stops because of one brick: such a problem in
  an installed brick is reported for that brick, any other error while reading it (`EACCES`,
  `ENOTDIR`, …) is reported as `BRICK_UNREADABLE`, and the other bricks are still checked. The
  scenario tests check the parsed path fields (`source`) of both files, not their raw text, since
  JSON escapes quotes with a backslash.
- **`.secrets/` permissions.**
  - Linux, macOS: `chmod 700`, then `stat` to confirm the mode is exactly 700.
  - Windows: POSIX modes do not exist (Node's `chmod` only toggles read-only), so
    `npm create plugbricks` runs one PowerShell script (`WINDOWS_ACL_SCRIPT` in
    `create-plugbricks/lib/create.js`, folder passed through an environment variable) that
    **replaces the whole DACL** with a new protected one holding a single entry: full control for
    the current user's SID. It reads the ACL back with
    `GetAccessRules(..., [SecurityIdentifier])` and prints it as JSON; the generator then checks
    that the DACL is protected, nothing is inherited, every allow entry is the user's SID, and
    the user has full control. Only SIDs are compared, never names.
  - Why not icacls: the first CI run on `windows-latest` showed that
    `icacls /inheritance:r /grant:r` leaves explicit entries in place (`BUILTIN\Administrators`
    kept access), and that `icacls /save` writes SDDL aliases instead of SIDs (the runner's user
    is the built-in Administrator account, written `LA`), so a SID comparison on that output
    reports the user as a foreign account. Earlier versions parsed the text output of `icacls`,
    which also depended on the console code page; neither applies any more.
  - Second CI run: the `Set-Acl` cmdlet failed on `windows-latest` ("the module could not be
    loaded"), so the folder kept its inherited ACL and the generator correctly reported it. The
    script now calls `[System.IO.Directory]::GetAccessControl` / `SetAccessControl` directly,
    which needs no module. A test forbids `Get-Acl` and `Set-Acl` in the script.
  - Members of Administrators can still take ownership of the folder and read it, as root can on
    Linux and macOS. The protection is against other ordinary accounts.
  - If any step fails, on any OS, the generator prints
    `warning SECRETS_NOT_RESTRICTED: …` with the reason and still creates the project (exit 0):
    the folder is empty at that point. Nothing fails silently.
  - `plugbricks generate` and `up` run the same check before writing any secret (milestone 3,
    `ensureSecretsDir` in `src/secrets.ts`): a missing `.secrets/` is created and restricted, an
    existing one is only checked (owner and mode 700 on Linux and macOS; on Windows the same ACL
    rules, read with `WINDOWS_ACL_CHECK_SCRIPT`, which changes nothing). Not restricted: refused
    with `SECRETS_NOT_RESTRICTED`, nothing written. The restriction code moved from
    `create-plugbricks` into `plugbricks`, which re-exports it.
- **Symbolic links.** Creating one needs Developer Mode or administrator rights on Windows. The
  scenario that checks that bricks with symlinks are refused declares `"needs": ["symlinks"]`;
  the runner probes once whether a symlink can be created and, if not, skips that scenario with
  the reason in its title. It never fails or passes silently. The test helpers link
  `node_modules` with a junction on Windows, which needs no privilege.
- **Running npm and tar in tests.** npm is always run as `node <npm-cli.js>`, never through a
  shell (on Windows `npm` is a `.cmd` file, which Node no longer spawns without a shell, and a
  shell would split paths that contain spaces). `npm-cli.js` comes from `npm_execpath` only when
  that really is `npm-cli.js` (under yarn it is `yarn.js`, under pnpm `pnpm.cjs`), otherwise from
  the npm bundled with the running Node, otherwise from the `npm` on PATH resolved to its
  `npm-cli.js` (distribution packages install it elsewhere, e.g. `/usr/share/nodejs/npm`; on
  Windows `npm.cmd` sits next to `node_modules/npm/bin/npm-cli.js`). `npm pack` tarballs are extracted in
  JavaScript (the `tar` found first on Windows runners may be GNU tar from Git, which reads
  `C:\…` as a remote host).
- **Tools.** `tools.json` pins k3d v5.9.0 and kubectl v1.37.2 for linux, darwin and windows on
  amd64 and arm64, each entry with its version and the sha256 from the official release checksum
  file (score-k8s and score-compose were removed with D5). k3d publishes no windows/arm64 build:
  that entry says so explicitly (`available: false` and a reason). The checksum files were
  fetched over HTTPS from the official release pages. On 2026-11-17 the linux-amd64 binaries of
  k3d and kubectl were downloaded and matched their sha256.
- **Docker installed as a snap** (Ubuntu) cannot see `/tmp`: a bind mount from there arrives
  empty in the container. The tests work under the package's `.test-work/`, inside the home
  folder.

---

## D5. The drivers render their files themselves; Score is not used

- **Status:** implemented (milestone 3), replaces D1 and D2.
- **Context:** first run of score-compose 0.50.0 with a provisioner written by us (2026-11-17,
  binary verified against `tools.json`):
  1. `generate` adds a `wait-for-resources` service with image `alpine`, a floating tag that
     our manifests forbid (`IMAGE_FLOATING_TAG`), the same problem D1 was about;
  2. the consumer only waits for the provision task to be **started**
     (`condition: service_started`), not completed: it can start before its database exists;
  3. a Score workload is one pod or one Compose service named `<workload>-<container>`; our
     convention (one network name `<brick>-<service>` per service) does not map onto it.
  All three can be patched with patch templates, but each driver would then depend on an
  external binary, its state file (`.score-compose/state.yaml`, with secrets in clear) and
  its version, and would no longer be a pure function plan → files.
- **Decision:**
  - `src/plan.ts` builds a runtime-independent plan from `platform.lock` and the installed
    copies (integrity checked, manifests re-validated). `src/drivers/compose.ts` and
    `src/drivers/k8s.ts` are pure functions plan → files, tested by golden files
    (`test/fixtures/cli/generate-*`), with no Docker and no cluster.
  - Order of start, identical on both runtimes, for each consumer and required capability:
    provider started → **wait** (only with `wait: healthy`: the provider's `ready` command,
    from outside, every `ready.intervalSeconds`, at most `timeoutSeconds`) → **provision**
    (the provider's task, idempotent) → the consumer's services. Compose: one-shot services
    `<consumer>-wait-<cap>` and `<consumer>-provision-<cap>` chained with
    `service_completed_successfully`. Kubernetes: init containers `wait-<cap>` and
    `provision-<cap>` in each consumer pod; provision scripts come from a ConfigMap.
  - The wait script needs `/bin/sh`, `date` and `sleep` in the `ready` image (default: the
    provider's image).
  - Kubernetes runs the provision step in every pod of the consumer (one per service), so a
    consumer with two services provisions twice, possibly at the same moment. The task must be
    idempotent anyway; if two runs race on a create, one fails, its init container is restarted
    and the second attempt finds everything in place. Compose runs one shared task per consumer.
  - Provision scripts are mounted read-only and executable (`0555` on Kubernetes, the file's own
    mode through the Compose bind mount).
  - Nothing is published on the host until the router exists (milestone 4).
  - Runtime names must be unique and valid DNS labels (≤ 63 characters): services, tasks,
    volumes (including volumes kept after a removal, so a new brick never attaches another
    brick's data), secrets, ConfigMaps. `add` refuses a brick that would break this
    (`RUNTIME_NAME_CONFLICT`, `RUNTIME_NAME_INVALID`) before writing anything.
  - Kubernetes: `up` applies the namespace, the Secret, then the resources; deletes the
    Deployments, Services and ConfigMaps of removed bricks by label (never a
    PersistentVolumeClaim, never the Secret); then waits for each rollout. `down` deletes the
    same kinds for all bricks and keeps the data.
- **Consequences:** `tools.json` no longer pins score-k8s and score-compose; it keeps k3d and
  kubectl for a Kubernetes end-to-end test. The Compose driver is tested end to end against a
  real Docker engine (`test/e2e-compose.test.ts`, skipped with its reason where no Linux engine
  answers). The Kubernetes driver is tested by golden files and a fake `kubectl`; it has not run
  on a cluster yet.
- **Kubernetes safety** (added 2026-11-17): `up` and `down` with `--runtime k8s` never use the
  current kubectl context. They require `--context <name>` (and accept `--kubeconfig <file>`),
  and every kubectl command carries these flags. The contexts `platform` and `k3d-platform`
  (the name k3d gives to a cluster called `platform`) are refused unless `--allow-context`
  names the same context. Error codes: `K8S_CONTEXT_REQUIRED`, `K8S_CONTEXT_REFUSED`,
  `K8S_KUBECONFIG_NOT_FOUND`. `generate --runtime k8s` only writes files and needs no cluster.

---

## D6. Templates and secrets

- **Status:** implemented (milestone 3).
- **Templates** are checked when a brick is added (`TEMPLATE_UNKNOWN`), per field:

  | Field | Allowed |
  |---|---|
  | `services[].env` | `${secrets.<name>}` |
  | `provides.<cap>.ready.exec` | `${provider.host}`, `${provider.port}` |
  | `provides.<cap>.provision.command` | `${provider.host}`, `${provider.port}`, `${consumer.name}` |
  | `provides.<cap>.provision.env`, `inject` | all four |

  Secrets never go on a command line, where every process can read them (`ps`). Any other
  `${...}` is refused, so a typo never reaches a container as literal text. A lone `$` is
  literal; the drivers double it, because Compose and Kubernetes both read `$$` as `$`.
- **Scope of a secret:** a secret name that the brick's own `services[].env` uses belongs to
  the brick (`PB_<BRICK>__<NAME>`, e.g. the postgres superuser password), even when `provision`
  or `inject` use it too. Any other secret used in `provision.env` or `inject` is generated
  **per consumer** (`PB_<PROVIDER>__<CONSUMER>__<NAME>`, e.g. each consumer's own database
  password). Two keys that would map to the same variable are refused.
- **Storage:** `.secrets/secrets.env` (`KEY=value`, mode 0600), 32 random letters and digits
  per secret (no escaping needed in a URL, an env file or YAML). Compose reads it with
  `--env-file`, and the Compose file refers to `${PB_X:?…}`, so a missing secret stops Compose
  instead of starting with an empty password. Kubernetes: `.secrets/k8s-secret.yaml` (a Secret
  holding only the secrets in use); containers read each secret into its own variable and
  refer to it as `$(PB_X)`. No secret value is ever written to `.generated/`.
- **Never deleted:** removing a brick keeps its secrets. A retained volume attached again still
  needs the password it was initialised with (PostgreSQL reads `POSTGRES_PASSWORD` only on its
  first start).

---

## Already applied (milestone 2)

Points 1 to 3 of experiment D are in the manifest schema:

- `requires.<capability>.timeoutSeconds` (default 120, maximum 900). On expiry the wait
  script exits 124. Compose: `up` finds the wait task that exited 124 and reports
  `WAIT_TIMEOUT`. Kubernetes: the init container exits 124, the pod goes to `Init:Error` /
  `CrashLoopBackOff`, the rollout times out, and `up` reports `WAIT_TIMEOUT` from the init
  container status.
- `provides.<capability>.ready` (required): an exec array that must target
  `${provider.host}` (`READY_NOT_TARGETING_PROVIDER` otherwise).
- `healthcheck.timeoutSeconds` (default 3) and `healthcheck.startPeriodSeconds` (default 0),
  so one manifest behaves the same on both engines.
