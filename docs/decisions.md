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

| Tool          | Version | sha256 of the archive                                              | Flag in `init --help` | Behaviour                               |
| ------------- | ------- | ------------------------------------------------------------------ | --------------------- | --------------------------------------- |
| score-k8s     | 0.23.0  | `36a99aea22b5f87a5e6545854086b6dcb2f8d3cafc7f52e02d4b52ae6d62d944` | yes                   | no provisioner loaded, `generate` fails |
| score-k8s     | 0.22.0  | `d32f190d6278943d85cfecfacdee31146ff56b5fa148d6fe2850da1fa237d2f0` | yes                   | same                                    |
| score-compose | 0.50.0  | `7257a7eed0079f92382668ff3ea4abc3158d93bce4b5b2f40b1476d84d313564` | yes                   | same                                    |
| score-compose | 0.49.0  | `4d69d33049c5042e47e432d28f1021aee068c75ab766341e2689cb9b85646c6d` | yes                   | same                                    |

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
- **Who decided:** the decision to drop Score was taken by Dedy (the project owner). The
  verification of the Kubernetes driver on a real cluster was postponed by Dedy, and is the end-to-end
  test `packages/plugbricks/test/e2e-k8s.test.ts` (CI job "kubernetes (k3d)"; added 2026-11-17, first green on pull request 4).
- **Context:** first run of score-compose 0.50.0 (2026-11-17). Only score-compose was looked at
  for this decision; **no reason below was checked with score-k8s**. The three reasons are not
  equally solid, and the evidence below was re-run on 2026-11-17 to say exactly what it shows.
  1. **`wait-for-resources` uses a floating tag. Confirmed.** `generate` adds a
     `wait-for-resources` service with image `alpine`, a floating tag that our manifests forbid
     (`IMAGE_FLOATING_TAG`), the same problem D1 was about.
  2. **The consumer only waits for the provision task to be started. Does not apply to the
     built-in provisioner.** The observation was made with a provisioner written by us, whose
     task the consumer depended on with `condition: service_started`. With score-compose's own
     postgres provisioner, the same test gives `service_healthy` on the database and
     `service_completed_successfully` on the init task (evidence below): the consumer cannot
     start before its database exists. This reason only holds if plugbricks supplies its own
     provisioners, which is what D1 planned and what is no longer the case.
  3. **Names do not match our convention. Confirmed.** A Score workload is one pod or one
     Compose service named `<workload>-<container>`, and provisioned resources get random names
     (`pg-e3W8IV`); our convention (one network name `<brick>-<service>` per service) does not
     map onto it.
     Together, the confirmed reasons (1, 3) can be patched with patch templates, but each driver
     would then depend on an external binary, its state file (`.score-compose/state.yaml`, with
     secrets in clear) and its version, and would no longer be a pure function plan → files. That
     trade-off, not a failure of Score, is the reason for the decision.
     **Kubernetes: the reasons are an extrapolation, the driver is now verified.** score-k8s 0.22.0
     and 0.23.0 were tested earlier on a k3d cluster, only for the init-container wait of D2, which
     worked. None of the three reasons above was verified with score-k8s, so dropping score-k8s
     still rests on the Compose observations and on the dependency argument. What changed on
     2026-11-17 is that plugbricks' own Kubernetes driver ran on a real cluster (see Consequences).
- **Evidence** (score-compose 0.50.0, `linux_amd64` archive sha256
  `7257a7eed0079f92382668ff3ea4abc3158d93bce4b5b2f40b1476d84d313564`, equal to the published
  checksums file; run offline with the built-in provisioners):

  ```
  $ cat score.yaml
  apiVersion: score.dev/v1b1
  metadata:
    name: client
  containers:
    main:
      image: postgres:17.11-alpine
      variables:
        PGHOST: ${resources.db.host}
  resources:
    db:
      type: postgres

  $ score-compose init --no-sample && score-compose generate score.yaml
  INFO: Provisioned 1 resources
  INFO: Converting workload 'client' to Docker compose

  $ grep -E "^\s+image:" compose.yaml
      image: postgres:17.11-alpine
      image: mirror.gcr.io/postgres:17-alpine
      image: mirror.gcr.io/postgres:17-alpine
      image: alpine

  $ grep -E "^  [a-z][^ ]*:$" compose.yaml
    client-main:
    pg-e3W8IV:
    pg-e3W8IV-init:
    wait-for-resources:
    pg-e3W8IV-data:

  $ awk '/^  wait-for-resources:/,/^volumes:/' compose.yaml
    wait-for-resources:
      command:
        - echo
      image: alpine
      depends_on:
        pg-e3W8IV:
          condition: service_healthy
          required: true
        pg-e3W8IV-init:
          condition: service_completed_successfully
          required: true
  ```

  - Reason 1: the last `image:` line, `alpine`, belongs to `wait-for-resources`, which no
    provisioner controls. The two `mirror.gcr.io/postgres:17-alpine` lines are the provisioner's
    own images, with a major-version tag that is also floating.
  - Reason 2: `wait-for-resources` depends on `service_healthy` and
    `service_completed_successfully`, and `client-main` depends on `wait-for-resources`
    completing. Not reproduced.
  - Reason 3: the services are `client-main` (workload `client` + container `main`) and
    `pg-e3W8IV` (random), not `<brick>-<service>`.

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
  answers). The Kubernetes driver is tested by golden files and a fake `kubectl`, and **since
  2026-11-17 also on a real k3d cluster** (`test/e2e-k8s.test.ts`, CI job "kubernetes (k3d)").
  First green run, pull request 4 (workflow run 44053589871): `up` with postgres, orders and a
  volume brick (three pods `Running`), a GraphQL `createOrder`, `down` keeping both
  PersistentVolumeClaims, `remove` then `up --prune-volumes` deleting only the pending one, and
  `WAIT_TIMEOUT` after 304 s; the job took 6 min 13 s, of which the `WAIT_TIMEOUT` test is about
  five minutes (Kubernetes has no fast failure for a crash-looping init container, so `up` waits
  for the rollout deadline). **Changed on 2026-11-23:** that wait was 5 of the 16 minutes the job had
  grown to. `up` now waits for a service that waits on a capability in slices of 15 s
  (`ROLLOUT_SLICE_SECONDS`) and reads its wait init containers between them, so a wait that exited 124 is
  reported after the first slice or so, as Compose does; a `rollout status` failure that is not its own
  timeout is reported at once. The k3d scenario asserts `WAIT_TIMEOUT` in less than 120 s. Behaviour
  change: a wait that times out once and succeeds after Kubernetes restarts it used to let `up` succeed
  if it happened before the deadline; it is now reported, as on Compose, where a wait task that exits 124
  fails `up` too. The decision stands. That run shows the driver works; it does not
  compare it with score-k8s, so the Score reasons above stay as evidence, not as a measurement.
  Not yet tested on a cluster: killing the database pod and running `up` again (roadmap).
  - plugbricks now owns what Score provided: the YAML for Compose and Kubernetes objects
    (`src/yaml.ts`, `src/drivers/`), the start order, and the wait and provision steps.
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

  | Field                                    | Allowed                                                    |
  | ---------------------------------------- | ---------------------------------------------------------- |
  | `services[].env`                         | `${secrets.<name>}`                                        |
  | `provides.<cap>.ready.exec`              | `${provider.host}`, `${provider.port}`                     |
  | `provides.<cap>.provision.command`       | `${provider.host}`, `${provider.port}`, `${consumer.name}` |
  | `provides.<cap>.provision.env`, `inject` | all four                                                   |

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

## D7. Code quality: formatting, linting, git hooks, CI checks, security scans

- **Status:** implemented (2026-11-17).
- **Context:** the code is read and changed by several people and several assistants. A stray
  character pasted at the start of `test/helpers/pack.ts` (`лimport ...`) went unnoticed until
  the type check failed. Checks that run on every commit and on every pull request catch that kind of
  slip when it is cheap to fix. The design is inspired by common practice; no file from another
  repository was copied.
- **Decision:**
  - **Prettier** (3.10.1, `.prettierrc.json`: 140 columns, double quotes, semicolons, trailing commas,
    LF) formats code, JSON and YAML. Markdown, GraphQL and the Dockerfile are not formatted.
    **ESLint** (9.39.5, flat config `eslint.config.mjs`, `@eslint/js` + `typescript-eslint` recommended
    rules, `eslint-config-prettier`) looks for bugs only; style is Prettier's job. The rules are not
    type-aware yet (faster, no project setup).
  - **Never formatted, never linted** (`.prettierignore` and `ignores` in `eslint.config.mjs`, the same
    list): `test/fixtures/**` (scenario bricks and golden files), `packages/plugbricks/examples/**`
    (their integrity hash is recorded in golden lock files), `packages/create-plugbricks/template/**`
    (copied as is), `dist/`, `node_modules/`, `.test-work/`, `coverage/`, `.generated/`, `.secrets/`,
    `.platform/`, `package-lock.json`. Formatting any of them would change a hash or a byte-for-byte
    comparison and break a test.
  - **Scripts** (root `package.json`): `format`, `format:check`, `lint`, `typecheck`, `test`,
    `test:unit` (everything except the Docker and Kubernetes end-to-end tests), `coverage`, `quality`
    (`format:check`, `lint`, `typecheck`, `test`, in this order), `hooks:install`.
  - **Git hooks** live in `.githooks/` (no husky). `npm run hooks:install` sets
    `core.hooksPath`; the dev container runs it after `npm ci`. There is deliberately no `prepare`
    script: it would run on every `npm ci`, including in CI and when the package is installed as a
    dependency, and would change a git setting without being asked.
    - `pre-commit` (fast, on the **staged content**, not the working tree): whitespace errors
      (`git diff --cached --check`); forbidden files (`.env` and `.env.*` and `*.env` except
      `.env.example`, `.env.sample`, `.env.template`; `.secrets/`, `.generated/`, `.test-work/`, `.kube/`;
      private keys and certificate bundles; kubeconfig files); secret patterns (private key blocks, AWS
      access keys and secret keys, GitHub tokens, GitLab tokens); a source file (`.ts`, `.js`, `.mjs`,
      `.json`, `.yml`...) that starts with a non-ASCII character or a byte order mark; Prettier and
      ESLint on each staged code file. It lists every problem, not only the first. The golden files under
      `test/fixtures/*/*/expected/.generated/` are the one allowed use of `.generated/`.
    - `pre-push`: `npm run typecheck` and `npm run test:unit`.
    - The rules are pure functions in `scripts/hooks/checks.mjs`, tested in
      `packages/plugbricks/test/hooks.test.ts`.
  - **CI** (`.github/workflows/ci.yml`, job `quality`, Linux only; the three-OS test matrix is
    unchanged): `npm run quality`, then `npm audit --omit=dev --audit-level=high`, then a coverage
    report written to the job summary (V8, **no threshold**). Actions are pinned by commit SHA.
  - **Security**: `.github/dependabot.yml` (npm at the root and in `apis/orders`, and GitHub Actions;
    weekly, grouped) and `.github/workflows/codeql.yml` (CodeQL for JavaScript and TypeScript on
    pushes to `main`, on pull requests and weekly; actions pinned by SHA).
- **Skipping a hook, in an emergency only:** `git commit --no-verify` or `git push --no-verify`.
  Do not make it a habit: the hooks are the only check that runs before the code leaves your
  machine, and a secret that is committed is public in the history even if a later commit removes
  it. CI runs the same formatting, lint, type and test checks, so a skipped hook only moves the
  failure to the pull request, but CI does **not** scan for secrets or forbidden files.
- **Not covered:**
  - **No container image scan.** plugbricks has no image of its own; the example API's image
    (`apis/orders/Dockerfile`) and the images named in bricks are not scanned, and are pinned by
    tag, not always by digest.
  - **No secret scanning of the history or in CI**: the hooks check only what is staged, and
    `--no-verify` skips them. Turn on GitHub secret scanning and push protection in the repository
    settings for that.
  - **Known advisories in development dependencies**: the test runner (vitest 2.1.9 and what it pulls
    in: vite, esbuild, tinypool) has open advisories; the fix is a major upgrade (vitest 5). The CI
    audit looks at production dependencies only, which have none.
  - ESLint is not type-aware (no `no-floating-promises` and similar rules).
  - Licenses of dependencies are not checked. CodeQL and Dependabot need the repository settings that
    allow them (code scanning, Dependabot updates); until they have run on GitHub, their behaviour is
    unverified.

---

## D8. The subgraphs are composed with @wundergraph/composition, before anything is written

- **Status:** implemented for the check (milestone 4, step 4b-1). The router and the second API
  come in the following steps.
- **Context:** bricks can serve a GraphQL subgraph and extend entities of other bricks
  (`subgraph` and `extends` in the manifest). Two bricks that disagree on a type must be refused
  when the second one is added, with a message that says who disagrees on what. Three libraries
  were compared on 2026-11-17, on the same cases (valid pair; the same entity field and the same
  value type with incompatible types; an extension of a type nobody defines; an undefined type; a
  `@key` on a missing field; a syntax error):
  - `@wundergraph/composition` 0.68.1: Apache-2.0, 116 packages in its production closure.
    Steady-state call 1.3 to 3.2 ms. Errors are plain `Error` objects with a message only, no code,
    and the same problem can appear twice.
  - `@apollo/composition` 2.14.4: **Elastic-2.0**, 3 packages under that licence, 73 packages in
    total. Steady-state call 4.4 to 17 ms. Errors carry stable codes (`FIELD_TYPE_MISMATCH`,
    `EXTENSION_WITH_NO_BASE`, ...). Its output is a supergraph schema for Apollo's router, not
    the configuration the Cosmo router reads.
  - the `wgc` binary 0.133.12: 565 packages, 271 MB, 3.3 s per call: rejected as a dependency.
- **Decision:** `@wundergraph/composition` 0.68.1, exact version, with `@wundergraph/cosmo-shared`
  0.50.1 (added now, used from step 4b-3).
  1. **One chain.** The router reads a `router-config.json` built from the composition result.
     Checking with one composer and configuring with another would let them disagree. The
     configuration built in process from this library was accepted by the router 0.372.0
     (spike of 2026-11-17: health, `__typename` and a query across two subgraphs, with mock
     subgraphs), including without the empty `featureFlagConfigs` that `wgc` writes.
  2. **Licence.** Elastic-2.0 is not an open source licence (it forbids offering the software as a
     hosted service, among other things). A command line tool that people run themselves is
     probably allowed, but we would rather not carry the question. Both Apache-2.0 and the
     permissive licences of the rest of the tree are reviewed in
     `docs/pre-publication-checklist.md`.
  3. **Speed**, 3 to 5 times lower per call.
     The error texts of the composer are shown as they are (it names the bricks, because a subgraph
     is named after its brick, the type and the field) and are not parsed: only their codes and
     structure would be stable with Apollo's library, and we accepted that trade.
- **`extends` exercised by a real second API (4b-2, 2026-11-17):** `examples/shipping` extends
  `Order` of `examples/orders`. A test composes all the example bricks together and expects
  success; scenarios on the real example bricks show `EXTENDS_OWNER_MISSING` while orders is not
  installed, a successful add after it, and `EXTENDS_IN_USE` when orders is removed. On Docker
  Compose the two APIs ran on their own databases: the shipping role is refused on the orders
  database (`permission denied for database "orders"`), and shipping answers `_entities` for an
  `Order` it never stored. The router itself (4b-3) was not involved.
- **Where it runs:** `add` and `remove` compose the subgraphs the platform would have, before any
  file is written; `status` composes again. The library is loaded the first time it is needed:
  a platform with no subgraph never loads it. It is a CommonJS package, loaded with `require`, so
  `add`, `remove` and `status` stay synchronous (an `import()` would have made them, `main` and
  every caller asynchronous, for the same laziness).
- **Refusals:** `COMPOSITION_FAILED` (one issue per distinct composer error, its text as it is),
  `SUBGRAPH_SCHEMA_INVALID` (file, line, column; nothing else is tried after a syntax error),
  `EXTENDS_OWNER_MISSING`, `EXTENDS_ENTITY_MISSING`, `EXTENDS_ENTITY_NOT_DECLARED` (the extending
  brick's own schema must declare each entity listed in `extends.entities`: an object type, or its
  extension, with `@key`), and `EXTENDS_IN_USE` for `remove`, which refuses to remove a brick whose
  entity an installed brick extends. `status` reports `FEDERATION_CHANGED`.
- **What no composer can see:** a type `Ghost @key(fields: "id")` defined by one subgraph and by
  nobody else composes without error: composition has no notion of what a brick meant to extend
  (case 3b). The `extends` field says it, and plugbricks checks it (`EXTENDS_ENTITY_MISSING`).
  The other direction is not checked: a brick that defines an entity another brick owns, without
  listing it in `extends`, composes too.
- **Known limits, observed through the router on Docker Compose (4b-4, 2026-11-17).** Neither is fixed
  on purpose; the end-to-end test asserts the first, so that fixing it makes the test say so.
  - **`shipOrder` accepts an order id that does not exist.** Shipping has its own database and cannot
    know which orders exist. Through the router: `mutation { shipOrder(orderId: "999999", carrier: "ups")
{ carrier status } }` answers `{"data":{"shipOrder":{"carrier":"ups","status":"SHIPPED"}}}`; the
    shipment is then visible only by asking shipping directly, `{ shipment(orderId: "999999") { carrier
status } }` answers `{"data":{"shipment":{"carrier":"ups","status":"SHIPPED"}}}`, and never through an
    `Order`: `{ order(id: "999999") { id shipment { carrier } } }` answers `{"data":{"order":null}}`.
    The shipment of an order that was never created is an orphan row in the shipping database.
  - **No implicit `extends` detection.** With the `extends` field removed from the shipping manifest,
    `add` succeeds, the federation is `orders, shipping`, and through the router the graph behaves the
    same: `{ order(id: "1") { id total shipment { carrier status } } }` answers
    `{"data":{"order":{"id":"1","total":10,"shipment":{"carrier":"dhl","status":"SHIPPED"}}}}`. What is
    lost is the protection: `remove orders` is then accepted (exit 0), because nothing says shipping
    depends on it, and shipping alone keeps defining `Order`, so the graph silently loses the order fields.
- **The lock:** a `federation` section, only when at least one brick serves a subgraph: the
  composer's name and version, `routerCompatibilityVersion`, the sorted list of subgraphs and the
  sha256 of the federated schema (its definitions sorted by kind and name, then printed). No date.
  The lock version stays 1: the section is optional. `status` fails only when the schema hash
  differs; a different composer version is shown and accepted. A brick without a subgraph is
  ignored; with no subgraph at all nothing is composed and the section is absent.
- **A brick copy that cannot be read** is left out, as in the runtime name check, unless a
  federation is involved (a subgraph is being added, or the lock already records one): then `add`
  and `remove` refuse with `BRICK_UNREADABLE`, because composing without it would record a wrong
  hash.
- **Dependency override.** `@wundergraph/composition` 0.68.1 and `@wundergraph/cosmo-shared` 0.50.1
  depend on `@graphql-tools/utils` 11.x and 8.x, which have two high advisories (prototype
  pollution in `mergeDeep` and `mergeIncrementalResult`; fixed in 12.0.1). The root `package.json`
  therefore overrides it to 12.1.0, the version `@graphql-tools/merge` already uses. The composition
  code only requires `@graphql-tools/merge`. The router configuration built with `cosmo-shared`
  and the override is byte-identical to the one built before it (checked on 2026-11-17 on the two
  subgraphs of the spike). The CI audit of production dependencies passes with it and fails
  without it. Remove the override when the packages move to a fixed version.
- **Risks:**
  - the router configuration (step 4b-3) reuses about 25 lines of `wgc` (`constructRouterSubgraph`
    in its `router compose` command) with `buildRouterConfig` from `cosmo-shared`: these lines are
    not a public API and can change. A CI job comparing our output with `wgc router compose` (version
    pinned) is the planned protection; until it exists, the equality was checked once, by hand, and
    differs only by `featureFlagConfigs`;
  - the composer and the router are released independently: 0.68.1 and 0.372.0 are known to work
    together on the cases of the spike, nothing more;
  - the schema hash depends on the composer's output: a new composer version that prints another
    schema makes `status` report `FEDERATION_CHANGED` until the bricks are added again.

---

## D9. The router is rendered by plugbricks and is not a brick; loopback only

- **Status:** implemented (milestone 4, steps 4b-3, 4b-4 and 4b-5). 4b-3 rendered it and ran it by hand against
  its image with fake subgraphs. 4b-4 tests it on Docker Compose with the real orders and shipping APIs and real
  databases, with real requests through it (the `e2e-compose` test "the router in front of orders and
  shipping"). 4b-5 runs it on Kubernetes in the k3d CI job, with real requests through it on the cluster, and
  cross-checks its configuration against `wgc router compose` (see below).
- **Decision:**
  - **Not a brick.** A brick declares exec probes and a wait step that runs a shell in an image. The
    Cosmo router image (`ghcr.io/wundergraph/cosmo/router:0.372.0`, pinned by the digest of its
    multi-architecture index, `sha256:bfe6d89a…0205`, re-read from the registry on 2026-11-17) is
    distroless: **no `/bin/sh`, no `wget`**, so an exec healthcheck or wait step cannot run in it. It
    belongs to no brick either: it exists because some brick serves a subgraph. `plan.ts` adds it to the
    plan when at least one installed brick has a subgraph, and the two drivers render it. With no
    subgraph there is no router, no `router-config.json`, and the next `generate`, `up` or `down`
    removes what an earlier run created (Compose `--remove-orphans`; Kubernetes `up` deletes the objects
    labelled `plugbricks/component=router`, `down` deletes everything plugbricks created).
  - **Its configuration** (`router-config.json`, one text, byte-identical for the same bricks) is built
    in process by `src/federation.ts`, the only file that imports the composer and
    `@wundergraph/cosmo-shared`: `federateSubgraphs` then `buildRouterConfig` (D8). Each subgraph is
    reached at `http://<brick>-<service>:<port><path>`, the runtime names our drivers already use. It is
    written to `.generated/<runtime>/router-config.json` (mode 0644: the container runs as another
    user). Its sha256 is put on the container (Compose label) and on the pod (annotation), because the
    router reads its configuration once, at start: a changed configuration recreates it.
  - **Published on the loopback address only.** Compose: `127.0.0.1:<router.port>:3002`, the long port
    syntax with `host_ip`, and nothing else in the file has a `ports` entry. Kubernetes: a ClusterIP
    Service (port `router.port`, target 3002), no Ingress, no NodePort, no LoadBalancer, no hostPort, no
    hostNetwork. Tests look for all of these in the rendered output. `router.port` is in `platform.json`
    (integer from 1024 to 65535, default 4000), refused by every command otherwise; `status` shows the
    port and the image.
  - **Compose** waits for each subgraph service with `service_healthy`, or `service_started` for a
    service that declares no healthcheck (Compose refuses `service_healthy` without one). The router has
    no healthcheck. **Kubernetes** uses HTTP probes, `/health/ready` for readiness and `/health/live` for
    liveness (both answered 200 in the spike), the configuration in a ConfigMap (refused with
    `ROUTER_CONFIG_TOO_LARGE` above 1,000,000 bytes, before anything is written), and `up` waits for the
    rollout like for the other workloads.
- **What was verified by running the image** (2026-11-17, router 0.372.0, digest above):
  - **Playground:** by default `GET /` answers 200 (the playground). With `PLAYGROUND_ENABLED=false`,
    `GET /` answers 404. The variable still works but the router logs that it is deprecated in favour of
    the `playground.enabled` option of its YAML configuration; we keep the variable (one file less) and
    this is the first thing to revisit when the router is upgraded. Introspection is not changed.
  - **Telemetry, a surprise:** with the default settings, and with `TRACING_ENABLED`,
    `METRICS_OTLP_ENABLED` and `PROMETHEUS_ENABLED` set to `false`, **the router opens an HTTPS
    connection to `eu.i.posthog.com` at start** (anonymous usage tracking), even with no graph token. A
    capture inside the container's network namespace showed the DNS question and the connection. The
    router's source (`router/core/router.go`, tag `router@0.372.0`) skips that tracker when
    `COSMO_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`; with both set, the same 25 s capture showed no
    DNS question and no outgoing connection. Both are set. The router without a graph token does not
    contact the Cosmo control plane (it logs that Cosmo Cloud features are disabled).
  - **Non-root:** the router starts and answers (`/health/ready` 200, `{ __typename }`) with
    `--user 65532:65532`, and also with `--read-only --cap-drop ALL --security-opt no-new-privileges`.
    It therefore runs as uid/gid 65532 with a read-only root filesystem and no capability on both
    runtimes (`runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`,
    `drop: [ALL]` and the `RuntimeDefault` seccomp profile on Kubernetes). Its 3002 port is above 1024.
  - **No `no-new-privileges` on Compose** (changed 2026-11-21). With Docker 29.8.0 installed as a snap
    (Ubuntu), the router restarted forever (exit 255, `exec /router: operation not permitted`), so
    `status --runtime` and the admin showed it `unhealthy` and not published. Running its image by hand
    with one option at a time on that engine: `--user 65532:65532`, `--read-only` and `--cap-drop ALL`
    each start it; `--security-opt no-new-privileges:true` alone is enough to make the exec fail. The
    Compose service therefore keeps the non-root user, the read-only root filesystem and `cap_drop: ALL`,
    and no longer sets `security_opt`. What is lost: a setuid or file-capability binary in the image
    could no longer be refused the privileges it grants. The image is distroless with a single static
    binary (`/router`); and with every capability dropped from the bounding set, a setuid-root binary
    would run as uid 0 but with no capability, on a read-only root filesystem. The remaining risk is
    small; it would grow if the image changed. Kubernetes keeps
    `allowPrivilegeEscalation: false`, which runs on k3d in CI. Why the snap engine refuses the exec
    (its AppArmor confinement is the likely cause) was not investigated further.
- **Verified on Docker first, then on a kubelet:** `runAsNonRoot` (a numeric `runAsUser` 65532),
  `readOnlyRootFilesystem` and the HTTP probes were first verified by running the image with Docker (`--user`,
  `--read-only`, `curl` on the health paths). The k3d CI job of pull request 9 (workflow runs 44087159424 and
  44091435148, job "kubernetes (k3d)", both green) then deployed the router on a real cluster: its test expects
  the four pods `orders-app`, `postgres-db`, `router` and `scratch-redis` to be `Running`, and `up` waits for the
  router's rollout, which waits for its readiness probe. So the kubelet accepted the security context and the
  readiness probe passed. Not shown there: the liveness probe failing or not over time. A request through the
  router on the cluster is shown by 4b-5, below.
- **4b-5, the router and shipping on a real cluster (the cluster result is in: the job is green).**
  `e2e-k8s.test.ts` now runs postgres, orders, shipping and the router on a throwaway k3d cluster, with real requests
  through the router only (`kubectl port-forward service/router`, bound to 127.0.0.1 on a free port: it needs no
  client image, it uses the same HTTP client as the Compose test, and the router-to-subgraph path through the Service
  names and ClusterIPs is exercised by the federated queries themselves). It asserts: the four pods are `Running`
  and every container `Ready`; no Ingress, only ClusterIP services, no `nodePort`, `hostPort` or host network; the
  Compose scenario (createOrder, order with `shipment: null`, shipOrder, the order with fields from both services in
  one request, a validation error on an unknown field, `GET /` is 404); `remove shipping` then `up` rolls the router
  Deployment (a new `plugbricks/router-config-sha256` annotation, a higher generation, a new pod) and the
  `shipment` field is gone; `add shipping` then `up` rolls it again, the annotation is the original value and the
  field is back with its data; `down` removes the Deployments, the Services and the plugbricks ConfigMaps, router
  included, and keeps the postgres PersistentVolumeClaim (D3) and the Secret (D6). The first green run was the one
  of pull request #14 (workflow run 44271309209, 2026-11-18); the job has been green on `main` since (run
  44286645462 for the merge of #13, 9m14): the pods were ready, the responses above came back, the router rolled
  when the composition changed and `down` removed the workloads. The restart behaviour (a rollout when the
  configuration changes, a new pod, the old one terminating) is what the test asserts; how the router behaves when
  its pod is killed is not tested.
- **Cross-check against the official tool (done, and run by the CI `quality` job).** `router-crosscheck.test.ts` gives `wgc router compose`
  (wgc 0.133.12, pinned in `tools/wgc-crosscheck`, a standalone package with its own lockfile that is not a
  dependency of plugbricks) the same two subgraphs (the installed copies of the schemas of orders and shipping,
  the URLs of our runtime names) and compares its `router-config.json` with ours, field by field. Result: **equal,
  except the one field the test sets aside**: `featureFlagConfigs`, an empty object that wgc always writes and that
  we do not write (the test requires it to be exactly `{}`, so nothing real can hide behind it). The same 6862 bytes
  of JSON apart from that field. The test fails and lists the differing paths when anything else differs (checked
  by changing a URL on wgc's side). Facts found while doing it: wgc contacts the network to check for a newer
  version before every command unless `DISABLE_UPDATE_CHECK=true`, and reports telemetry unless
  `COSMO_TELEMETRY_DISABLED` or `DO_NOT_TRACK` is set; with the three set it ran in a network namespace with no
  network at all and produced the same bytes. The test is skipped, with the reason in its title, where wgc is not
  installed (`npm run crosscheck:install`) and on Windows; the CI `quality` job installs it, the matrix jobs do not.
  The tool brings 565 packages, which is why it is not a root devDependency; its lockfile pins every package with its
  integrity hash.
- **Not verified:** a real multi-node cluster (the CI cluster has one
  node, so scheduling, node-to-node networking and several router replicas are untested); macOS and Windows (the
  rendering is pure text, the router runs only in Linux containers, the end-to-end tests are skipped there);
  that the router keeps working after an upgrade of its image (the digest is pinned on purpose).
- **Node versions:** the router configuration loads `@wundergraph/cosmo-shared`, an ES module, with
  `require()`. Run on 2026-11-17 in containers: Node 20.18.3 fails with `ERR_REQUIRE_ESM`; Node 20.19.0 and
  22.12.0 build the same configuration (6862 bytes for orders and shipping). `engines` is therefore
  `>=22.12.0` for the root, `plugbricks` and `create-plugbricks`: 22.12 is the first Node 22 with `require()`
  of ES modules on by default and CI tests Node 22 (`.node-version`); 20.19 works but nothing tests it, so
  it is not claimed. On 22.12.0 Node printed an ExperimentalWarning because the requiring file was outside
  `node_modules`; whether it prints for an installed package was not checked.
- **Risks:** the router image is large (145 MB) and comes from ghcr.io, which is not pinned by a
  mirror; the playground variable is deprecated; the telemetry switch is a variable that the router could
  rename (the check is a capture, not a test in CI); the composer version appears in the configuration
  (`compatibilityVersion: 1:0.68.1`), so a new composer changes the text and the hash of the file.

---

## D10. status --runtime is read-only and never queries GraphQL

- **Status:** implemented (step 5a): `src/live.ts` (pure parsing and the report), `statusRuntime` in
  `src/runtime.ts` (the calls), `schemas/status-runtime.schema.json` (the JSON report, version 1).
- **Decision:** `plugbricks status --runtime` reports what the runtime runs using only the runtime's
  own listings and health state: `docker compose ps --all --format json`, `docker inspect` with a Go
  template that prints the restart count and the OOM flag and nothing else, or one
  `kubectl get deployments,pods,services --output json` in the platform's namespace. It never execs into a
  container, never reads logs, Secrets, ConfigMaps or environment variables, and never sends a request
  (GraphQL or HTTP) to a subgraph or to the router. Reasons are fixed wordings built from exit codes and
  the runtime's reason codes (`CrashLoopBackOff`, `ImagePullBackOff`, `Unschedulable`), never a runtime
  message or a log line. Every call is killed after 15 s; a runtime that cannot be read is
  `RUNTIME_UNAVAILABLE`, exit code 4.
- **Why:**
  - **Safe to run anywhere, any time, by anyone allowed to list.** A status command is run often, by
    scripts and later by an admin page; it must not change anything, need exec rights, or put load on the
    services it observes. Listing rights are enough.
  - **No secret can leak.** Pod specs and container configurations hold environment values, and logs can
    hold anything; the report is built from a short list of status fields only, and the tests check that no
    secret value or environment variable reaches it (`test/live.test.ts`, the `e2e-compose` scenario).
  - **The runtime already knows.** Compose runs the healthcheck of each service and Kubernetes its
    readiness probe; reporting their verdict keeps one definition of "healthy", the one `up` waits on. A
    GraphQL request would test something else (the request path through the router), would depend on the
    schema, and would fail differently from what the runtime acts on.
- **Consequences:**
  - The router has no health check on Compose (its image has no shell and no `wget`, D9): there it is
    `unknown` ("running; no health check") and does not fail the exit code. On Kubernetes its HTTP
    readiness probe makes it `healthy`.
  - Whether the router can actually reach a subgraph is not tested by this command; each subgraph's own
    state is shown under the router instead.
  - Compose prints the exit code of a restarting container only in `Status` ("Restarting (255) …";
    `ExitCode` is 0 then), and no publisher while it restarts: the address is null at that moment.
  - Kubernetes cannot tell "not ready yet" from "failing" for a container that is running and not ready:
    plugbricks says `starting` while the Deployment is still rolling out, `unhealthy` once the rollout
    is over.
  - `platform.json` has no runtime field and was not changed: the runtime is named with `--runtime`, as
    for `up` and `down`.
  - `enabled` is "installed in platform.json" for now: there is no switch to disable an installed brick.

---

## D11. The queue capability: one broker shared by every consumer, RabbitMQ first

- **Status:** implemented (step 5b): `examples/rabbitmq/plugin.json`, capability `queue`; tested by the
  CLI golden scenario `generate-rabbitmq` and end to end on Docker Compose, with the same scenario
  written for the k3d job (CI is its reference run). Kafka and NATS are deferred; NATS (and its
  JetStream/accounts) will be re-examined after this. **The shared-account and single-port parts of
  D11 are superseded by D12** (one vhost and user per consumer, through `extraPorts`).
- **Decision:**
  - **One capability, one provider.** `queue` follows `database`: a platform has at most one queue
    provider (the lock maps the capability to one brick; a second provider is refused with
    `CAPABILITY_ALREADY_PROVIDED`). Any number of bricks may `requires.queue`; each receives the
    provider's `inject`.
  - **One broker shared by every consumer.** `examples/rabbitmq` runs one RabbitMQ broker
    (`rabbitmq:4.1.4-management`, data volume `retain`); its `ready` is a TCP check (`nc -z`, from
    `busybox:1.36`), and its `provision` task gives each consumer its own vhost and user (D12). Each
    consumer gets `AMQP_URL` (its own credentials) and `QUEUE_NAME=<consumer.name>`. The consumer
    declares its own queue: the topology belongs to the application, not to the brick.
  - **The account was shared at first (superseded by D12).** The image's default user (`plugbricks`)
    is an administrator; D11 first injected its password into every consumer, with a per-consumer
    `QUEUE_NAME` only. D12 replaced that by a vhost and user per consumer.
- **Why it was not per consumer at first (resolved by D12):** creating a vhost and a user is an
  administrative operation that AMQP (5672) does not carry. RabbitMQ exposes it only through the
  management HTTP API (15672) or `rabbitmqctl` over the Erlang distribution (4369, 25672), and a brick
  declared a single port per service: the Kubernetes driver rendered a Service with that one port, so
  the provision task (a different pod) could not reach 15672 on k3d. Compose would have allowed it (one
  Docker network), Kubernetes would not: plugbricks does not give a runtime-dependent behaviour. D12
  adds `extraPorts` on a service, which is what made per-consumer accounts possible.
- **Consequences and limits:**
  - The management port 15672 is never published on the host. Since D12 it is an extra port of the
    Service (ClusterIP); only the provision task holds the administrator password.
  - Security: each consumer has its own vhost and user (D12); the shared account described above was
    the first step and is gone. The administrator credential lives in the broker's own environment and
    in the provision task, never in a consumer.
  - Secrets: the broker's administrator secret (`PB_RABBITMQ__DEFAULT_PASSWORD`) is used by the broker
    and the provision task; each consumer gets its own `...__CONSUMER_PASSWORD`, never printed by the
    end-to-end tests.
  - Kafka can create its topics and ACLs over its own protocol (9092), so it will not need
    `extraPorts`; NATS core needs no extra port either, but accounts and JetStream need a
    configuration file or command line the manifest cannot express today (a service has no
    `command`/config field), so NATS stays deferred.

---

## D12. extraPorts, and one RabbitMQ account per consumer

- **Status:** implemented (step 5b-bis): `services[].extraPorts` in the manifest schema, the plan and
  the Kubernetes driver; `PORT_CONFLICT` for names and numbers; the RabbitMQ provision task creates a
  vhost and a user per consumer. Supersedes the shared-account and single-port parts of D11.
- **Decision:**
  - **`extraPorts`.** A service may declare additional ports (`name`, `port`): they become extra
    ports of its Kubernetes Service, so that a provision task or an operator inside the platform can
    reach a management API. Compose renders nothing extra: containers of the platform network already
    reach any port. Nothing new is ever published on the host (D9).
  - **Names follow Kubernetes.** A port name is at most 15 characters, lowercase letters, digits and
    dashes; `main` is reserved for the primary port; a name or a number may appear once per service.
    Violations are refused with `PORT_CONFLICT` (tests: three invalid manifests).
  - **One account per consumer.** `examples/rabbitmq` exposes its management API as the `management`
    port (15672), and its provision task (image `curlimages/curl:8.11.1`, script
    `provision/create-vhost.sh`) creates, through that API, the consumer's vhost, user and permissions.
    The broker's administrator password is only in the broker and in the provision task's environment;
    each consumer gets `AMQP_URL=amqp://<consumer>:<its secret>@<broker>:5672/<consumer>` and
    `QUEUE_NAME=<consumer>`.
- **Consequences:**
  - The management port is in the Service (ClusterIP) but never published. Without a NetworkPolicy,
    any pod of the namespace could reach it, but only the provision task holds the administrator
    password; consumer users have no management tag and are limited to their vhost.
  - Per-consumer secrets are back (D6): revoking one consumer means deleting/rotating its user without
    touching the others.
  - The provision script retries until the management API answers (it can start a moment after AMQP);
    a consumer's start waits for its provision task, as for postgres.
  - Kafka can provision topics/ACLs over 9092 and will not need this feature; NATS accounts and
    JetStream still need a configuration file or command line the manifest cannot express.
- **Tests:** the golden scenario `generate-rabbitmq` (management port, provision script, one secret per
  consumer); the Compose e2e checks `rabbitmqctl list_vhosts`, `list_users`, `list_permissions` and that
  `AMQP_URL` uses the consumer's own user and vhost without printing it; the k3d e2e checks the
  Service ports and the vhosts. A real consumer (`examples/queue-consumer`, source
  `apis/queue-consumer`) publishes one message and consumes it, and its `/health` only answers 200
  after that round-trip: the Compose and k3d e2e both start it against the broker.

---

## D13. NATS core: a second queue provider, without accounts or JetStream

- **Status:** implemented (step 5c): `examples/nats/plugin.json`, capability `queue`; golden scenario
  `generate-nats`, and end-to-end tests on Docker Compose and k3d with a pinned `nats-box` client.
- **Decision:** `nats:2.11.6-alpine` on port 4222, no volume, no healthcheck (the image exposes no
  monitoring listener without a command, and the manifest cannot pass one); `ready` is a TCP check
  (`nc -z`, from `busybox:1.36`), `provision` is a no-op, and each consumer gets
  `NATS_URL=nats://<broker>:4222` and `SUBJECT=<consumer.name>`. Core NATS only: publish/subscribe.
- **Why not JetStream or accounts:** both need a configuration file or a command line (`-js`, `-m`,
  account/user definitions) that a service manifest cannot express today. They are deferred with the
  same reasoning as D11/D12; when the manifest grows a `command`/config field, a NATS brick can offer
  JetStream and per-consumer accounts.
- **Alternatives, not complements:** `queue` has one provider per platform, as `database` does. NATS
  and RabbitMQ are two implementations of that capability; a platform installs one.
- **Tests:** `natsio/nats-box:0.19.2` (pinned) is used as a client in the tests, not as a brick: on
  Compose a subscriber container and a publisher container on the project network; on k3d a
  `nats-sub` pod that subscribes and receives the published message in its log.
- **Consequences:** no persistence, no per-consumer credentials, no JetStream; the broker is not
  published and has no healthcheck, so `status --runtime` reports it as `unknown` ("running; no
  health check"), never as healthy.

---

## D14. `enabled` and `tags`: installed but not deployed, and labels for the admin

- **Status:** implemented (step 5d, ahead of the admin): `enabled` in `platform.json`, `tags` in
  `plugin.json`, the `enable`/`disable` commands, the plan filter and the live report. Tested by the
  CLI scenarios `disable-brick`, `enable-brick`, `disable-provider-in-use`, `disable-extended-owner`,
  and by a live-report test.
- **Decision:**
  - **A brick is enabled unless `platform.json` says otherwise.** `add` writes no flag; `disable
<name>` writes `enabled: false`; `enable <name>` removes it. A disabled brick is still installed:
    its lock entry, volumes and secrets are kept, and its name stays reserved; `generate` and `up`
    simply do not render it. Compose `--remove-orphans` and the Kubernetes cleanup remove its
    workloads; its volumes (PVCs) and the secret file are kept.
  - **Refusals keep the platform consistent:** disabling a provider that an enabled brick still
    requires is `CAPABILITY_IN_USE`; disabling an owner whose entity an enabled brick extends is
    `EXTENDS_IN_USE`; adding or enabling a consumer whose provider is disabled is `PROVIDER_DISABLED`
    (enable the provider first). The federated schema is recomposed on every toggle, exactly as
    `add`/`remove` do.
  - **`status --runtime`** reports a disabled brick with `enabled: false`; its services are `stopped`
    with the reason "disabled in platform.json" and `mismatch: null` (not "not-deployed"). It is never
    counted as degraded: exit code 0 stays 0. `status` (text) marks the brick `disabled`.
  - **`tags`** are optional labels in `plugin.json` (lowercase, dashed), sorted in the lock, and shown
    in `status --json` and in the live report (`bricks[].tags`). They are for filtering in the admin;
    they never affect rendering.
- **Limits:** the `enabled` flag is not per service; a brick is enabled or not as a whole. Secrets of a
  disabled brick are kept in `.secrets/` (and re-projected into the Kubernetes Secret when it is
  enabled again). A hand-edited `platform.json` that disables a provider while a consumer stays enabled
  is an inconsistent platform: `generate` refuses rather than guessing.

---

## D15. The admin: a local React/Vite server, OIDC, read-only first

- **Status:** implemented (step 6: the actions in 6c, the real OIDC in 6d): `plugbricks admin`,
  `packages/admin`, OIDC (public or confidential client) and dev authentication, `/api/session`,
  `/api/bricks`, `/api/actions`, `/api/audit`, the Bricks, Router and Audit pages, and their actions.
- **Decision:**
  - **A local command, not a brick:** `plugbricks admin` serves the UI on `127.0.0.1:4100` and exits
    only when killed. The CLI stays synchronous: the listening server keeps the process alive. Flags:
    `--port`, `--runtime`, `--context`, `--kubeconfig`, `--allow-context`, `--dev`, `--issuer`,
    `--client-id`; the Kubernetes target follows the same rules as `status --runtime`.
  - **The UI and the server are separate:** React 19 + Vite + Tailwind in `packages/admin` (built to
    `packages/admin/dist`); the HTTP server lives in the core (`src/admin/server.ts`) and serves the
    built assets. The core's `prepack` copies the build to `dist/admin/ui`, which the published
    package ships (inside `files: dist`) and which `plugbricks admin` prefers; in the monorepo it
    falls back to the sibling `packages/admin/dist`. A `dist` test checks the tarball and serves the
    packed UI. The admin API is read-only and returns the same data as the CLI: `platformStatus`,
    `statusRuntime`, plus the installed manifests for port, subgraph and `extends`.
  - **OIDC, or an explicit dev mode:** authorization code + PKCE against any issuer, roles
    `plugbricks-viewer` (read) and `plugbricks-admin` (actions). The client may be **public** (PKCE
    only, no secret) or **confidential** (the secret is read from `PLUGBRICKS_OIDC_CLIENT_SECRET`,
    never a flag); with a public client, openid-client is told `none` explicitly because Keycloak does
    not advertise that method. `--dev` turns authentication off, for local use only; without a session
    `/api/*` answers 401 and the SPA shows the sign-in page. A real Keycloak walkthrough (external
    issuer, public client, realm roles in the ID token) is in `docs/keycloak.md`.
  - **OIDC details:** the issuer must be `https`; plain `http` is accepted only on `127.0.0.1`,
    `localhost` or `[::1]` (`ADMIN_OIDC_ISSUER_INVALID` otherwise). The roles are read from the **ID
    token** (`realm_access.roles` or `roles`): with Keycloak, the realm roles mapper must have "Add to ID
    token" on. The sign-in `state` is also set in a short HttpOnly cookie (`pb_oidc_state`, 10 minutes,
    path `/auth/callback`) and must match at the callback, so a callback link from someone else's
    sign-in is refused (login CSRF). A discovery that fails is not cached: the next sign-in tries again.
  - **Sessions** are in memory (a restart signs everyone out), carried by an HttpOnly, SameSite=Lax
    cookie, and end on the **server** after 8 hours whatever the cookie says; expired sessions and
    sign-ins are pruned. Sign-out is a `POST`. No secret is read by the admin or sent to the UI; the
    API is `no-store`; internal errors go to the terminal, never to the browser.
  - **Loopback only, and addressed to it:** the server listens on `127.0.0.1` and answers only requests
    whose `Host` is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, and whose `Origin`, when
    sent, is one of those. Listening on the loopback interface does not stop DNS rebinding (a hostile
    page whose name resolves to 127.0.0.1); this check does, including in `--dev`. Every response has
    `nosniff`, `X-Frame-Options: DENY` and `no-referrer`; the page has a CSP that allows only its own
    scripts, styles and API. The Vite dev proxy presents itself as `127.0.0.1:4100`.
  - **The runtime is read without blocking:** `/api/bricks` uses `statusRuntimeAsync`, the same steps
    and the same report as `status --runtime` (one generator, two drivers), with each call run as an
    asynchronous child process (no shell, 15 s timeout). Concurrent page loads share one read. The
    brick state is its worst service in the order of `status --runtime`, with the restarts of all of
    them.
  - **Actions, as the CLI itself:** `POST /api/actions` accepts `add` (a `source` path relative to
    the platform root), `enable`/`disable`/`remove` (a `brick` name) and `up` (no field). The request
    must be `application/json` and at most 16 KiB; the admin role is required (a viewer gets 403, no
    session 401). Names are checked against the schema's pattern and paths against `-`, `/`, `\`, a
    drive letter, a `..` segment and NUL before anything runs. `202 {id}` is answered at once; the
    action runs in a child process of the built CLI, never with a shell, from the platform root, with
    `--runtime` and, for `up` on Kubernetes, `--context`, `--kubeconfig` and `--allow-context` exactly
    as the admin received them. The OIDC client secret is removed from the child's environment. No
    `--prune-volumes`: deleting data stays a terminal decision, and the admin cannot turn a misclick
    into data loss. One action at a time in this server: a second is 409 `BUSY` while one runs; the
    platform lock (D16) still refuses a terminal command meanwhile, and the CLI's `PLATFORM_BUSY` is
    reported as the action's result. The last 50 actions are kept in memory, with the last 2000
    output lines, and SIGKILL after 30 minutes.
  - **The Router page:** `/api/bricks` also returns the router configuration: its hash and size from the
    plan (`configSha256`, bytes), the generated source (`.generated/<runtime>/router-config.json`), the
    composition (subgraphs, extended entities of the enabled manifests) and the composed SDL
    (`engineConfig.graphqlSchema`), all read-only. It uses the same plan and runtime read as the CLI.
  - **Reading an action:** `GET /api/actions` and `GET /api/actions/:id` (any signed-in role) give the
    state (`running`/`succeeded`/`failed`), exit code, output lines, the issue codes parsed from
    `error <CODE>` lines, the user and the times. The UI polls every second, shows the output, and
    refreshes the Bricks table when the action ends.
  - **Audit:** every action writes two lines to `.admin/audit.log` (JSONL): one when accepted
    (`result: "Accepted"`: the request was accepted) and one when it ends (`Success`, `Refused` for
    exit 1/2 with issue codes, `Failed` otherwise), with the action id and duration in `details`. The
    user is the session name and subject, the role is the session role. No output and no secret is
    ever written. `.admin/` is created 0700 and `audit.log` 0600 (POSIX), with a `.gitignore` holding
    `*`.
- **Tested:** `test/admin.test.ts` against a local OIDC provider (discovery, keys, token endpoint, RS256
  ID tokens; no network): admin and viewer roles, no role (403, no session), a callback without or
  with another state cookie, a state used twice, expiry after 8 hours, discovery retried, the `Host` and
  `Origin` checks, the headers, path traversal, a slow runtime that does not block other requests, and
  `RUNTIME_UNAVAILABLE` (503), and the real sign-in against Keycloak (the e2e test starts a real
  Keycloak container when its image is already on the machine, imports a realm with a public client
  and a realm-role mapper, and signs `demo` in; it is skipped when the image is absent). The actions
  are tested: roles (401/403/202, and dev), every validation
  refusal, the exact argv (with the k8s flags, and only for `up`), the stripped secret, 409 and a
  non-blocking `/api/session` while an action runs, the issue codes and the audit results, two audit
  lines per action with the POSIX modes, a cross-site POST refused, and enable/disable through the
  real built CLI. Not tested: a real Keycloak in CI (CI does not pull its image, so the e2e test above
  runs only on a machine that has it), any other real provider, a browser, macOS/Windows
  (the audit modes are POSIX-only), and Kubernetes actions on a cluster. The `dist` test also checks
  that the tarball contains `dist/admin/ui/index.html` and that the packed CLI serves that UI. The Keycloak brick is not
  provided: a platform service is not published on the host (D9) and a provider-level setup task does
  not exist yet, so the supported path is an external issuer; a brick would need both.
- **Limits:** actions live in the admin's memory (a restart forgets them, the audit log stays); the
  UI polls instead of streaming the output; there is no `--prune-volumes` from the admin.

---

## D16. One changing command at a time: a lock file per platform

- **Status:** implemented (step 6b, before the admin actions): `src/lock.ts`, taken by the CLI for
  `add`, `remove`, `enable`, `disable`, `generate`, `up` and `down`. Tested by `test/lock.test.ts`, with
  a real second process holding the lock.
- **Decision:** a command that changes the platform first creates `.platform/lock` with `O_EXCL`
  (`openSync(…, "wx")`) and writes its pid, the command with its arguments and the time; the file is
  removed when the command ends, also when it fails. Another changing command meanwhile is refused with
  `PLATFORM_BUSY` (exit code 1), which names that command and its process. `init`, `status` (with or
  without `--runtime`) and `admin` do not take the lock: reading is never blocked.
- **Why:**
  - **The admin runs the CLI.** Its actions are `plugbricks` commands in a child process (next step);
    a person can run `up` in a terminal at the same time. Two writers of `platform.lock`, of
    `.generated/` or of the runtime at once would leave either one's result, or a mix.
  - **A file, not a lock in the admin's memory:** only a file is seen by every process, the terminal's
    included. `O_EXCL` creation is atomic on every OS we support, local file systems included.
- **A holder that died:** a process killed with `SIGKILL`, or a machine that crashed, leaves its lock.
  The next command checks the pid with `process.kill(pid, 0)` (sends nothing); a process that no longer
  exists has its lock taken over. An empty lock file (its holder is still writing it) gets a second look
  100 ms later before it counts as stale.
- **Limits:**
  - The pid is only meaningful on the same machine: a platform folder shared between machines (a
    network drive) is not protected, and a pid reused by an unrelated process keeps a stale lock until
    that process ends (the message names the file and the process).
  - The lock does not wait: a busy platform is refused, not queued.
  - The lock file is in `.platform/`, beside the bricks, which a project may commit: `init` writes
    `.platform/.gitignore` with `/lock` in it. A platform created before this has none: add
    `.platform/lock` to its `.gitignore` (a refused command must not change any file, so the lock
    does not write one).

---

## D17. Web bricks: one loopback port per brick, and a router that accepts only their origins

- **Status:** step 7a (point 1 below, the router's origins) implemented on 2026-11-21: `allowedOrigins`
  in the plan, `routerEnv` in `src/drivers/common.ts`, golden files for both runtimes, and an end-to-end
  test on Docker Compose (`e2e-compose`, "accepts browser calls only from its allowed origins"): a
  `text/plain` and a JSON mutation with `Origin: http://evil.example` get 403, a preflight from it gets
  403, and the number of orders does not change. A request with the router's own origin runs (200); a
  *preflight* with it gets 400, because the router treats it as a same-origin request, which never needs
  one. Not run on k3d yet. Step 7b (points 2 to 7, the web bricks) implemented on 2026-11-21: `web` in
  the manifest, `webPort` in `platform.json` (written by `add`), the service published on
  `127.0.0.1:<webPort>` by Compose, `GRAPHQL_URL` and `PUBLIC_GRAPHQL_URL` set on it, the router's origins
  following the web bricks, `status` showing "pages on 127.0.0.1:<port>", the admin's Hosts column, and
  `examples/orders-web` (source `apis/orders-web`). Tested by the CLI scenarios `web-brick-generate`
  (golden files for both runtimes), `web-port-next-free`, `web-port-conflict` and
  `add-web-env-reserved`, by the admin test, and end to end on Docker Compose (`e2e-compose`, "a web
  brick in front of the router"): only the router and the page are published, both on 127.0.0.1; an
  order created and shipped through the router shows on the page, rendered by its server through
  `GRAPHQL_URL`; the page's two origins get 204 and their own origin back on a preflight, and a request
  from the page's origin runs, while `http://evil.example` gets 403; with the shipping container stopped
  the page still lists the order and marks its shipment "Unavailable". A real browser (headless Chrome)
  clicking "Refresh" on the page got HTTP 200 from the router, from the page's own origin. The k3d
  scenario (`e2e-k8s`, "serves a web brick's page through port-forward on its webPort") is written on
  2026-11-22: every Service a ClusterIP, the two variables on the Deployment (`GRAPHQL_URL` is
  `http://router:4000/graphql` there), the page reached by a port-forward whose local port is its
  webPort, the router's origins, and shipping scaled to zero. The local machine could not hold a k3d
  cluster with this platform, so it first ran in the CI job "kubernetes (k3d)" of pull request 34, green.
  D17 is implemented in full. Chosen by Dedy on
  2026-11-21 between two options: a web
  gateway (one published reverse proxy in front of the pages and `/graphql`) and one published port per
  web brick. The second was chosen: simpler to start, no new component to pin and harden.
- **Context:** the admin mockup shows a shop page served by an `orders-web` brick. Until now only the
  router is published (D9), and the router serves GraphQL only, so a page needs its own entry. With one
  port per web brick, the page's origin (`http://127.0.0.1:<its port>`) differs from the router's
  (`http://127.0.0.1:<router.port>`): every GraphQL call from the browser is cross-origin, so the router's
  CORS settings decide what works and what is allowed.
- **Observed on the router 0.372.0** (2026-11-21, the pinned digest, on Docker 29.8.0):
  - **Today it accepts every origin.** A preflight from `http://127.0.0.1:8080` gets
    `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`. Worse, a request no
    browser preflights, a `POST` with `content-type: text/plain` and an `Origin: http://evil.example`
    header, carrying `mutation { createOrder(total: 1) { id } }`, answered 200 and created the order.
    Any web page the user opens can therefore read the platform's graph and run its mutations through
    `127.0.0.1:<router.port>`. That is true whether or not web bricks exist.
  - **`CORS_ALLOW_ORIGINS` closes it.** With `CORS_ALLOW_ORIGINS=http://127.0.0.1:8080,http://localhost:8080`:
    a preflight from either origin gets that origin back (204); a preflight from `http://evil.example`
    gets 403; and the same `text/plain` and `application/json` mutations with `Origin: http://evil.example`
    get **403 and are not executed** (the router refuses the request itself, not only the response
    headers). A request without an `Origin` header (curl, a server, the tests) is not affected.
- **Decision:**
  1. **The router always restricts origins**, also with no web brick: `CORS_ALLOW_ORIGINS` lists
     `http://127.0.0.1:<p>` and `http://localhost:<p>` for the port `p` of each enabled web brick, and
     with none, only the router's own origin (`http://127.0.0.1:<router.port>`), which no other page
     has. This step comes first and stands alone: it fixes the hole above for every platform.
  2. **The manifest** gains an optional `web: { "service": "<name>", "path": "/" }`: the service that
     serves pages on its `port`, and the entry path shown by the admin (default `/`). A brick may have
     both `subgraph` and `web`. `UNKNOWN_SERVICE` (the code `subgraph` and `provides` already use) when
     the service does not exist.
  3. **The host port is the platform's choice, not the brick's:** `platform.json` gets
     `bricks.<name>.webPort` (1024 to 65535). `add` writes the first port from 8080 upwards that no other
     web brick and not `router.port` uses, so the same `add` twice still gives identical files; the user
     may change it. Two equal ports, or a web port equal to `router.port`, are refused by every command
     (`WEB_PORT_CONFLICT`). The admin's own port (4100 by default, a flag) is not in `platform.json`; a
     clash with it shows as the admin failing to listen.
  4. **Exposure, D9 amended:** on Compose the web service is published on `127.0.0.1:<webPort>` only,
     with the same long syntax and `host_ip` as the router; nothing else gains a `ports` entry. On
     Kubernetes nothing new is published: the service already has a ClusterIP Service, reached with
     `kubectl port-forward` (the allowed origins assume the same local port as `webPort`).
  5. **What the web service is given**, only when a router exists: `GRAPHQL_URL`, the router's internal
     address (`http://router:3002/graphql` on Compose, `http://router:<router.port>/graphql` on
     Kubernetes), for server-side calls or for proxying `/graphql` itself (then the browser makes no
     cross-origin call at all); and `PUBLIC_GRAPHQL_URL`, `http://127.0.0.1:<router.port>/graphql`, for
     code that runs in the browser. A manifest that sets either name in that service's `env` is refused
     (`WEB_ENV_RESERVED`).
  6. **The admin** shows `http://127.0.0.1:<webPort><path>` in the Hosts column for a web brick, as a
     link on Compose; `status --runtime` reports the published address of the web service.
  7. **An example**, `examples/orders-web` with its source in `apis/orders-web`: a small page that lists
     the orders through `PUBLIC_GRAPHQL_URL` and shows the shipment as unavailable when shipping does not
     answer, like the mockup.
- **Tests planned:** golden files for both runtimes (one `ports` entry per web brick plus the router,
  `CORS_ALLOW_ORIGINS` in the router's environment, the two injected variables); the refusals; end to end
  on Docker Compose: the page answers on `127.0.0.1:<webPort>` and on no other address, a preflight from
  its origin is accepted, one from another origin is refused, and the cross-site `text/plain` mutation is
  refused and creates nothing; the same scenario in the k3d job through port-forward.
- **Limits:** each web brick costs one published port; the origins list follows `webPort`, so a page
  reached through another host name (a tunnel, a LAN address) is refused by the router, which is the
  point; there is no TLS on these loopback ports, as for the router.

---

## D18. A Keycloak brick: a web brick with its own built image, a realm without users, the admin pointed at it

- **Status:** implemented (2026-11-23). Point 1 (an image of our own, built once) was chosen by Dedy on
  2026-11-23, and points 2 to 7 accepted by him the same day. `${web.origin}` (context `webServiceEnv` in
  `src/templates.ts`), `WEB_PORT_MISSING`, `apis/keycloak` (Dockerfile, entry script, realm without users),
  `examples/keycloak`. Tested by the CLI scenarios `keycloak-generate` (golden files for both runtimes),
  `add-web-origin-outside` and `web-port-missing`, and end to end on Docker Compose (`e2e-oidc`, "the
  keycloak brick"): `up` returns once the realm answers, its issuer is `http://127.0.0.1:<webPort>/realms/plugbricks`,
  the realm has no user, a user created with the brick's generated administrator and given
  `plugbricks-admin` signs into `plugbricks admin` and gets an admin session. Not on k3d (point "Tests").
- **Context:** the admin signs people in with OIDC against an external issuer (D15, `docs/keycloak.md`).
  The mockup also has the identity provider inside the platform. D17 removed the first obstacle (a brick
  can publish its pages on its own loopback port); what was left unknown is how Keycloak behaves as a
  brick. It was measured on 2026-11-23 on the development machine (4 CPUs, 7.8 GB of RAM, Docker 29.8.0
  installed as a snap), Keycloak 26.7.3, digest `sha256:29be7252db0a…d6c4`, in production mode (`start`)
  against PostgreSQL 16.4:
  - **The image** is 756 MB, runs as uid 1000, and has **neither curl nor wget**, only bash.
  - **Realm import** (`--import-realm`, a JSON file in `/opt/keycloak/data/import`) created the realm, its
    roles `plugbricks-admin` and `plugbricks-viewer` and the admin's public client. On a restart Keycloak
    logged `Realm 'plugbricks' already exists. Import skipped`: the import runs once, so a later change to
    the file is not applied to an existing database.
  - **Health:** with `KC_HEALTH_ENABLED=true`, `/health/ready` answers on the management port 9000. A
    check written with bash alone works: open `/dev/tcp/127.0.0.1/9000`, send the request, look for `"UP"`.
  - **Memory:** about 570 to 590 MB for Keycloak, 45 MB for its PostgreSQL.
  - **Start times** (until the realm's discovery document answers 200):

    | Case | Official image (`start`) | Image built with `kc.sh build` (`start --optimized`) |
    |---|---|---|
    | new container, new database | about 200 s, of which 84 s rebuilding itself | 119 s |
    | container recreated, database kept | the same 84 s again, plus the start | 58 s |

    A plain `docker restart` of an already built container took 40 s; `up` recreates containers, so that
    is not the case that matters. The 119 s of the first start are mostly the database schema and the import.
- **Decision (proposed):**
  1. **An image of our own** (chosen): `apis/keycloak`, `FROM` the official image pinned by digest, `kc.sh build`
     for PostgreSQL with the health endpoints, then `start --optimized --import-realm`. Built like the other
     example images (`plugbricks-example/keycloak:0.1.0`); the brick never rebuilds Keycloak at start.
  2. **The realm ships in that image, without any user:** the realm `plugbricks`, its two roles, and the
     public client `plugbricks-admin` whose redirect URI is the admin's default, `http://127.0.0.1:4100/auth/callback`.
     The test realm of D15 (`test/fixtures/keycloak/realm.json`) has a user `demo` with a known password; it
     stays a test fixture and never goes into the brick.
  3. **A web brick requiring `database`** (`examples/keycloak`): `web: { service: "app", path: "/admin/" }`,
     so the console is at `http://127.0.0.1:<webPort>/admin/`. The `postgres` brick gives it its own role
     and database, but injects `DATABASE_URL` (`postgres://user:password@host:port/db`), while Keycloak
     reads `KC_DB_URL` (JDBC), `KC_DB_USERNAME` and `KC_DB_PASSWORD`: a small entry script in the image
     splits `DATABASE_URL` into those three before starting Keycloak. The provider stays generic.
  4. **Keycloak must know the address the browser uses** (`KC_HOSTNAME`), or its issuer and redirects
     point elsewhere. That address is `http://127.0.0.1:<webPort>`, chosen by the platform, so the manifest
     gains one template, `${web.origin}`, allowed in the env of a web brick's own service only (refused
     elsewhere with `TEMPLATE_UNKNOWN`). The issuer is then `http://127.0.0.1:<webPort>/realms/plugbricks`.
  5. **The first administrator:** `KC_BOOTSTRAP_ADMIN_USERNAME=admin` and `KC_BOOTSTRAP_ADMIN_PASSWORD` from
     a generated secret (`${secrets.admin_password}`, in `.secrets/`, D6). With it, the person signs into the
     console, creates the platform's users and gives them `plugbricks-admin` or `plugbricks-viewer`.
  6. **The admin is pointed at it by hand** for now: `plugbricks admin --issuer
     http://127.0.0.1:<webPort>/realms/plugbricks --client-id plugbricks-admin`; `status` shows the webPort.
     An `oidc` capability, so that the admin and later the router find the issuer by themselves, comes
     with token checks in the data plane (a later decision): no brick consumes it yet.
  7. **Waiting:** the healthcheck has a start period of 180 s, so that a first start (119 s measured) is not
     counted as failures. **It asks for the realm, not for `/health/ready`:** while building the plan, a
     platform `up` returned after 26 s with Keycloak "healthy" and the realm still answering 503. Keycloak's
     readiness endpoint on port 9000 said UP during its bootstrap (schema creation and realm import), which
     took about 100 s more. The check therefore sends `GET /realms/plugbricks/.well-known/openid-configuration`
     on port 8080 with bash and requires a 200; with it, `down` then `up` (container recreated, database kept)
     returned after 50 s with the realm already answering.
- **Tests planned:** a CLI scenario with golden files for both runtimes (the template, the secret, the
  published port); refusal of `${web.origin}` outside a web brick's service; end to end on Docker Compose
  only: `postgres` and `keycloak` up, the discovery document on `127.0.0.1:<webPort>` with that issuer, a
  user created with the bootstrap administrator through Keycloak's admin API, and a real sign-in to
  `plugbricks admin` with that user (the flow of the D15 test). Not on k3d: the image is large and its first
  start long; the CI job would grow by minutes, and the local machine cannot run it.
- **Limits:** the realm file is applied on the first start only; the redirect URI assumes the admin on port
  4100; about 600 MB of memory; a first start of about two minutes. `add` picks the first port from 8080
  that this platform does not use, not one that is free on the machine: with another platform's web brick
  already on 8080, `up` failed with "Bind for 127.0.0.1:8080 failed: port is already allocated", and the
  webPort had to be changed in `platform.json` (true of every web brick, D17).

---

## D19. Tokens in the data plane: the router requires a JWT when the platform has an `oidc` provider

- **Status:** accepted (2026-11-23), its assumptions verified the same day (below), not built. Chosen by Dedy on 2026-11-23: A1 (require a token only when
  an enabled brick provides `oidc`) and B1 (each service gets its own Keycloak client through the
  `provides` / `requires` wiring), over A2 (always require one) and B2 (one service account shared by all).
- **Context:** since D17 a web page of another site cannot call the router (CORS), but any program on the
  machine can, without credentials: read the orders, create them, ship them. Since D18 the platform can run
  its own Keycloak. Nothing yet ties the two.
- **Observed on the router 0.372.0** (2026-11-23, the pinned digest, Docker 29.8.0; a local JWKS server and
  RS256 tokens signed by the probe, not Keycloak, to spare the machine):
  - **Configuration:** a YAML file named by `CONFIG_PATH` ("Config file provided. Values in the config file
    have higher priority than environment variables"); its schema, embedded in the binary, has
    `authentication.jwt.jwks[]` with `url`, `issuers`, `audiences`, `algorithms`, `refresh_interval`, and
    `authorization.require_authentication` (also the variable `REQUIRE_AUTHENTICATION`).
  - **With `require_authentication: true`**, `{ __typename }` answered 200 with a valid token and
    `401 {"errors":[{"message":"unauthorized"}]}` with no token, an expired one, one signed by another
    key, a wrong issuer, a wrong audience, no audience, `alg: none`, and a string that is not a JWT.
  - **With `require_authentication: false`**, the same, except that a request without a token answered 200:
    a token that is present must be valid.
  - **Without a token**, `/health/ready` and `/health/live` answered 200, and a CORS preflight from an
    allowed origin answered 204 with `Authorization` among the allowed headers.
  - **The keys are fetched at start.** With the JWKS URL not answering, the router logged `Could not start
    router … could not setup authenticators: failed to create HTTP client storage for JWK…`, never listened,
    and **exited after 18 s with code 0**; it did not come back when the JWKS did.
  - The Keycloak image (D18) has `kcadm.sh`, Keycloak's admin command line, and `sh`, `date` and `sleep`,
    which the wait script of D5 needs.
- **Decision:**
  1. **Optional requirements.** A requirement may say `"optional": true`. Without a provider the brick is
     added and runs as before: nothing is injected and nothing waits. With a provider (enabled), it is wired
     like any requirement: wait, provision, inject. It is resolved when the plan is built, not frozen at
     `add`, so a provider added later wires the bricks already installed. Removing or disabling that
     provider is allowed (no `CAPABILITY_IN_USE`); their next `up` runs them without it. This is what lets
     `orders-web` run with or without Keycloak.
  2. **Keycloak provides `oidc`.** `ready`: its realm's discovery document answers 200 (bash, as its
     healthcheck, D18). `provision`, once per consumer and idempotent: with `kcadm.sh` and the brick's
     administrator password, create in the realm a confidential client named after the consumer, with a
     service account, the consumer's own generated secret, and an audience mapper adding `plugbricks-router`
     to its tokens. `inject`: `OIDC_TOKEN_URL` (the realm's token endpoint at the provider's address inside
     the platform), `OIDC_CLIENT_ID` (the consumer's name), `OIDC_CLIENT_SECRET` (`${secrets.client_secret}`,
     per consumer, D6).
  3. **What the router needs from the provider** is not in the capability's environment: the manifest of a
     brick that provides `oidc` gains `oidc: { "issuerPath": "/realms/plugbricks", "jwksPath":
     "/realms/plugbricks/protocol/openid-connect/certs", "audience": "plugbricks-router" }`. Such a brick
     must be a web brick: its issuer is its web origin plus `issuerPath` (the address the browser uses, as
     the tokens say, D18).
  4. **The router (A1).** When an enabled brick provides `oidc`, plugbricks renders a router configuration
     file (`.generated/<runtime>/router.yaml`, mounted read-only, named by `CONFIG_PATH`) with that JWKS (the
     provider's service address inside the platform plus `jwksPath`), that issuer only, that audience only,
     `RS256` only, and `require_authentication: true`. With no such brick, no file and no change: the router
     works as today. The file's hash goes on the container and the pod with the configuration's (D9), so a
     change recreates the router.
  5. **The router starts after the provider is ready**, since it cannot start without the keys. Compose:
     `depends_on` the provider's service with `service_healthy`. Kubernetes: the router gets the wait init
     container of D5 for `oidc` (the provider's ready command, in the provider's image), and its rollout
     deadline grows by that wait.
  6. **`orders-web`** requires `oidc` optionally. Its server asks `OIDC_TOKEN_URL` for a token with its
     client's credentials, keeps it until shortly before it expires, and sends it to the router. Its
     "Refresh" button calls its own server (`/api/orders`) instead of the router: a browser has no token to
     send. `PUBLIC_GRAPHQL_URL` and the router's origins (D17) stay for pages that sign their users in.
  7. **The admin finds the issuer** when `--issuer` is not given and an enabled brick provides `oidc`
     (its web origin plus `issuerPath`); `--issuer` still wins.
- **Verified before building on it** (2026-11-23, Docker 29.8.0: the D18 image of Keycloak and its
  PostgreSQL on one network, Keycloak's service named `keycloak-app`, `KC_HOSTNAME=http://127.0.0.1:18092`;
  the pinned router on the same network; a `node:22.23.5-alpine` container asking for tokens from inside it):
  - **The issuer is the browser's, whatever address the token is asked at.** A `client_credentials` token
    asked at `http://keycloak-app:8080/realms/plugbricks/protocol/openid-connect/token` carried
    `iss=http://127.0.0.1:18092/realms/plugbricks`, `alg` RS256, and expired in 300 s. A wrong secret got
    `401 unauthorized_client`.
  - **The audience mapper works:** the client created with it got `aud=["plugbricks-router","account"]`, one
    created without it `aud="account"`.
  - **The router accepts Keycloak's real tokens, configured as point 4 says** (JWKS at
    `http://keycloak-app:8080/realms/plugbricks/protocol/openid-connect/certs`, issuer
    `http://127.0.0.1:18092/realms/plugbricks`, audience `plugbricks-router`, RS256, required): `{ __typename }`
    answered 200 with the `orders-web` token, and 401 with no token, with the token without the audience,
    and with a string that is not a JWT.
  - **Provision with `kcadm.sh`** (log in to the master realm with the brick's administrator, look the client
    up by `clientId`, create it with a service account, its secret and the audience mapper, or set its secret
    again when it exists) took 21 s, 17 s and, run again on an existing client, 16 s: most of it is the JVM of
    `kcadm.sh` starting. The second run found the client and changed nothing else.
- **Tests planned:** CLI scenarios with golden files (optional requirement with and without provider,
  provider added after the consumer, router file present only with a provider); end to end on Docker
  Compose with Keycloak: no token 401, `orders-web`'s own token 200 and its page listing the orders, a
  token of another audience 401, the router starting only after Keycloak is ready. Not on k3d, as D18.
- **Limits:** every request through the router then needs a token, the end-to-end tests' included; the
  subgraphs do not see who called (the router does not forward the token: a later decision); a client
  created for a consumer is not deleted when that consumer is removed.

---

## Already applied (milestone 2)

Points 1 to 3 of experiment D are in the manifest schema:

- `requires.<capability>.timeoutSeconds` (default 120, maximum 900). On expiry the wait
  script exits 124. Compose: `up` finds the wait task that exited 124 and reports
  `WAIT_TIMEOUT`. Kubernetes: the init container exits 124, the pod goes to `Init:Error` /
  `CrashLoopBackOff`, and `up`, which waits for the rollout in 15 s slices, reports `WAIT_TIMEOUT` from
  the init container status after the slice in which it happened (D5).
- `provides.<capability>.ready` (required): an exec array that must target
  `${provider.host}` (`READY_NOT_TARGETING_PROVIDER` otherwise).
- `healthcheck.timeoutSeconds` (default 3) and `healthcheck.startPeriodSeconds` (default 0),
  so one manifest behaves the same on both engines.
