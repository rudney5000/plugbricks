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
  - `@wundergraph/composition` (0.68.1 when compared, 0.68.2 pinned today): Apache-2.0, 116 packages in its
    production closure.
    Steady-state call 1.3 to 3.2 ms. Errors are plain `Error` objects with a message only, no code,
    and the same problem can appear twice.
  - `@apollo/composition` 2.14.4: **Elastic-2.0**, 3 packages under that licence, 73 packages in
    total. Steady-state call 4.4 to 17 ms. Errors carry stable codes (`FIELD_TYPE_MISMATCH`,
    `EXTENSION_WITH_NO_BASE`, ...). Its output is a supergraph schema for Apollo's router, not
    the configuration the Cosmo router reads.
  - the `wgc` binary 0.133.12: 565 packages, 271 MB, 3.3 s per call: rejected as a dependency.
- **Decision:** `@wundergraph/composition` 0.68.2, exact version, with `@wundergraph/cosmo-shared`
  0.50.2 (added now, used from step 4b-3). Raised from 0.68.1 and 0.50.1 on 2026-11-25 to follow
  `wgc` 0.133.13 (PR #61); the comparison above was made with 0.68.1.
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
- **Dependency override.** `@wundergraph/composition` 0.68.2 and `@wundergraph/cosmo-shared` 0.50.2
  both declare `@graphql-tools/utils` `^12.1.0`, so the override is no longer what keeps the fixed
  version in the tree; it is left in place (it pins 12.1.0, the version the tree resolves anyway)
  and removed with the next dependency pass. It was added when 0.68.1 and 0.50.1 asked for 11.x
  and 8.x, which have two high advisories (prototype pollution in `mergeDeep` and
  `mergeIncrementalResult`; fixed in 12.0.1). The composition code only requires
  `@graphql-tools/merge`; `federation.ts` uses `printSchemaWithDirectives` from this package
  directly, hence the direct dependency in `packages/plugbricks/package.json`. The router
  configuration built with `cosmo-shared` and the override is byte-identical to the one built
  before it (checked on 2026-11-17 on the two subgraphs of the spike). The CI audit of production
  dependencies passes with it and fails without it at the old versions.
- **Majors held back (2026-11-25).** The composer asks for `graphql` `^16.9` and `@graphql-tools/utils` `^12.1`, so
  the root packages stay on graphql 16 and utils 12 (the example APIs, standalone, are on graphql 17). Dependabot
  proposed the next majors twice (#62, #65); `.github/dependabot.yml` now ignores the major updates of both for the
  root directory, and still proposes their patches and minors. The rule goes when the composer accepts the new majors.
- **Risks:**
  - the router configuration (step 4b-3) reuses about 25 lines of `wgc` (`constructRouterSubgraph`
    in its `router compose` command) with `buildRouterConfig` from `cosmo-shared`: these lines are
    not a public API and can change. A CI job comparing our output with `wgc router compose` (version
    pinned) is the planned protection; until it exists, the equality was checked once, by hand, and
    differs only by `featureFlagConfigs`;
  - the composer and the router are released independently: 0.68.2 and 0.372.0 are known to work
    together (the 2026-11-17 spike, then the `wgc` cross-check of PR #61), nothing more;
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
  (`compatibilityVersion: 1:0.68.2`), so a new composer changes the text and the hash of the file.

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
    them. When the platform cannot be planned (an unreadable copy, a composition error, a missing
    `webPort`, a name conflict), `/api/bricks` still answers 200: the issues are in `problems`, the
    router configuration is `null`, and the table shows the bricks with an `unknown` state.
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
  point; there is no TLS on these loopback ports, as for the router. Each page server answers only
  requests addressed to its loopback name and its own `WEB_ORIGIN` (the brick's `webPort`), with no
  foreign `Origin`; `orders-web` still calls the router with **its own** service-account token, so
  anyone who can reach it on this machine reads the orders. Carrying the user's own token is a later
  decision; this step adds no user login. When the router refuses that token (a reset realm, rotated keys),
  `orders-web` drops it and asks for a new one, once, instead of failing until it expires (`TokenSource.invalidate`).

---

## D18. A Keycloak brick: a web brick with its own built image, a realm without users, the admin pointed at it

- **Status:** implemented (2026-11-23). Point 1 (an image of our own, built once) was chosen by Dedy on
  2026-11-23, and points 2 to 7 accepted by him the same day. `${web.origin}` (context `webServiceEnv` in
  `src/templates.ts`), `WEB_PORT_MISSING`, `apis/keycloak` (Dockerfile, entry script, realm without users),
  `examples/keycloak`. Tested by the CLI scenarios `keycloak-generate` (golden files for both runtimes),
  `add-web-origin-outside` and `web-port-missing`, and end to end on Docker Compose (`e2e-oidc`, "the
  keycloak brick"): `up` returns once the realm answers, its issuer is `http://127.0.0.1:<webPort>/realms/plugbricks`,
  the realm has no user, a user created with the brick's generated administrator and given
  `plugbricks-admin` signs into `plugbricks admin` and gets an admin session. On k3d since 2026-11-23 (`e2e-k8s`, "requires Keycloak's tokens through the router and in orders itself"): the
  brick, its realm and its clients on a cluster, the issuer reached through a port-forward on its webPort, no token
  401 through the router, `orders-web`'s token 200 with `createdBy`, a pod calling `orders-app` directly 401
  without a token and 200 with one, and `orders-web`'s page reading the orders with its own token (about 5 minutes,
  most of it Keycloak's first start). The sign-in to `plugbricks admin` stays on Docker Compose only.
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
  `plugbricks admin` with that user (the flow of the D15 test). Not on k3d at first (the image is large and its
  first start long); the token scenario was added to the k3d job on 2026-11-23 (Status), which grew by about 5
  minutes for it.
- **Limits:** the realm file is applied on the first start only; the redirect URI assumes the admin on port
  4100; about 600 MB of memory; a first start of about two minutes. `add` picks the first port from 8080
  that this platform does not use, not one that is free on the machine: with another platform's web brick
  already on 8080, `up` failed with "Bind for 127.0.0.1:8080 failed: port is already allocated", and the
  webPort had to be changed in `platform.json` (true of every web brick, D17). Since 2026-11-23 `up` on
  Docker Compose reports it as `HOST_PORT_BUSY`, naming the port, what the platform publishes there and the
  `platform.json` field to change (`composeBusyPorts`, scenarios `up-compose-web-port-busy` and
  `up-compose-router-port-busy`; run against a real port held by another platform). A port held by a program
  of the host, which Docker reports as "listen tcp4 127.0.0.1:<port>: bind: address already in use", is
  reported the same way (scenario `up-compose-host-port-busy`, Docker's wording reproduced, not run against a
  real program). The realm has `sslRequired: external` (plain HTTP only from loopback and private addresses,
  which the browser on this machine and the containers are) and brute-force protection (a temporary lockout
  after 10 failures); a realm imported before keeps its old settings until it is changed in the console. The
  provision task refuses a client of the consumer's name it did not create (public, with a browser sign-in or
  without a service account), restores the audience mapper of one it did, and removes its kcadm session folder
  on exit; both paths are run against the real Keycloak of `e2e-oidc`.

---

## D19. Tokens in the data plane: the router requires a JWT when the platform has an `oidc` provider

- **Status:** accepted (2026-11-23), its assumptions verified the same day (below). Point 1 (optional
  requirements) implemented on 2026-11-23: `optional` in the manifest's `requires`, an optional requirement
  recorded in the lock without a provider (`{ "optional": true, wait, timeoutSeconds }`, the lock schema
  refusing one with both or neither), resolved by `buildPlan`, ignored by the refusals of `add`, `remove`,
  `disable` and `enable`, and shown by `status` as wired, not provided, or provider disabled. Tested by the
  CLI scenarios `optional-requires-no-provider`, `optional-requires-provider-later`,
  `optional-requires-provider-gone`, `lock-requirement-both` and `lock-requirement-neither`. Point 2
  (Keycloak provides `oidc`) implemented the same day: `provides.oidc` in `examples/keycloak` with
  `provision/create-client.sh`, and `orders-web` requiring `oidc` optionally (300 s). No secret goes on a
  command line: `kcadm.sh` reads the administrator's password from `KC_CLI_PASSWORD` and the client, with
  its secret, from standard input (`-f -`). Run on Docker Compose (postgres, keycloak, orders-web): `up`
  took 176 s, the provision 16 s; with only the variables injected into it, `orders-web` got a token at
  `http://keycloak-app:8080/…/token` with `iss=http://127.0.0.1:<webPort>/realms/plugbricks`,
  `aud=["plugbricks-router","account"]` and `azp=orders-web`; a second `up` (25 s) ran the provision again,
  which found the client and set its secret again. Tested by the CLI scenario `keycloak-provides-oidc`
  (golden files for both runtimes) and in `e2e-oidc` ("gives a brick that requires oidc its own client").
  Points 3 to 6 (the router requires a token, starts after the provider; `orders-web` sends its own)
  implemented the same day: the manifest's `oidc` block (`OIDC_NOT_PROVIDED` on a brick that does not provide
  the capability), `PlanRouter.auth`, `router.yaml` with `CONFIG_PATH` on both runtimes, its hash on the
  container and the pod, Compose `depends_on` the provider `service_healthy`, a `wait-oidc` init container on
  Kubernetes (300 s, `ROUTER_OIDC_WAIT_SECONDS`, added to the router's rollout deadline), and in `orders-web`
  a token cache (`src/token.ts`: renewed 30 s before it expires, one request shared by concurrent callers)
  and `/api/orders` for its "Refresh". Run on Docker Compose (postgres, keycloak, orders, orders-web): `up`
  took 188 s, the router started after Keycloak was healthy; through it, `createOrder` without a token got
  401, with `orders-web`'s token 200, and a real Keycloak token of the master realm 401; `orders-web`'s
  page listed the order. **Found on the way:** without the shipping brick, the composed schema has no
  `shipment` on `Order`, and the router refused the page's whole query ("Cannot query field "shipment" on
  type "Order""), so the page showed no order; it now asks again without that field and shows the shipment
  unavailable. Tested by the CLI scenario `router-requires-token` (golden files for both runtimes, with
  `router.yaml`), the unit tests of `apis/orders-web` (token cache, refresh, the fallback), and in
  `e2e-oidc` ("puts the router behind tokens"); the D17 web brick test without Keycloak still passes. Not
  on k3d, as D18. Point 7 (the admin finds the issuer) implemented the same day: `platformOidcIssuer` in
  `src/plan.ts` (the enabled brick that provides `oidc` and describes it, its web origin plus `issuerPath`,
  the same rule as the router's), used by `plugbricks admin` when `--issuer` is not given and announced on
  the terminal; `--client-id` stays required. Tested by `admin.test.ts` (present, disabled, absent), the CLI
  scenarios `admin-no-issuer` and `admin-issuer-no-client-id`, and the real sign-in of `e2e-oidc`, which now
  uses the issuer found in the platform. **D19 is implemented in full.** Chosen by Dedy on 2026-11-23: A1 (require a token only when
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
  token of another audience 401, the router starting only after Keycloak is ready. On k3d too since 2026-11-23
  (D18, Status).
- **Limits:** every request through the router then needs a token, the end-to-end tests' included; the
  subgraphs did not see who called when this was written (the router did not forward the token), which D20
  lifted: the router passes the token on and each API checks it; a client
  created for a consumer is not deleted when that consumer is removed. The router's wait for its provider is
  an init container on Kubernetes: `up` reports its timeout (exit 124) as `WAIT_TIMEOUT` after the first
  rollout slice, as for a service's waits (scenario `up-k8s-router-oidc-wait-timeout`). On Docker Compose,
  `--wait-timeout` gives the router the provider's chain plus its own start, also when no service waits for
  the provider (scenario `up-compose-router-oidc-wait`). A `WEB_PORT_MISSING` says what needs the webPort
  (an env of the brick, what a provider injects into a consumer, or the router's issuer), and offers
  "add it again" only for a brick that declares `web`.

---

## D20. The router passes the token on, and each API checks it itself

- **Status:** accepted (2026-11-23). Step 1 (points 1 and 2) implemented the same day: the propagate rule in
  `router.yaml`, `${provider.web.origin}` in the `inject` context only (`TEMPLATE_UNKNOWN` elsewhere,
  `WEB_PORT_MISSING` for a provider without a webPort), and `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE`
  injected by the Keycloak brick. Tested by the golden files of `router-requires-token` and
  `keycloak-provides-oidc`, and the scenarios `add-provider-origin-in-service-env` and
  `provider-origin-without-webport`; the propagate rule itself was run on the pinned router (below). Step 2
  (point 3) implemented on 2026-11-23: `src/auth.ts` in `apis/orders` and `apis/shipping` (the same file), with
  `jose` 6.2.16 pinned (MIT, no dependency; 6.2.18 was five days old, so the version before it, two weeks old,
  was taken), `createApp` taking the check as an option (401 with `WWW-Authenticate: Bearer` on `/graphql`
  without a valid token, `/health` open, the caller in the GraphQL context), and `orders` and `shipping`
  requiring `oidc` optionally (300 s). Tested by `test/auth.test.ts` in each API (a valid token; refused: none,
  malformed, `Basic`, expired, another issuer, another audience, no audience, no `sub`, another key,
  `alg: none`; the server's 401, a forged `X-User-Sub` refused, `/health` open), their full suites still
  passing, and in `e2e-oidc` with Keycloak: through the router `orders-web`'s token creates an order (passed on
  by the router, checked again by `orders`), and from a container of the platform calling `orders-app`
  directly, past the router, no token and a forged `X-User-Sub` both get 401, a valid token 200. Point 4
  (`createdBy`) implemented on 2026-11-23: a second migration of `orders` adds `created_by`, `createOrder` records
  the verified caller (`preferred_username`, else `sub`, from the token `orders` checked itself, never a header),
  and `Order.createdBy` is a nullable field of the schema, null without a token check. Tested in `apis/orders`
  (null without a check, the caller with one and a forged `X-User-Sub` ignored, on every read and through
  `_entities`, and a database created before the column upgraded with its orders kept), in `e2e-oidc` and on
  k3d (`createdBy` is `service-account-orders-web` through the router). An existing platform reports
  `FEDERATION_CHANGED` until `orders` is added again (D8). Chosen by Dedy on 2026-11-23: B (the router propagates the token,
  every API verifies it) over A (the router sets identity headers from the token's claims, the APIs trust them).
- **Context:** since D19 the router lets a request through only with a valid token, but the subgraphs behind it do
  not know who called, and they answer anything that reaches them: they are not published (D9), yet any container
  of the platform reaches them by name.
- **Observed on the router 0.372.0** (2026-11-23, the pinned digest, Docker 29.8.0: a fake subgraph named
  `orders-app` recording the headers it receives, a local JWKS, an RS256 token signed by the probe; the token check
  of D19 configured and required):
  - **By default nothing is passed on:** the subgraph got no `Authorization` and none of the caller's headers
    (a custom `X-Client` was dropped).
  - **`headers.all.request: [{ op: propagate, named: Authorization }]`** passed the whole token (`Bearer eyJ…`).
  - **`[{ op: set, name: X-User-Sub, expression: "request.auth.claims.sub" }]`** is accepted by this version and set
    the header to the token's `sub`; a caller sending its own `X-User-Sub: admin-forged` through the router saw it
    replaced by the claim.
  - **But a container of the platform calling the subgraph directly**, past the router, with
    `X-User-Sub: admin-forged` and no token, was answered (200), and the subgraph saw `admin-forged`: identity
    headers prove nothing to a service that cannot tell the router from any other caller. This is why B was chosen.
- **Decision:**
  1. **The router propagates `Authorization`** to every subgraph when it checks tokens (D19): one more rule in the
     `router.yaml` it already renders. Without an `oidc` provider there is no token and no rule.
  2. **What an API needs to check a token** comes with the `oidc` capability it requires (optionally, D19): the
     Keycloak brick also injects `OIDC_ISSUER` (the issuer the tokens carry, the provider's web origin plus its
     realm), `OIDC_JWKS_URL` (its keys, inside the platform) and `OIDC_AUDIENCE` (`plugbricks-router`, the
     audience of the tokens the router accepts). The issuer needs the provider's web origin in its `inject`, so
     that context gains `${provider.web.origin}` (`http://127.0.0.1:<the provider's webPort>`); it is refused
     anywhere else, and for a provider that is not a web brick (`WEB_PORT_MISSING` when it has no webPort).
  3. **`orders` and `shipping` require `oidc` optionally**, and when `OIDC_ISSUER` is set they refuse every
     GraphQL request without a valid token (`401`): signature (keys fetched from `OIDC_JWKS_URL`, kept and
     refreshed by the library), issuer, audience, expiry, RS256 only. `/health` stays open. Without
     `OIDC_ISSUER` they behave as today. The check uses `jose`, pinned to an exact version, rather than code of
     our own: it is the security-sensitive part, and a library that only does that is easier to trust. A
     **partial** configuration is refused at start-up: none of the three variables means no check, all three
     mean a check, and one or two make the API exit non-zero with a message naming the missing variables
     (never their values). The `Bearer` scheme is case-insensitive (RFC 7235); the router forwards the header
     unchanged.
  4. **They know who called:** `orders` records on each new order who created it, `createdBy`, from the verified
     token (its `preferred_username`, else its `sub`), and serves it as a nullable field of `Order`. Without a
     token check it stays null. The composed schema changes with that field, so an existing platform reports
     `FEDERATION_CHANGED` until `orders` is added again (D8).
- **Side effect:** requiring `oidc` gives `orders` and `shipping` their own Keycloak clients too (D19, point 2):
  unused for now, they are what these services would use to call another API in their own name.
- **Tests planned:** CLI scenarios with golden files (the propagate rule in `router.yaml`, the new variables, the
  new template refused elsewhere); unit tests of the check in each API (valid, expired, another issuer, another
  audience, another key, `alg: none`, missing); end to end on Docker Compose with Keycloak: through the router with
  `orders-web`'s token an order is created and `createdBy` is `orders-web`'s service account, the order and its
  shipment are read back across both subgraphs (the token reaches `shipping`'s `_entities` too), and a container of
  the platform calling `orders-app` directly gets 401 without a token and with a forged identity header. Not on
  k3d, as D18.
- **Limits:** the tokens of D19 live 300 s; a request is checked once at each hop, not again during it. A service
  of the platform holding a valid token (its own, from its client) can still call any API with it: what it may do
  there is authorization, a later decision (scopes or roles per field). The APIs check their OIDC configuration
  before they touch the database, accept the `Bearer` scheme in any case (RFC 7235), and refuse to start on a
  partial configuration.

---

## D21. `dependencies` in the manifest, and a panel in the admin that shows what a brick needs

- **Status:** accepted and implemented (2026-11-24).
- **Context:** `orders-web` cannot work without `orders`, which cannot work without PostgreSQL. Only the second
  link is in the manifests, as the capability `database`. `orders-web` reaches `orders` through the router, a
  link that is in its code and in no data: `requires` holds only `oidc`, and no capability stands for an API.
  The admin could not show it, and nothing says that removing `orders` breaks `orders-web`.
- **Decision:** an optional `dependencies` array in `plugin.json`, `[{ "plugin": "orders", "description": "..." }]`
  (`plugin` named like `extends.plugin`, `description` at most 200 characters, shown next to the link). The
  manifest refuses a plugin that lists itself (`SELF_DEPENDENCY`) or lists the same plugin twice
  (`DUPLICATE_DEPENDENCY`). `examples/orders-web` declares `orders`.
- **What is enforced:** `remove` (2026-11-24, at the user's request). `remove orders` is refused with
  `DEPENDENCY_IN_USE` while an installed brick, disabled ones included, lists `orders` in its `dependencies`; it
  comes after `CAPABILITY_IN_USE` and `EXTENDS_IN_USE`, which keep their precedence (one category is reported
  at a time). The admin shows the same refusal before a removal (`removeBlockedBy`). A name that matches no
  installed brick blocks nothing, so a misspelled declaration is harmless. The way out is the one the message
  gives: remove the brick that declares it first.
- **`disable` refuses too** (2026-11-24): disabling `orders` is refused with `DEPENDENCY_IN_USE` while an
  **enabled** brick lists it. A disabled brick does not run, so it does not block; `remove` keeps the stricter
  rule (disabled dependers included). The message says "cannot disable …; disable them first".
- **`enable` warns** (2026-11-25): enabling a brick whose declared dependency (not an optional one) is installed
  but disabled succeeds and prints `dependency "orders" is disabled; orders-web will not work until it is
  enabled`, as `add` does for a dependency that is not installed. It does not refuse: the bricks can then be enabled
  in any order, and the dependency is only needed when `up` runs. `disable` refuses because it would break a brick
  that runs now; `enable` only starts one that is not running yet. Scenario `enable-declared-dependency-disabled`.
- **What is not:** `add` warns, but does not refuse: adding a brick whose declared dependency is not installed
  succeeds and prints `dependency "orders" is not installed; orders-web will not work without it` (the panel's
  add action shows the same line, and the dependency graph flags the missing brick). `up` does not wait for a
  declared dependency (only a required capability is waited for).
- **The admin:** a click on a brick of the Bricks page opens a panel under the table with two tabs.
  *Dependencies*: the graph of everything the brick needs, transitively (capabilities, extended entities and
  declared links, the optional ones dashed, an arrow labelled with why), the list of those links in words, "needed
  first, in order" (each brick after its own dependencies), and "required by". A brick that is needed but not
  installed is drawn flagged, with a warning. *Details*: status, restarts, port, `provides`, `requires`, `extends`,
  what it needs, tags, page, and what would refuse its removal. The server sends each brick's direct links
  (`dependsOn`); the graph, the order and "required by" are computed in the browser, from that list.
- **An optional capability** with no enabled provider is not a link: nothing is wired, so nothing is needed.
- **Tests:** the manifest (valid example, two refusals with their codes), the scenarios
  `remove-declared-dependency` (refused, nothing changed, then removed in the right order; it fails when the
  check is turned off), `disable-declared-dependency` (refused while the declaring brick is enabled, allowed
  once it is disabled) and `add-declared-dependency-missing` (succeeds with the warning line, silent once the
  dependency is installed), the server's `dependsOn` and the refusal it shows for each of
  the five example bricks, with and without Keycloak (and a check that it fails when the manifest's links are not
  read), and the graph functions (layers, order, "required by", a missing brick, a cycle).
- **Not done:** editing `platform.json` from the panel; a registry of plugin versions (the mockup this came from
  had "Release", "Stored plugins" and "Add version": plugbricks has one installed copy per brick, no registry).
  The brick integrity hash covers `plugin.json`, so adding the field to an installed brick means `add` again.
- **Addendum (D22, 2026-11-25):** an entry can say `"optional": true`, and then `remove`, `disable` and the `add`
  warning above skip it (the brick works without its target; the admin shows the link as optional), and
  `"operations"` says which GraphQL operation classes the brick uses of its target, which decides the roles it is
  granted. The rules above are unchanged for an entry that says neither.

---

## D22. Authorization in the data plane: roles per operation now, field scopes later

- **Status:** accepted (2026-11-25); **step A is implemented, step B is not.** Proposed on 2026-11-24, accepted
  with the five recommendations of "Questions for the owner" as written. D20 left every valid token able to call
  every field; with an `oidc` provider and an `authorization` block, a valid token now also needs the role of the
  class of its operation. "Implemented" below says what was built and where it differs from the proposal; the
  rest of the entry is the proposal as it was accepted.
- **Context:** D19 gives every brick that requires `oidc` its own confidential Keycloak client, with a service
  account and a token of 300 s (Keycloak's default, observed in D19; `apis/keycloak/realm.json` does not set
  it); D20 makes the router require a JWT when the platform has an `oidc` provider, forward
  `Authorization` to the subgraphs, and each API (`apis/orders`, `apis/shipping`, the same `src/auth.ts` with
  `jose`, 6.2.16 when this was written and 6.2.18 now) verify issuer, audience, expiry, subject and RS256 itself, including on a direct call inside the
  network. `orders` records `createdBy` from that verified token (`preferred_username`, else `sub`), never from a
  header. The admin's `plugbricks-admin` / `plugbricks-viewer` roles are D15, for the admin process only: they are
  a different subject and are not reused here. The remaining hole is exactly D20's limit: a service of the
  platform holding a valid token can call any API and any field, and a field that needs more than "valid token"
  has no way to say so.
- **Verified while writing this** (2026-11-24, on this machine):
  - **Composition** (local, the pinned `@wundergraph/composition` **0.68.2**): two subgraphs with
    `extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key", "@requiresScopes",
    "@authenticated"])`, `@requiresScopes(scopes: [["orders:read"]])` on a query field and `@authenticated` on a
    mutation compose successfully; the federated AST keeps both directives, and the sha256 of the federated schema
    (the rule of `composeSubgraphs`, sorted definitions) **changes** when the directives are added. Without the
    import the composer also parsed the syntax, but what it does with it was not checked; the import is the
    documented form, and the one D22 uses.
    `buildRouterConfigFile` puts the directives in the router configuration (`engineConfig`); it has no separate
    `authorization` key. This is the router config the repository generates, not a run of the router.
  - **Router** (the pinned `ghcr.io/wundergraph/cosmo/router:0.372.0@sha256:bfe6d89a…`, D19): the
    [official Cosmo authorization-directives documentation](https://wundergraph.com/cosmo/security/authorization-directives)
    says `@authenticated` and `@requiresScopes` are evaluated by the router before execution, require Router
    0.60.0+ (0.372.0 is above it) and JWT authentication; the router
    configuration documentation gives `authentication.jwt.scope_claim` (default `scope`) for providers that put
    scopes in another claim, and `authorization.require_authentication`. The pinned image was **not** run with
    these directives: that runtime behaviour is **NON VÉRIFIÉ** here (only the composition and the generated
    configuration were exercised).
  - **Keycloak** (local, disposable container, `quay.io/keycloak/keycloak:26.7.3`, the realm fixture): a
    service-account client `svc` with `client_credentials` got a token with
    `preferred_username: "service-account-svc"`, `azp: "svc"`; a **realm role** `orders:read` assigned with
    `kcadm add-roles --uusername service-account-svc --rolename orders:read` appeared in
    `realm_access.roles`; a **client role** `orders:read` under a client `orders-api` assigned with
    `--cclientid orders-api --rolename orders:read` appeared in `resource_access["orders-api"].roles`; a
    **client scope** `orders:read` assigned with `kcadm update clients/<id>/default-client-scopes/<scope-id>`
    appeared in the `scope` claim (`"orders:read email profile"`). The token was 1342 characters with those
    roles and the scope; the service account also carries Keycloak's `offline_access`, `uma_authorization` and
    `default-roles-plugbricks`. The token audience was `["orders-api", "account"]`; the D19 audience mapper would
    add `plugbricks-router` (not measured with it). The container and its data were removed after the test.
  - **The API check** (read in `apis/orders/src/auth.ts`): `jwtVerify` returns the payload, but `Caller` keeps only
    `subject`, `name` and `client`; no role or scope is read today. The same file is in `apis/shipping`.
- **The seven questions, per option:**

  | Question | A — roles per operation | B — field or operation scopes | C — A now, B later |
  |---|---|---|---|
  | 1. Where applied | In each API, after its token check; the router stays authentication-only. A direct call is covered (D20's test). | In the router (the documented directives) **and** in each API; the router alone loses the direct-call case D20 proved. | A now; B adds the router and keeps the API check. |
  | 2. Where declared, who decides | A new optional `authorization` block in the brick's `plugin.json`: the author declares the roles for its operation classes; the operator assigns those roles in Keycloak. No `platform.json` override now. | Directives in the brick's `schema.graphql` (`@authenticated` / `@requiresScopes`): the author declares; the operator assigns client scopes. | A now; B later in the schema, same author/operator split. |
  | 3. How the role arrives, token size | Client roles under the API's own client (the one D19 already gives it): `kcadm add-roles --uusername service-account-<consumer> --cclientid <api> --rolename <role>`; the token shows `resource_access.<api>.roles`; audience mapper unchanged; a few short strings (the local sample 1342 chars). | Client scopes named like the scopes, assigned to the consumer's client; the token shows them in `scope` (the local sample); the router reads `scope` by default; the token stays small. | A now; the same names can become scopes for B. |
  | 4. Composition, hash, router config, installed bricks | No schema change: no federated hash change, no `FEDERATION_CHANGED`; the router config does not change. The brick integrity changes because `plugin.json` changes: the brick must be `add`ed again; the plan injects the authorization values into its env, so the generated Compose/k8s files change. | The directives compose (verified) but change the federated schema hash: `FEDERATION_CHANGED` until the brick is `add`ed again (D8); `router-config.json` and the goldens change; the router config carries the directives. | A now; B only when it is wanted, with its hash change. |
  | 5. No `oidc`; valid token without the role | Without `oidc`: nothing changes. With `oidc` and the block: the API refuses (new `FORBIDDEN` code; the HTTP status is **NON VÉRIFIÉ**) the operation class whose role the token lacks (the token is valid, so not 401); without the block it keeps D20. | Without `oidc`: nothing changes. With `oidc`: the router refuses the protected field (partial data when nullable, null data when not) and the APIs refuse too; a valid token without the scope is refused; `@authenticated` only asks for a valid token. | A now; B later. |
  | 6. `createdBy`, service-to-service | Unchanged: the callee sees the calling service's `preferred_username` (`service-account-<client>`) and records it; the role is not an identity. A service calling another uses its own service role; the end user is not propagated. | Same; the scope does not change identity. | Same. |
  | 7. Tests | Manifest/`plugin.json` schema, CLI goldens (the injected env, no `FEDERATION_CHANGED`), API unit tests (role present/missing, query vs mutation, direct call, `/health`, `createdBy`), Compose Keycloak e2e (read allowed, write without role refused, direct call refused), k3d (planned). | The same plus composition/hash/router-config goldens, the router e2e for the directives (only once the pinned router is exercised), the API enforcement, the scope claim, the field-level cases; k3d. | A first; B adds the second row. |

- **Decision: C, in two stages. A now; B when a field needs more than the operation class.** Step A is built (see
  "Implemented"); points 6 (B) and the router-side parts are not.
  1. **Now A: one role per operation class.** Each API brick that wants authorization declares an optional
     `authorization` block in its `plugin.json`, for example
     `{ "queries": "orders:read", "mutations": "orders:write" }` for `orders` and
     `{ "queries": "shipping:read" }` for `shipping`. The names are client roles under the API's own Keycloak
     client (D19 already gives every consumer, including the API itself, its own client). A brick without the
     block keeps D20: a valid token is enough. The examples `orders` and `shipping` declare theirs.
  2. **The API is the enforcement point.** After its existing token check, each API reads its own block (the plan
     injects it into the API's service environment, next to the `OIDC_*` variables; the exact variable names are
     an implementation detail) and requires the role for a query or a mutation before the resolver runs; a token
     without it gets a new GraphQL error with the code `FORBIDDEN` and nothing is executed. The APIs use only
     `BAD_USER_INPUT` today (`apis/orders/src/app.ts`, `apis/shipping/src/app.ts`); `FORBIDDEN` exists only in the
     admin's own HTTP API (`packages/plugbricks/src/admin/server.ts`), which is D15. Whether the HTTP status of
     that answer can be set to 403 with the pinned GraphQL server is **NON VÉRIFIÉ** and is settled when it is
     implemented. `/health` stays open. The router
     keeps authentication only in A: it is not given a role rule to enforce, so a direct call inside the network is
     still covered by the API itself, as D20 requires. A partial authorization configuration on an API that has
     `oidc` refuses at start-up rather than silently opening the class.
  3. **The author declares, the operator assigns.** The `plugin.json` block is the brick author's contract: which
     role an operation class needs. The platform operator decides which consumer's service account gets that role
     in Keycloak; no `platform.json` override is built in A. This keeps the policy reviewable with the brick
     (integrity hash) and the actual grants in Keycloak.
  4. **Keycloak carries the roles on the service account.** `create-client.sh` (D19) already creates the
     consumer's confidential client, its service account, its secret and the router audience mapper. It gains a
     role list (computed from the consumer's declared dependencies and the targets' `authorization` blocks, or
     supplied by the operator; the exact wiring is part of the implementation) and calls
     `kcadm add-roles --uusername service-account-<consumer> --cclientid <target-api-client> --rolename <role>`
     for each; the token then has `resource_access.<target-api-client>.roles`. Client roles are preferred over
     realm roles: they are scoped to the API and cannot be confused with another API's role; the local test
     verified both forms. The audience mapper and the lifetime do not change, which also means that a role removed in Keycloak stays in
     every token already issued until it expires (see the Limits). The token grows by the role
     strings only; the local sample was 1342 characters with roles and a client scope, which is not a concern.
  5. **What an installed platform sees.** In A, only `plugin.json` changes: the brick's integrity changes, so it is
     `add`ed again; the federated schema hash does not change, so there is no `FEDERATION_CHANGED`; the router
     configuration does not change; the plan injects the authorization values into the API's env, so the generated
     Compose and Kubernetes files change and the goldens follow. The consumer's role grants are applied by the
     provision task on the next `up` (it is idempotent). In B, the schema changes: the federated hash changes,
     `FEDERATION_CHANGED` appears until the brick is `add`ed again, and `router-config.json` and the goldens
     change.
  6. **Later B: field scopes.** When a field (or a type) needs finer control than "all queries" or "all mutations",
     the brick's `schema.graphql` gains `@authenticated` and/or `@requiresScopes(scopes: [["orders:read"]])`
     (the v2.5 `@link` import; the composer passes them, verified with 0.68.1). The router documents their enforcement
     (Router 0.60.0+, JWT authentication; the pinned 0.372.0 is above it) and the APIs must enforce the same
     declarations too, because a direct call bypasses the router: B is a router **and** API change, not a
     router-only one. Keycloak supplies the scopes as client scopes, so they appear in the `scope` claim (verified
     with the local container); the router's default `scope_claim` is `scope`. The names can be the same strings
     as A's roles. The schema change brings `FEDERATION_CHANGED`, a new `router-config.json`, the field-level
     partial/null semantics, and the goldens. The trigger is a concrete field that A's operation class cannot
     express, not a wish for granularity.
  7. **No `oidc`, and a valid token without the role.** Without an enabled `oidc` provider there is no token, no
     `authorization` block is injected, and every API behaves exactly as today (D19/D20's rule). With `oidc`: a
     token that is valid but lacks the role of the operation class is refused (`FORBIDDEN`) and the resolver does
     not run; a
     query with `orders:read`, a mutation with `orders:write`; the same token can still read the public `/health`.
     A brick that does not declare the block stays at D20 (any valid token), which is the deliberate opt-in; the
     examples declare it so the e2e can prove the refusal.
  8. **`createdBy` and a service calling a service.** `createdBy` keeps recording the verified caller's
     `preferred_username`, else `sub`: in the data plane that is the calling service's account
     (`service-account-orders-web`, verified in the local Keycloak token), never the end user, because the
     platform does not propagate a user token today. The role (or scope) is an authorization attribute of that
     service account, not an identity: a service that calls another in its own name is authorized by its own
     service role, and the callee sees the service's name. Delegating a user and recording the user is a later
     decision, tied to user tokens (D15's admin login is not that).
  9. **What does not change.** The admin's two roles and its OIDC login (D15); the optional `oidc` requirement and
     the no-provider path; the router's authentication (issuer, audience, RS256, JWKS); the token lifetime; the
     `createdBy` field; the direct-call 401 without a token; the health endpoints. Authorization does not turn a
     missing token into a role check: 401 stays 401, and "valid token, not allowed" is the new `FORBIDDEN`.

- **Implemented (step A, 2026-11-25), and where it differs from the proposal:**
  - **Manifest.** `authorization: { "queries": "<role>", "mutations": "<role>" }`, at least one class, roles of
    lowercase words joined by `:` `.` `_` `-` (64 characters at most). It needs a `subgraph` (`DEPENDENT_FIELD`) and
    `requires.oidc` (`AUTHORIZATION_WITHOUT_OIDC`). A class left out stays at D20.
  - **Who gets which role (not specified in the proposal).** The roles a consumer's service account holds come
    from its `dependencies`, and each entry says what it does with its target: `"operations": ["queries"]` by default,
    `["queries", "mutations"]` to write too. A consumer gets exactly the roles of the classes it lists, never all of a
    target's. `orders-web` lists `orders` and `shipping` and holds `orders:read` and `shipping:read` only. A grant
    never comes from a block the consumer did not name; the operator can still add any role in Keycloak.
  - **An optional dependency (new).** `orders-web` shows the shipment when `shipping` is installed and works
    without it, so listing `shipping` as a hard dependency would have been false (`remove shipping` refused, a
    warning at every `add orders-web` without it). A dependency can say `"optional": true`: it is shown as optional by the
    admin, protects nothing (`remove`, `disable`, the `add` warning of D21 skip it), and its operations are still granted
    when the target is installed and has a block.
  - **Plan.** With an enabled `oidc` provider in the plan, a brick with a block gets `AUTHORIZATION_QUERIES_ROLE`
    and `AUTHORIZATION_MUTATIONS_ROLE` in its env (only the classes it names), next to the `OIDC_*` variables. The
    client the roles belong to is the one in `OIDC_CLIENT_ID`, not a new variable. The provision env of the
    provider can use two new templates: `${consumer.roles}` (the roles of the consumer's own block) and
    `${consumer.grants}` (`<brick>/<role>` for each role to grant, sorted); both are empty when there is nothing, so
    every consumer of `examples/keycloak` now has `ROLES` and `GRANTS` in its provision env (the goldens of the
    scenarios with keycloak changed for that reason, and the brick must be added again: its `plugin.json` and
    script changed). A dependency counts only when it is installed, enabled, has a block and is itself wired to an
    `oidc` provider. Without a provider, no variable, no task: unchanged, as D19 and D20 (a scenario proves it).
  - **Keycloak.** `create-client.sh` creates the roles of `ROLES` on the consumer's own client and gives its service
    account each `GRANTS` entry (`kcadm add-roles --uusername service-account-<consumer> --cclientid <brick>
    --rolename <role>`). A target client that does not exist yet is created in the same shape (the consumer's task can
    run before the target's), and the target's own task then finds a client it could have made. Nothing is ever
    removed. The client id of a brick is its name: `OIDC_CLIENT_ID` and the `<brick>/` of a grant rely on it, so
    another `oidc` provider must follow the same rule to use `authorization`. Tried on Keycloak 26.7.3: the token of a
    granted service account carries `resource_access.<brick>.roles`, a second run changes nothing, and `expires_in` is 300.
  - **A race found by the end-to-end test.** The consumer's task (granting itself `orders:read`) and `orders`'s
    own task (creating the role) can create the same role, or the same client, at the same moment: the loser stopped
    the whole `up`. In a parallel trial of 12 runs, 6 failed; with the fix (a failed creation is fine when the object
    exists afterwards), 0 of 12 failed.
  - **APIs.** The shared `auth.ts` (identical in `orders` and `shipping`, a test keeps it so) reads `resource_access`
    into `Caller.roles` (anything that is not a list of strings is ignored; `realm_access` and `scope` do not count)
    and a Yoga plugin refuses an operation before any resolver when the caller lacks the role of its class: GraphQL code
    `FORBIDDEN`, **HTTP 403** (verified with `graphql-yoga` 6.1.0 and `graphql` 17.1.0, the versions of this
    repository; the proposal marked the status NON VÉRIFIÉ). The message names the role, not the token. `_entities` and
    `_service` are queries, so the router's entity calls need the read role too: a consumer that reads shipments through
    `orders` needs `shipping:read`, which is why `orders-web` lists `shipping`. The operation is the one the request
    selects (`operationName`), not the first of the document. A subscription is refused. The roles without the token
    check (`OIDC_ISSUER`) or without `OIDC_CLIENT_ID` stop the API at start-up.
  - **A warning at `add`** (the recommendation of question 3): a GraphQL API that requires `oidc` and has no block
    prints that any valid token can call it. It is added all the same.
  - **Not built, as proposed:** the router does not enforce the roles (APIs only, question 4); no `platform.json`
    override; step B (field scopes, `@authenticated` / `@requiresScopes`); the admin does not show the roles; user
    tokens and delegation.
- **Alternatives:**
  - **A alone, as the end state.** The smallest change, no schema/hash churn, no router configuration change,
    all enforcement in the APIs. It closes the limit at operation granularity. It was not chosen as the end
    state because a field with a different audience (a price, a customer's address) would need a new operation
    or an operation-wide role; B is the escape hatch, and C keeps A's work (the roles can become scopes).
  - **B alone, now.** Field-level scopes from the start. It requires changing the schemas (hash, re-add,
    goldens), relying on the router's directive enforcement (documented for 0.60.0+, not run against the pinned
    0.372.0 here) **and** implementing the same checks in each API, plus the client-scope assignment in Keycloak.
    That is more moving parts than the example needs today, and the router-only shortcut is exactly what D20
    rejected: a direct call would still pass.
  - **Router-only (A or B at the router).** Rejected by D20's direct-call test: any container of the platform can
    call `orders-app` by name, past the router. Identity headers (`X-User-Sub`) were rejected for the same reason.
  - **Identity headers derived from the token.** Rejected in D20; not revived here.
  - **C (chosen).** A now gives a complete, small rule at the API boundary; B is a later, additive refinement
    with the schema and the router, triggered by a real field.

- **In the admin (2026-11-25).** `GET /api/bricks` gives each brick an `authorization` object, and the Details tab shows it
  on two rows. `state` is `roles` (the API enforces what the row lists; a class left out reads "any valid token"), `open`
  (it serves a subgraph and requires oidc but declares no roles: "any valid token may call it", the case the `add`
  warning names) or `none`; `grants` lists the `<brick>/<role>` its service account is given. The values come from the
  manifests, and the grants from the plan (`Plan.authorization`), which also renders the provision task's `ROLES` and
  `GRANTS`, so what the page shows and what Keycloak receives cannot differ. It shows what the platform asks for, not
  what Keycloak holds now: a grant made by hand, or one that was never taken back (see Limits), does not appear.
- **Tests (step A, run 2026-11-25):** manifest schema and cross-checks (six invalid fixtures, the examples), the plan
  (roles in the env and in the provision env, no oidc, grants per operation, a dependency that is missing, open or without
  oidc), CLI scenarios with goldens (`authorization-roles`, `authorization-without-oidc`, `optional-declared-dependency`,
  `add-open-api-warning`), the APIs (`apis/orders` 31 tests, `apis/shipping` 17: roles of a token, 401 and 403, per class,
  `_entities`, the operation chosen by name, nothing reaches the database on a refusal, a mutation of the three of them
  each broken on purpose in the code and caught), the Compose end-to-end with a real Keycloak (6 tests: the token carries `orders:read`
  only, `orders-web` reads and is refused a mutation, 403 on a direct call, then `kcadm add-roles` and a new token
  creates the order with `createdBy`; the earlier token keeps its roles) and the k3d end-to-end of the same flow (1 test,
  on a throwaway cluster, deleted afterwards). **Not run here:** the other eight k3d tests (they have no `oidc`
  provider and the plan does not change for them), and `shipping` in the Keycloak end-to-end (its roles are tested in its unit
  tests and in the plan, not against a real token).
- **Tests planned (the proposal, kept for step B):** For A: the manifest schema and validation of the `authorization` block (a valid example, a
  missing/unknown role, a partial block), CLI scenarios with goldens (the injected env, the generated Compose/k8s,
  no `FEDERATION_CHANGED`, the `add` re-integrity), unit tests in `apis/orders` and `apis/shipping` (a token with
  the role, without it, the wrong role, a query vs a mutation, the direct call, `/health`, `createdBy`), and the
  Compose Keycloak e2e: `orders-web` with `orders:read` and `shipping:read` reads the page, a consumer without
  `orders:write` is refused a mutation, a direct call to the API with the role is 200 and without it refused (`FORBIDDEN`), and the
  no-`oidc` platform is unchanged. The k3d e2e repeats the token and direct-call cases (planned; the 9 k3d tests
  are skipped without a cluster, as today). For B: the composition and `router-config.json` goldens, the schema
  hash/`FEDERATION_CHANGED`, the router e2e for `@authenticated`/`@requiresScopes` (only once the pinned router is
  actually run with them), the API-side enforcement of the same directives, the scope claim from Keycloak, the
  partial/null cases, and the field-level tests; not before A. **Not tested now:** anything in this entry, the
  router's directive enforcement, the B API enforcement, the role/scope assignment in the real provision script,
  the user-token path, and k3d (no cluster).
- **Limits:** **A grant is never taken back.** The provision task only adds: removing a brick from `dependencies`,
  changing `operations`, or renaming a role leaves the old grant and the old role in Keycloak until someone removes
  them in the console, and grants are applied when the task runs (`up`), not when `plugin.json` changes. **A token issued
  before a grant does not have it** (the roles are in the token): the next one does. **Revocation is not immediate.** The API checks the token, not Keycloak: a role removed from a
  service account (or a service account disabled) stays valid in every token already issued until its `exp`, 300
  s with Keycloak's default, and nothing in A or B shortens that window; shorter tokens or introspection would be
  a separate decision. **The block is an opt-in.** A new API that requires `oidc` but forgets the `authorization`
  block stays at D20 (any valid token) without any warning; making the block mandatory when a platform has an
  `oidc` provider, or warning at `add`, is not decided here (question 3: the warning at `add` is built, the refusal is not). A is per operation class, not per field: `orders:read` reads every query field of `orders`, and a
  service that holds it can read more than one field; B exists for the finer case. The data plane has only
  service accounts today: the caller is the service, `createdBy` records the service, and there is no end-user
  identity; user tokens and delegation are later. The router does not enforce A; the APIs do, so a compromised
  API container or its token is still a service-level grant. The roles/scopes live in Keycloak; the operator's
  grants are the real policy switch, the `plugin.json` block is the author's requirement, and a
  `platform.json` override is not built. The audience mapper and the token lifetime are unchanged; the token
  gets a few role strings (the local sample 1342 characters). B depends on the router's documented directive
  behaviour and on each API enforcing the same declarations; the pinned router was not run with them, the
  schema hash changes, and the existing bricks need `add` again. The admin's roles (D15) and the data plane are
  separate. Kafka is unrelated.
- **Questions for the owner:**
  1. Does one role per operation class (`orders:read` / `orders:write`, `shipping:read`) suffice for the
     `orders` / `shipping` / `orders-web` example, or does a field already need its own scope now? Recommendation:
     A now, B only when a real field needs it.
  2. Do the roles and scopes come from Keycloak service accounts only, or should D22 also plan for a generic OIDC
     provider and for user tokens, and should a service calling another decide with its own role or, later, the
     end user's? Recommendation: Keycloak service accounts and the calling service's own role now; user tokens
     and delegation later.
  3. Who owns the policy: the brick author declares the required roles in `plugin.json`, the operator assigns
     them in Keycloak; should the operator also be able to override the requirement in `platform.json`, and
     should the block be mandatory (or at least warned about at `add`) when the platform has an `oidc` provider?
     Recommendation: author declares, operator assigns, no override now; a warning at `add` when an API that
     requires `oidc` has no block, to be decided with the implementation.
  4. Should the router also enforce the roles/scopes as defence in depth, or only the APIs? Recommendation: the
     APIs only in A; the router too in B, once the pinned router is verified with the directives.
  5. Is a revocation window of up to 300 s acceptable, given that the APIs check the token and not Keycloak?
     Recommendation: yes for the examples, stated as a limit; shorter tokens or introspection only if a real
     case needs immediate revocation.

---

## D23. The licence is Apache-2.0

- **Status:** implemented (2026-11-25).
- **Decision:** plugbricks, `create-plugbricks` and the admin are under the Apache License 2.0. The text is the standard,
  unmodified one (`LICENSE` at the root and in each published package, where npm ships it); `NOTICE` carries the
  copyright line and is listed in the `files` of both published packages. Every `package.json` says `Apache-2.0`.
  Nothing else changes: the packages stay `"private": true` until the publication steps of
  `docs/pre-publication-checklist.md` are done.
- **Why Apache-2.0 and not MIT:** an explicit patent licence, which an infrastructure tool that a company installs is
  expected to carry; it is the licence of `@wundergraph/composition` (D8), which the tool depends on, so the project does
  not mix two families; every other dependency of the composer is MIT or 0BSD, which Apache-2.0 accepts.
  A source-available licence (AGPL, BSL, Elastic) was not wanted: it is meant to stop a third party from selling the
  tool as a service, which is not an aim here, and Elastic-2.0 was already ruled out for a dependency (D8).
- **The copyright holder** in `NOTICE` is the GitHub account that owns the repository, `rudney5000`. It is one line, in
  three identical files (the root and the two packages), and can be changed to a person's name.
- **Not done here:** the notices of the third-party code inside the admin bundle (see the checklist), and whether the
  author's employment terms allow the licence: only the author can check that.

---

## D24. How the packages are published: 0.1.0, from a tag, by the CI, under `next` first

- **Status:** prepared (2026-11-25), nothing published yet. The first publication is the owner's step: see "Before the
  first publish" below.
- **Version.** `plugbricks`, `create-plugbricks` and the admin are `0.1.0`: usable, with a CLI, a manifest and a lock
  that may still change in a minor version (0.x). `create-plugbricks` asks for `plugbricks` at exactly the same version,
  and the project it creates does the same, so the two packages are published together, `plugbricks` first.
- **Where from.** `.github/workflows/publish.yml`, on a tag `v<version>`. It refuses a tag that disagrees with the three
  versions, and a commit that is not on `main`. It builds the admin, runs the test that packs the package as npm would
  and runs it from the unpacked archive, then publishes with a **provenance** statement (the package is tied to this
  repository and this commit). A person's machine needs no right and holds no token. `publishConfig.provenance` is meant
  to make a local `npm publish` fail too, since npm only generates provenance in a supported CI; that was not
  tested (a `--dry-run` does not exercise it, and succeeds).
- **Under `next` first.** The workflow always publishes with `--tag next`: `npm install plugbricks@next`. Promoting a
  version is a hand step, `npm dist-tag add plugbricks@<version> latest`, once the real
  `npm create plugbricks@next` has been tried. A published version can be removed within 72 hours only, and its name and
  number are never reused.
- **Notices.** The admin bundle contains React and what it depends on (MIT): `prepack` writes
  `dist/admin/THIRD_PARTY_NOTICES.txt` from the installed packages, and the `dist` test requires it, with `LICENSE` and
  `NOTICE`, in the archive.
- **Before the first publish (the owner):** an npm account with two-factor authentication; a token stored as the
  repository secret `NPM_TOKEN` (a granular token that can publish; while the packages do not exist yet it cannot be
  limited to them, so narrow it after the first publish, or move to npm's trusted publishing once the packages
  exist); an `npm` environment in the repository settings, with the owner as a required reviewer, so that no tag
  publishes without an approval; the names checked again; the employment terms checked (D23).
- **Not decided here:** the example bricks. The archive does not carry them, so a visitor has nothing to `add`
  (checklist). `create-plugbricks` copying them into a new project is the next step: done in D25.

## D25. `add` by name, from the project's `bricks/` folder; a new project gets three bricks there

- **Status:** implemented (2026-11-25). Step 1 of section 2 of `docs/roadmap.md`.
- **Context:** a new project had no brick to add: the published packages carry no example (D24), and the README
  said "point `add` at a brick folder of the plugbricks repository". The roadmap asks for `plugbricks add postgres`,
  with the project's own folder as the catalogue, and no catalogue to host.
- **Decision.**
  - **A name or a path.** An argument of `add` that follows the brick name rule (`^[a-z][a-z0-9-]{0,38}[a-z0-9]$`:
    no `/`, no `.`) is a name; anything else is a path, as before.
  - **Where a name is looked for.** In `bricks/<name>` of the platform (`--dir` when given, not the current folder),
    then in the folder `<name>` where the command was typed. The second is what `add postgres` meant before this
    decision, and what about sixty calls of the end-to-end tests rely on (they copy `examples/postgres` to
    `./postgres`); it stays.
  - **Nothing picked silently.** When both hold a brick (and are not the same folder), `add` refuses with
    `BRICK_NAME_AMBIGUOUS` and asks for `./<name>` or `bricks/<name>`. When neither does, `BRICK_NOT_IN_FOLDER` says
    what `bricks/` holds, or that there is no `bricks/`.
  - **The folder is named after the brick.** A brick taken from `bricks/<name>` must have `"name": "<name>"`
    (`BRICK_NAME_MISMATCH`): otherwise `add postgres` would install another name, and `remove postgres` would fail.
    A path keeps any folder name. The lock records the source as usual, `bricks/postgres`.
  - **Three bricks in a new project.** `create-plugbricks` ships `bricks/postgres`, `bricks/rabbitmq` and
    `bricks/nats`, the example bricks whose images are public on Docker Hub. They are copies of
    `packages/plugbricks/examples/`, kept in `packages/create-plugbricks/template/bricks/`; a test of
    `create-plugbricks` fails when a copy differs from its example, file by file. Their provision scripts are run
    as `/bin/sh <script>`, so the executable bit, which `npm pack` drops, does not matter. `services/orders` stays
    where it was: it is the person's own code, added by path, and its image is a placeholder.
- **Tested.** CLI scenarios `add-by-name` (golden files, the source `bricks/<name>`, adding again unchanged),
  `add-by-name-not-in-folder`, `add-by-name-here`, `add-by-name-ambiguous`, `add-by-name-mismatch` and
  `add-by-name-dir`; `create-plugbricks`: the structure, the copies equal to the examples and valid, the README,
  `add postgres` by name in the new project, and the packed generator.
- **Not done here.** The admin's "add" takes the same argument (it runs the CLI) but does not list `bricks/`; adding
  what a brick needs, with confirmation, is the next step of the roadmap (section 2, step 2).

## D26. `add` proposes what a brick needs from `bricks/`, and adds it only with the person's agreement

- **Status:** implemented (2026-11-25). Step 2 of section 2 of `docs/roadmap.md`; it builds on D25.
- **Context:** `add orders` on a platform without a database was refused (`REQUIRED_CAPABILITY_MISSING`), and the
  person had to find which brick provides `database`. With D25, the project's `bricks/` folder says what can be
  added. D21 records what a brick declares it needs besides its capabilities (`orders-web` needs `orders`).
- **Decision.**
  - **What is proposed** (`src/needs.ts`): for each capability the brick requires (not the optional ones, D19) that
    no installed brick provides, the brick of `bricks/` that provides it; for each plugin it declares in
    `dependencies` (not the optional ones) and that is not installed, `bricks/<plugin>`; and, in turn, what those
    need. Each brick comes after what it needs. Never the other way round: `add orders` never proposes `orders-web`.
    Only the valid bricks of `bricks/` whose folder carries their name are proposed (as `add <name>`, D25).
  - **Required or declared.** A proposed brick is *required* when the brick asked for cannot be added without it:
    it provides what that brick requires, or what such a required brick requires. One reached only through a
    declared dependency is not (D21 made a missing dependency a warning, not a refusal).
  - **Asking.** In a terminal (`bin.ts`: file descriptors 0 and 1 are both terminals) `add` lists the bricks with
    why, then asks `Add … too? [y/N]`; only `y` or `yes` agrees. `--yes` (`-y`, `add` only) agrees in advance and
    asks nothing. Otherwise nothing waits: a CI, a pipe, and the admin's actions, which run the CLI as a child
    process.
  - **Without agreement.** When one of the proposed bricks is required: `ADD_NEEDS_CONFIRMATION` without a
    terminal (the message ends with the command to run again, `plugbricks add <same argument> --yes`, with `--dir`
    when it was given), `ADD_NOT_CONFIRMED` when the person said no; nothing is written. When none is: the brick is
    added alone, with the warning of the missing dependency and the command that adds them too.
  - **Several providers.** When several bricks of `bricks/` provide a capability, the person chooses: in a terminal
    `add` asks which one (three tries; an empty answer cancels), with `--yes` or without a terminal it refuses
    (`CAPABILITY_PROVIDER_CHOICE`, naming the candidates and `plugbricks add <the first>` as an example). Nothing is
    picked silently.
  - **When nothing can be proposed.** A need that no brick of `bricks/` meets, a brick that would be refused, or
    another brick of the same name installed: `add` proposes nothing and says what it said before.
  - **A brick already installed as it is** still gets what it lacks. The warning line says
    `plugbricks add orders-web --yes` adds the dependency too, so that command must work on an installed
    `orders-web`.
- **Writing.** The bricks are added one by one with the same checks as any `add`, in one run under the platform lock
  (D16). If one is refused on the way (a composition error, say), the ones before it stay added, each a valid platform,
  and the output lists them.
- **Tested.** Unit tests of `planNeeds` (`test/needs.test.ts`: order, required or declared, a cycle of declared
  dependencies, optional needs, choices, unmet needs and bricks skipped). CLI scenarios `add-needs-yes` (golden
  files), `add-needs-no-terminal`, `add-needs-dependency-only`, `add-needs-asked`, `add-needs-declined` and
  `add-needs-choice`, with a step field `answers` for what the person types. By hand in a pseudo-terminal (`script`):
  the choice between `nats` and `rabbitmq`, then the confirmation, then the order of the adds.
- **Not done here.** The admin cannot answer: an add from the admin that needs another brick is refused with the
  command to run. The `$schema` of the bricks copied into a new project (D25) was the relative path of the
  repository, which an editor cannot resolve there; since 2026-11-25 the copies carry the published URL
  (`MANIFEST_SCHEMA_ID`), and the test that compares them with the examples ignores that one line.

## D27. The example APIs are named `orders-api` and `shipping-api`, like `orders-web`

- **Status:** implemented (2026-11-25), at the owner's request, before the first publication.
- **Context:** the examples were `orders`, `shipping` and `orders-web`. Next to `orders-web`, `orders` read as "the
  orders brick" rather than "the orders API", and `plugbricks create <name> --kind api|web` (roadmap, section 2, step 3)
  will name new bricks `<name>-api` and `<name>-web`: our own examples should follow the convention they teach.
  Nothing is published yet, so a rename breaks only our tests.
- **Decision.** The bricks `orders` and `shipping` are now `orders-api` and `shipping-api`, on the model of `orders-web`:
  the brick name, its folder in `packages/plugbricks/examples/`, its source in `apis/`, its image
  (`plugbricks-example/orders-api:0.1.0`, `plugbricks-example/shipping-api:0.1.0`) and its npm package name.
  `shipping-api` extends `orders-api`; `orders-web` declares both. The service `services/orders` of the project
  template is `services/orders-api` too. `postgres`, `keycloak`, `rabbitmq`, `nats` (infrastructure) and
  `queue-consumer` (a worker) keep their names.
- **What follows from the brick name, and changes with it:** the runtime names (`orders-api-app`,
  `orders-api-wait-database`, …), the database and role of each API (`orders-api`, quoted as an identifier by the
  provision script), the secrets (`PB_POSTGRES__ORDERS_API__CONSUMER_PASSWORD`), the Keycloak client (`orders-api`)
  and the grants of a caller (`orders-api/orders:read`).
- **What does not change:** what the APIs serve and the roles they declare. The GraphQL fields (`orders`, `Order`), the
  tables and the roles (`orders:read`, `orders:write`, `shipping:read`, `shipping:write`) name the domain, not the brick.
  The unit tests that build their own bricks (`plan`, `needs`, `federation`, the admin's `lib`) keep their own names.
  The decisions above keep the names they had when they were written.
- **For a platform already running the old names:** `remove orders` (and `shipping`) then `add orders-api`; the new API
  gets a new database, so the old orders are not carried over. This only concerns our own test platforms.
- **Not done here:** the screenshots of the README show the old names; they will be taken again with the next change
  of the admin. (The admin's screenshots were taken again on 2026-11-27.)

## D28. `plugbricks create <name> --kind api|web`: the brick in `bricks/`, its code in `services/`

- **Status:** implemented (2026-11-26). Step 3 of section 2 of `docs/roadmap.md`, the first part of chantier 8 (the
  starter and the public images come next).
- **Context:** a person who wants their own API had to write a manifest, a schema, a service and its image recipe by
  hand, after the examples of the repository. D27 named the example APIs `-api` and `-web`, the names this command
  gives.
- **Decision.**
  - **Names.** `create inventory --kind api` creates `inventory-api`; a name that already ends with the suffix keeps it
    (`create shop-web --kind web` creates `shop-web`). The full name follows the brick name rule
    (`BRICK_CREATE_INVALID_NAME` otherwise). The suffixes are this command's convention, not a rule: `add` gives no
    warning for a brick without one, which would warn on `keycloak`.
  - **Two folders.** The brick (`plugin.json`, and `schema.graphql` for an API) goes to `bricks/<name>`, where
    `add <name>` finds it (D25). The code, its lock file and its image recipe go to `services/<name>`, outside the
    brick: `add` copies a brick's whole folder and refuses a symbolic link, and a service's folder holds
    `node_modules` once built on the machine (with links in `.bin`). This is the layout of the repository
    (`examples/` and `apis/`).
  - **One schema.** The schema the platform composes is the brick's. The image of an API carries a copy taken at build
    time: its `Dockerfile` is built from the project folder (`docker build -t <image> -f services/<name>/Dockerfile .`,
    the line `create` prints), and a `Dockerfile.dockerignore` next to it limits the context to the files it needs.
  - **What is written.** For an API: a federation v2 subgraph in TypeScript (GraphQL Yoga, `@apollo/subgraph`, the
    versions of `apis/orders-api`), an entity `<Name>Item @key(fields: "id")` and a field `Query.<name>Items`, both
    named after the brick so that two created APIs compose (a `Query` field in two subgraphs would need
    `@shareable`), `/health`, a non-root image. For a web brick: a Node server with no dependency that asks the
    router `{ __typename }` from the server, through `GRAPHQL_URL`. The image is `<platform>/<name>:0.1.0`, to build;
    no brick requires anything, so with an `oidc` provider the API checks no token (D20) until its author adds it.
  - **Templates.** In `packages/plugbricks/templates/<kind>/{brick,service}`, shipped in the package. A file with
    placeholders ends with `.tmpl` (so that no linter or compiler reads it); `package.json` and `package-lock.json`
    carry none and get the service's name, so that Dependabot keeps the API template's dependencies current (its own
    entry in `.github/dependabot.yml`).
  - **Writing nothing on a refusal.** `create` refuses before writing when the brick is installed
    (`BRICK_NAME_CONFLICT`) or `bricks/<name>` or `services/<name>` exists (`BRICK_CREATE_TARGET_EXISTS`); when the add
    itself is refused (a composition error with an installed subgraph, say), it removes what it wrote, the parent
    folders it created included.
  - **The project template.** `services/orders-api`, a brick with an image that does not exist, is gone from
    `create-plugbricks`: `services/` now holds the code of the created services (`services/README.md` says so), its
    README creates a first API, and `.gitignore` ignores `services/*/dist/`.
- **Tested.** CLI scenarios `create-api` (golden files; the placeholders filled, nothing left in `.tmpl`),
  `create-web`, `create-two-apis` (they compose), `create-dir`, `create-refusals` and `create-add-refused` (nothing
  left after a refused add); the packed package creates a brick from the templates it ships (`dist`); end to end on
  Docker Compose (`e2e-compose`, "bricks written by create"): an API and a web brick created, their images built with
  the printed commands, `{ inventoryItems }` answered through the router and the page reading the router.
- **On Kubernetes (2026-11-26).** The cluster pulls the image itself, so it must be where the cluster can get it.
  The driver sets no `imagePullPolicy`: Kubernetes takes `IfNotPresent` for a pinned tag, so an image imported into a
  local cluster (`k3d image import`, `kind load docker-image`) is used as it is, as the k3d job does for the example
  APIs. `create` prints that step after the build command, and `create --image <ref>` names a registry image in the
  manifest and the build command from the start (`ghcr.io/acme/inventory-api:0.1.0`), with the pinning rule of any
  manifest checked before anything is written (`IMAGE_FLOATING_TAG`, `IMAGE_NOT_PINNED`). Tested by the CLI scenario
  `create-image` and on k3d in CI (`e2e-k8s`, "runs an API written by create"): created, built with the printed
  command, imported with k3d, answered through the router.
- **Not done here.** Pushing the image to a registry for the person, and the starter and the public images of the
  examples (steps 4 and 5).

## D29. The images of the application examples are published to GitHub Container Registry

- **Status:** implemented (2026-11-26); nothing published until it runs on `main`, and each package then made public
  by the owner. Step 5 of section 2 of `docs/roadmap.md`.
- **Context:** the application examples (`orders-api`, `shipping-api`, `orders-web`, `keycloak`, `queue-consumer`)
  named images `plugbricks-example/<name>:0.1.0` that only a clone of this repository could build. A newcomer could
  add them and never `up` them; the starter (step 4) needs them to run.
- **Decision.**
  - **Names.** `ghcr.io/rudney5000/plugbricks/<name>:<version>`, the shape of the Cosmo router's own image
    (`ghcr.io/wundergraph/cosmo/router`). They carry the owner's name, as the roadmap said.
  - **One source.** The example manifests name the images. `packages/plugbricks/scripts/example-images.mjs` lists
    every image of an example under that registry with the folder of `apis/` it is built from (it fails when the
    folder has no `Dockerfile`); the workflow and the tests use that list, so the name and the version are written in
    one place.
  - **A version is never replaced.** On `main`, the workflow skips an image whose tag is already in the registry; a
    fix (a dependency with an advisory, say) ships as a new version, written in the manifest. What a published
    `0.1.0` contains never changes under a project that pinned it.
  - **The workflow** (`.github/workflows/images.yml`): on a push to `main` that touches `apis/`, the examples, the list
    or the workflow, and by hand, it builds and pushes; on a pull request it builds only, without logging in. It uses
    the repository's `GITHUB_TOKEN` with `packages: write`, plain `docker` commands (no third-party action), labels
    the images with their source, revision and licence, writes the digests to the run summary, and warns when an
    image cannot be pulled anonymously.
  - **amd64 only** for now: a Mac with Apple silicon runs them through Docker's emulation. arm64 (native runners, then
    one multi-platform tag) comes with the first person who needs it.
  - **The tests build them locally** under the same names (`test/helpers/images.ts`): Docker Compose and a k3d cluster
    use a local image before pulling one, so the tests need neither the registry nor a published version.
- **The owner's part.** GitHub creates a package private: after the first run on `main`, make each of the five public
  (the package's settings, Change visibility). The workflow's last step warns until it is done.
- **Tested.** `test/example-images.test.ts` (the list, the pinning, no example left on `plugbricks-example/`); the
  build step of the workflow run as it is, in its pull-request mode, on Docker (the five images built, with their
  labels); the end-to-end tests on Docker Compose with the images under their new names. The push itself runs only on
  GitHub.

## D30. A starter: `npm create plugbricks <name> -- --starter demo`

- **Status:** implemented (2026-11-26). Step 4 of section 2 of `docs/roadmap.md`; with D28 and D29, chantier 8 is
  done.
- **Context:** a new project had three bricks to add and nothing that ran until the person wrote or found an API. With
  the images of the examples public (D29), the example shop can run in a new project.
- **Decision.**
  - **The command.** `npm create plugbricks <name> -- --starter <starter>`; the generator also reads
    `--starter=<starter>` and the option before the name. npm 7 and later give the generator only what follows `--`
    (`npm init foo -- --hello` is `npm exec -- create-foo --hello`); without it npm takes `--starter` for one of its own
    options. An unknown starter is a usage error that lists the starters (`CREATE_UNKNOWN_STARTER`, exit 2), and
    nothing is written.
  - **The starters** are in `packages/create-plugbricks/starters.json`: a name, a sentence, and the bricks, in the order
    they are added (each after what it needs). One for now, `demo`: `postgres`, `orders-api`, `shipping-api`,
    `orders-web`, the shop with its page, without Keycloak, so that the first `up` needs no sign-in.
  - **No question.** The person chose the starter: its bricks are added as `add` would add them, without the
    confirmation of D26, and the generator prints what it added, the next commands, and where the router and each web
    page answer once the platform is up.
  - **One catalogue.** The bricks the generator ships are in `packages/create-plugbricks/bricks/`: the base ones every
    project gets in `bricks/` (`postgres`, `rabbitmq`, `nats`, D25) and those of the starters, copied into the project
    only with their starter. A project made with `demo` has its bricks in `bricks/` too, so that `add`, `remove` and
    the admin find them by name. The test that keeps the copies equal to the examples covers the whole catalogue,
    and refuses an image only this repository can build.
- **Tested.** `create-plugbricks`: the options, each starter (its bricks added in its order, `status` and `generate`
  accept the project), `demo` and its addresses, the refusals, and the packed generator with `--starter demo`. By hand
  on Docker Compose: a project made with `demo`, `up` with the images built locally under their published names, an
  order created through the router listed on the page.
- **Not done here.** The images must be public for a newcomer's `up` (D29, the owner's step). A starter with Keycloak,
  when the admin sign-in is part of a first run.

## D31. `plugbricks doctor`: what `up` needs, checked without changing anything

- **Status:** implemented (2026-11-26). Step 6 of section 2 of `docs/roadmap.md`.
- **Context:** when `up` fails, the person reads a Docker or kubectl error: a daemon that does not answer, a port
  already allocated, an image that cannot be pulled, a context that does not exist. On 2026-11-26 a test platform named
  `shop` shared, without a word, the Compose project, the containers and the volume of an older platform of the same
  name in another folder, and a `down` of one stopped the other: nothing said so beforehand.
- **Decision.** `plugbricks doctor [--runtime compose|k8s] [--context <name>] [--kubeconfig <file>] [--dir <path>]`
  prints one line per check, `ok`, `warning` or `problem`, with a fix under each warning and problem, and exits 1 when
  there is a problem (a warning alone exits 0). It is read-only: it writes nothing, takes no platform lock (D16), and
  every call to a tool is a query. Each check has a stable id (`Check.id` in `src/doctor.ts`), for a JSON report later.
  - **Always:** the Node version against the `engines` of the package; `platform.json` and `platform.lock` read as
    every command reads them; `.secrets/` restricted to the user, with the read-only check that `up` relies on (D6).
    Outside a platform it says where to run it, and still checks the tools.
  - **Docker Compose:** Docker answers (the first line of its error otherwise) and runs Linux containers; the Compose
    v2 plugin; **no other platform of the same name** has containers on the machine from another folder (the Compose
    label `com.docker.compose.project.working_dir`); the ports the platform publishes (`router.port` when it serves a
    subgraph, the `webPort` of each enabled web brick) are free on 127.0.0.1, or held by this platform when it is
    already up; the images of the enabled bricks: on the machine, or pulled by `up`, and a warning with the
    `docker build` command for an image of a brick whose code `create` wrote in `services/` (D28) and that is not built.
  - **Kubernetes:** `kubectl`; the context named, allowed (the protected contexts of D5 need `--allow-context`) and
    present in the kubeconfig; the cluster answers `/readyz`; a warning for an image built from `services/`, which the
    cluster must be given (D28).
  - **Not checked:** volumes left by an older platform of the same name without containers (Compose labels a volume
    with its project only, not with a folder); whether an image can be pulled (that needs the network); free disk.
- **Tested.** `test/doctor.test.ts` with a fake docker and kubectl: each answer and its fix, the order of the checks,
  the checks left out after a failed one, and nothing written; the CLI scenario `doctor` (the output, the exit codes,
  `--kind` refused). By hand on this machine: outside a platform, a port held by another program, an image of
  `create` not built (with its build command), and a second platform of the same name running from another folder,
  found from the first and not from itself. Kubernetes only with the fake: kubectl is not installed here.

## D32. `plugbricks logs` and `plugbricks exec`: a brick's service, without its runtime name

- **Status:** implemented (2026-11-26). Item 1 of section 5 of `docs/roadmap.md`.
- **Context:** to see why a service falls, or to run a command in it, a person left plugbricks for `docker` or
  `kubectl` and had to find the names plugbricks gave: `<platform>-<brick>-<service>-1` on Compose, the Deployment
  `<brick>-<service>` of the namespace `<platform>` and its container on Kubernetes.
- **Decision.**
  - **The commands.** `logs <brick> [--service <name>] [--follow|-f] [--tail <n>]` and
    `exec <brick> [--service <name>] [-- <command>...]`, with the runtime options of `up` (`--runtime k8s` needs
    `--context`, with the guards of D5). A brick with one service needs no `--service`; with several, it is required
    (`SERVICE_REQUIRED`, `SERVICE_UNKNOWN`). `router` names the router when no brick has that name
    (`ROUTER_NOT_IN_PLATFORM` when the platform serves no subgraph). Without a command, `exec` opens `sh`. A disabled
    brick runs nothing (`BRICK_DISABLED_NOT_RUNNING`).
  - **Attached.** The output goes straight to the terminal, and the terminal's input to the command, so that
    `--follow` and an interactive shell work; plugbricks exits with the exit code of the command (130 after Ctrl-C).
    `exec` allocates a TTY only for a person at a terminal (both ends are terminals, as for the questions of D26).
  - **Docker Compose:** `docker logs` and `docker exec` on the container found by its Compose labels (project and
    service), not `docker compose logs`: it needs no `.generated/` file and no secrets file, and the logs of a stopped
    container stay readable (`SERVICE_HAS_NO_CONTAINER`, and `SERVICE_NOT_RUNNING` for `exec`).
  - **Kubernetes:** `kubectl logs` and `kubectl exec` on `deployment/<brick>-<service>`, with `--container` set to the
    service: the pod also has the init containers of its waits.
  - **No lock**: neither changes the platform's files (D16).
- **Tested.** CLI scenarios `logs-exec-compose` (the commands run, the exit code passed on), `logs-exec-k8s` (the
  cluster flags on every call; nothing runs without them, checked by the runner for `logs` and `exec` as for `up`)
  and `logs-exec-refusals`. By hand on Docker Compose: the logs of an API and of the router, `--tail`, a command and
  its exit code (7), an interactive shell in a pseudo-terminal, and `--follow` stopped by SIGINT (130). Kubernetes
  only with the fake: kubectl is not installed here.
- **Not done here.** The logs of the provision and wait tasks (they are not services); a development loop that
  rebuilds and restarts one brick (`plugbricks dev`, item 2).

## D33. An external subgraph: a brick without a container, for a GraphQL service that runs elsewhere

- **Status:** accepted (2026-11-26), with the four recommendations put to the owner: the address in the manifest, no
  token unless the brick asks for it, `http` accepted with a warning, and the core first. Steps 1 and 2 are implemented
  (step 2, the comparison of the schema file with the service's, on 2026-11-26). Item 1 of section 4 of `docs/roadmap.md`.
- **Context:** plugbricks federates GraphQL services it starts itself. A team that already runs one (a catalogue, a
  legacy API) wants it behind the same router, composed and checked with the others, without plugbricks running it.
- **Decision.**
  - **The manifest.** `subgraph.url` instead of `subgraph.service`: `{ "url": "https://catalog.example.com/graphql",
    "schema": "schema.graphql" }`, and `services: []`. Composition, `extends` (both ways) and the router
    configuration are the same as for any subgraph; the router calls the URL as it is. A brick is then either
    external or made of services, not both. It provides nothing, requires nothing, has no volume, no web pages and no
    `authorization` block: there is no service to wire, provision, publish or configure, and the roles an external
    service checks are its own business (D22). It may declare `dependencies` (D21) and be one.
  - **The address**, in the manifest: one external brick describes one service. Another address is another brick, or
    a remove and an add; values per environment come with section 6 of the roadmap. A URL with a user or password
    is refused (a secret would sit in the manifest and the lock), and so is a loopback address (`localhost`,
    `127.0.0.1`, `::1`): it would name the router's own container. A service of this machine is reached at
    `host.docker.internal` (the router gets that name on Docker Compose; on Kubernetes the cluster's own name for the
    machine, `host.k3d.internal` on k3d, is the person's to give).
  - **http** is accepted; `add` warns that the requests travel in clear, unless the host is `host.docker.internal`, a
    name under `.internal` or `.local`, or a private address.
  - **The token** (D20): the router passes `Authorization` on to the platform's own subgraphs, and to an external
    one only when its manifest says `"forwardAuthorization": true`. A token of the platform is not handed to a service
    whose configuration is not ours without a decision written in its manifest. With such a subgraph the router gets
    one header rule per subgraph instead of the rule for all.
  - **Running.** `up` starts nothing for it and does not wait for it; the router starts anyway, and a query that
    reaches it while it is down gets the router's error for that subgraph. `down` stops nothing of it. `status`,
    `status --runtime` and the admin say "external, not supervised", with its address; `logs` and `exec` refuse it.
- **Implemented (step 1).** The schema lets `services` be empty and a subgraph have `url` and `forwardAuthorization`
  (`path` is now optional for a service's subgraph too, `/graphql` by default as before); `manifest.ts` gives each
  rule its code: `SUBGRAPH_SERVICE_OR_URL`, `EXTERNAL_WITH_SERVICES`, `EXTERNAL_FIELD_NOT_ALLOWED`,
  `EXTERNAL_SUBGRAPH_PATH`, `EXTERNAL_ONLY`, `EXTERNAL_URL_INVALID`, `EXTERNAL_URL_CREDENTIALS`,
  `EXTERNAL_URL_LOOPBACK`, `SERVICES_EMPTY`; `logs` and `exec` refuse it (`EXTERNAL_NOT_RUN`). The router has no
  `depends_on` for it, and gets `extra_hosts: host.docker.internal:host-gateway` on Compose when an address uses that
  name. `up` now starts a router that has no service of the platform to wait for (it used to run `down` on a platform
  without services). `status`, `status --runtime` (an optional `external` list in the router, additive to version 1
  of the report) and the admin show the address and "not supervised".
- **Verified on this machine.** The pinned router (0.372.0) accepts `headers.subgraphs.<name>` and refuses an unknown
  key of `headers` (`additional properties ... not allowed`), so the per-subgraph token rule is read. On a Linux Docker
  engine, `host.docker.internal` is the gateway of Docker's bridge (172.18.0.1 here): a service published on
  127.0.0.1 only is not reached (the router answers `Failed to fetch from Subgraph`), one published on the gateway's
  address is. Docker Desktop forwards that name to the machine's own loopback; not tried here.
- **Tested.** Nine invalid manifests (one code each); the CLI scenarios `external-subgraph` (golden files: the router's
  address, no service, no `depends_on`), `external-subgraph-extends` (an external subgraph extends `Order` of
  `orders-api`; `remove orders-api` refused; `extra_hosts`), `external-subgraph-in-clear`, `external-subgraph-token`
  and `external-subgraph-token-forwarded`; the admin's hosts; end to end on Docker Compose (`e2e-compose`, "a subgraph
  that runs elsewhere"): a service built from the template of `create`, run outside the platform, answered through a
  router that runs alone, and the router still answering, with its error for that subgraph, once the service is
  stopped. Kubernetes is covered by the same plan and generated files, not run.
- **Step 2, `plugbricks schema check <brick> [--url <address>]`.** Composition reads the file and the service can drift
  from it: the command asks the service for `{ _service { sdl } }` (every federation subgraph answers it) and compares
  it with the installed copy, the one the router composes. Exit 0 when they say the same thing, 1 with the list of
  differences (a type, a field, an argument, an enum value or a directive such as `@key`, on one side only or
  different), so that a CI can run it; read-only. What does not change composition is not a drift: the order of
  definitions and members, the descriptions, an extension against its type, and what a federation library adds to the
  SDL it serves (the definitions of the federation and link directives, `_Service`, `_Any`, `_Entity`, the fields
  `_entities` and `_service`; found on a real service, see below). `host.docker.internal` is asked at the gateway of
  Docker's bridge on Linux and at 127.0.0.1 elsewhere, as the router's container reaches it; `--url` gives another
  address, and is the only way for a subgraph served inside the platform, which this machine does not reach (D9:
  `SCHEMA_CHECK_EXTERNAL_ONLY` otherwise). A service that does not answer, or answers no SDL, is
  `SCHEMA_CHECK_UNREACHABLE`, with the reason (`ECONNREFUSED`, the HTTP status and the GraphQL error).
  - **Tested.** `test/schemacheck.test.ts`, on an SDL recorded from a real subgraph (the template of `create`,
    `@apollo/subgraph` 2.17.0, `test/fixtures/schema/`): nothing found against its file, order and descriptions
    ignored, each kind of difference named; the CLI scenario `schema-check-refusals`; end to end on Docker Compose, in
    "a subgraph that runs elsewhere", against the running service. By hand: a field added and a type changed in the
    file are both reported, a description alone is not, a stopped service is `ECONNREFUSED`.

---

## D34. `plugbricks export <dir>`: the files of the platform, to run without plugbricks

- **Status:** implemented (2026-11-26). Item 1 of section 8 of `docs/roadmap.md`.
- **Context:** the first objection of a team to a tool that writes its runtime files is "and if we want to leave?".
  `generate` already writes the Compose file or the Kubernetes manifests, but into `.generated/`, which ignores itself,
  refers to the project (the provision scripts at `../../.platform/bricks/...`), says "do not edit, run plugbricks
  generate", and keeps the secrets in `.secrets/`. Leaving meant copying and fixing all of that by hand.
- **Decision.**
  - **The command.** `plugbricks export <dir> [--runtime compose|k8s] [--with-secrets]`. Compose by default, like the
    others. `<dir>` is relative to where the command is typed, and it must not exist or be empty: an export never
    overwrites (`EXPORT_DIR_NOT_EMPTY`), and it refuses a folder inside `.generated/`, `.secrets/` or `.platform/`, which
    plugbricks rewrites or keeps private (`EXPORT_DIR_IN_PLATFORM`).
  - **What it writes.** Compose: `compose.yaml`, `router-config.json` (and `router.yaml` with a token check), the
    provision scripts in `scripts/<name>/` with the modes of the installed copy (a script mounted read-only has to stay
    executable), `.env.example` or `.env`, and a `README.md`. Kubernetes: `namespace.yaml`, `resources.yaml` (the
    router's configuration is in its ConfigMap), `secret.example.yaml` or `secret.yaml`, and a `README.md`. The
    `README.md` gives the commands (`docker compose up -d`; the three `kubectl apply`), says what to change before
    exposing the router (it is on 127.0.0.1, or a ClusterIP Service), and lists the images the files name: an image built
    from `services/` has to be pushed to a registry first. The files are the ones `up` applies, with two differences: the
    scripts are read from the folder beside the file, and the header says the copy is the reader's (plugbricks does not
    read it and never rewrites it).
  - **Secrets.** No secret value unless asked. Without `--with-secrets`, `.env.example` lists the variables with nothing
    after the `=` (Compose refuses an empty one: `${VAR:?...}`, with a message that says to fill `.env`), and
    `secret.example.yaml` holds `CHANGE-ME` for each. With `--with-secrets`, the values already in `.secrets/secrets.env`
    go to `.env` or `secret.yaml` (mode 0600), and a `.gitignore` of the folder ignores that file. The values are never in
    `compose.yaml` or `resources.yaml`. A folder one is going to commit is the ordinary case, so the safe form is the
    default.
  - **Read-only for the platform.** No lock (D16) and no secret created: if `--with-secrets` finds one missing it
    refuses and says to run `generate` (`EXPORT_SECRETS_MISSING`), because creating a secret changes the platform.
  - **A one-way copy.** There is no `import`, and no `up` from an exported folder. The labels `plugbricks/...` and
    `app.kubernetes.io/managed-by: plugbricks` stay in the manifests: they are inert, and removing them would make the
    copy differ from what runs.
- **Tested.** CLI scenarios `export-compose`, `export-k8s` and `export-refusals`; `test/export.test.ts` (nothing of the
  project changes and no secret is created; no path out of the folder in the Compose file; scripts byte for byte and with
  their mode; no secret value anywhere without `--with-secrets`, and only in `.env` or `secret.yaml` with it; mode 0600;
  every image listed). Two mutations, each caught: the scripts' path left as `../../`, and the secrets written without
  `--with-secrets`. By hand, on Docker Compose 5: the exported folder of the starter, run with plain `docker compose up -d
  --wait` and no plugbricks (the web port edited, since 8080 was taken: the copy is meant to be edited): every service
  healthy, the router answered `{ __typename }`, the page of `orders-web` answered 200, and `docker compose down --volumes`
  removed everything; without `.env`, `docker compose config` refuses with the message that says to fill it.
- **Not tested here.** The Kubernetes files applied to a cluster (`kubectl` is not installed here): they are the files
  `up` applies, checked by the k3d job, plus the one difference that is the header; the Secret of `secret.yaml` is the one
  `up` applies too.
- **Not done.** `export --out` for `generate`; a `kustomization.yaml` or a Helm chart; the volume size (1Gi, as `up`
  writes it) is the reader's to change; an image built locally is listed, not pushed.

## D35. gRPC services through Cosmo Connect: what was checked, and what plugbricks does

- **Status:** studied, then implemented (2026-11-26), steps 1 to 3 and the example. Steps 4 and 5 are not decided or built
  (last paragraph). Item 2 of section 4 of `docs/roadmap.md`.
- **Context:** a team with a gRPC service wants it behind the same router as its GraphQL subgraphs. Cosmo Connect lets the
  router call a gRPC service as a subgraph: a GraphQL schema is written, `wgc grpc-service generate` produces the Protocol
  Buffers, the service implements them. The roadmap said "not verified at all in plugbricks". This is what was verified.
- **Verified, by running it (router 0.372.0 pinned by digest, as `up` runs it; `wgc` 0.133.13 from `tools/wgc-crosscheck`;
  a gRPC server of about 25 lines with `@grpc/grpc-js` implementing the generated proto).**
  - **The router supports it, with no flag.** A static `router-config.json` with a `grpc` block (`protoSchema` and
    `mapping`) in the subgraph's data source is enough; no environment variable or option to switch on.
  - **How a gRPC subgraph is declared to `wgc router compose`:** in the input file, `name`, `routing_url` and a `grpc` block
    with `schema_file`, `proto_file` and `mapping_file` (read in `wgc`'s own code; the documentation page that shows it was
    not readable).
  - **`routing_url` is a gRPC target, not a URL.** `host:port` works (`host.docker.internal:50051`); `grpc://host:50051` makes
    the router fail every request with `invalid target address ... too many colons in address`.
  - **Plain text by default.** The call to the service ran without TLS. The documentation says TLS is opt-in for gRPC
    subgraphs, under `tls.client_grpc` (and not `tls.client`); not tried.
  - **`wgc grpc-service generate <name> -i schema.graphql -o dir`** wrote `service.proto`, `mapping.json` and
    `service.proto.lock.json` (the documentation says `service.mapping.json`: it is wrong for this version). The service
    is named after the argument (`catalog` gives `service Catalog`), the package is `service.v1`, each root field is a
    method (`QueryProduct`, `MutationRename`) and each `@key` an entity lookup (`LookupProductById`, which takes the keys
    in a list and must answer in the same order).
  - **What worked through the router:** a list, a field with an argument, a mutation, and the federation both ways with an
    HTTP subgraph: a gRPC root field with a field from the HTTP subgraph (`_entities` sent to the HTTP side), and an HTTP
    root field with a field from the gRPC service (one `LookupProductById` call with the key). Nullable single objects came
    back as null.
  - **The token does not reach the service.** With a request carrying `Authorization` and another header, the gRPC service
    saw only `user-agent`. With `headers: all: request: [{op: propagate, named: Authorization}, ...]` in the router's
    `router.yaml` (the file D19 already writes when the router checks tokens), both arrived as gRPC metadata. So a gRPC
    brick would not do the second check of D20 unless the router is told to propagate the header, and nothing in the
    router's own check is lost: it validates the token before any subgraph.
  - **What the composer of plugbricks needs.** `buildRouterConfig` of `@wundergraph/cosmo-shared` 0.50.2, which
    `federation.ts` calls, has a `SubgraphKind.GRPC` (with `protoSchema` and `mapping`) next to the `Standard` it is given
    today; `wgc` composes the SDL of a gRPC subgraph like any other. Not run through plugbricks: the type declarations
    and the `wgc` code were read, and the config written by `wgc` was served by the router.
- **Documented, not tried.** Not supported over gRPC: subscriptions, streaming, nested keys in entity lookups, nullable list
  items (`[String]` is a warning), custom scalars other than fixed mappings (`wgc` takes `--custom-scalar-mapping`). The
  documentation contradicts itself on union types (a table says supported, the linting table says error). The version
  that introduced gRPC services is not stated; request wire encoding is "since 0.357.0".
- **Not verified.** TLS and mTLS to the service; `headers.subgraphs.<name>` (a rule for one gRPC subgraph only); Kubernetes
  (the same files, and a Service name as the target: `<brick>-<service>:<port>`); a federation of several gRPC services;
  what `wgc grpc-service generate --with-operations` produces; the tutorial of the documentation.
- **What plugbricks does.**
  1. **The manifest.** `subgraph: { service, schema, grpc: { proto, mapping } }`: the three files are in the brick, like
     `schema.graphql` is, and the two new ones are what `wgc grpc-service generate` writes (`service.proto` and
     `mapping.json`). The router calls the service at `<service>:<port>`, a gRPC target with no scheme and no path, which
     is what the study found it needs. `grpc` goes with a service of the brick (`GRPC_NEEDS_SERVICE`: a gRPC service that
     runs elsewhere is not supported) and not with `path` (`GRPC_SUBGRAPH_PATH`); the proto and the mapping go together
     (the schema).
  2. **The composition.** `federation.ts` gives `buildRouterConfig` a `SubgraphKind.GRPC` subgraph with its proto and its
     mapping, as `wgc router compose` does; the SDL composes like any other, so a gRPC subgraph and an HTTP one join through
     `@key` and `extends`. Two checks at `add`, which composition cannot make and the router would only report at the first
     call: the mapping must be what `wgc` writes (`GRPC_MAPPING_INVALID`, with the reason) and the proto must declare the
     service the mapping names, outside comments (`GRPC_PROTO_SERVICE_MISSING`).
  3. **The token.** Nothing to add: when the router checks tokens, plugbricks already writes `headers.all.request:
     propagate Authorization` (D20), which is the rule the study found a gRPC service needs; it reaches the service as
     gRPC metadata. (The study's first text said the rule had to be added; it was already there, for every subgraph.) What
     the service does with the token is its business, as for an external subgraph (D33): the example does not check it
     again, the router did. The roles of D22 need `requires.oidc`, which the example does not declare.
  4. **`schema check`** refuses a gRPC brick (`SCHEMA_CHECK_GRPC`): it asks a service for its SDL, and a gRPC service has
     none. The drift to watch is the proto against the schema, which `wgc grpc-service generate` keeps with its
     `service.proto.lock.json` (the field numbers); that stays the author's.
  5. **The example.** `examples/catalog-grpc` and its service `apis/catalog-grpc` (Node, `@grpc/grpc-js`, the products and
     the entity lookup of the study), an image `ghcr.io/rudney5000/plugbricks/catalog-grpc:0.1.0` that the images workflow
     builds and publishes like the others (D29), a health check that calls the service (`node dist/health.js`: the image
     has node and no `grpc_health_probe`). A key that is not in the catalog gets an empty Product, because a repeated field
     cannot hold a null; the example says so. The proto is what `wgc` wrote, but for one space at the end of a comment line,
     which the repository's pre-commit check refuses: running `wgc` again brings it back, and nothing depends on it.
- **Tested.** Manifests: three invalid fixtures, one issue each. Composition: `examples-federation` composes the gRPC example
  with orders and shipping; **`router-crosscheck`: our `router-config.json` with a gRPC service next to the HTTP ones is the
  same as `wgc router compose`'s, field for field** (only the order of the subgraphs is set aside: ours are sorted by brick
  name, wgc keeps the input's). CLI scenarios `grpc-subgraph` (golden lock, the target in the router config, `schema check`
  refused), `grpc-subgraph-token` (the `headers.all` rule with Keycloak; the proto in the router config) and
  `grpc-subgraph-refusals` (a bad mapping, a proto whose service is only in a comment). The service: five tests with a
  gRPC client built from the proto, and one that keeps the brick's copies of the proto, the mapping and the schema byte
  for byte equal to the service's. Three mutations, each caught: the gRPC kind turned off, the proto check inverted, the
  target written as an http URL. By hand, with plugbricks itself: `up` on Docker Compose with `examples/catalog-grpc`
  (image built locally): the health check passed, the router answered a list, a field with an argument and a mutation, and
  `status --runtime` showed the service healthy.
- **Not tested.** The token through plugbricks' own `router.yaml` with a real Keycloak token to a gRPC service (the study
  proved the rule with the router and a service; the scenario proves plugbricks writes it). Kubernetes: the same target
  with the name of the Service, rendered but not applied. TLS to the service. Several gRPC services in one platform. The
  limits of the documentation (subscriptions, nested keys, nullable list items, custom scalars) were not tried.
- **Open.** Whether plugbricks generates the proto itself (a new dependency, `@wundergraph/protographic`, which `wgc` uses;
  today the author runs `wgc grpc-service generate` and gives the files, the smaller step), and `create <name> --kind grpc`,
  a service template that implements a generated proto. Not before someone writes a second gRPC service.

## D36. A REST service behind an adapter subgraph: the `stock-api` example

- **Status:** implemented (2026-11-26). Item 3 of section 4 of `docs/roadmap.md`.
- **Context:** a team's service speaks REST. The router has no OpenAPI to GraphQL converter, so "bring your REST service" had
  no answer but "write a GraphQL subgraph". What was missing is one worked example of that subgraph, and of the decisions
  it has to make.
- **Decision.** No new feature in plugbricks: two example bricks and the code of their services.
  - **`stock-rest`** stands for the service one already runs: a REST API with an OpenAPI contract (`apis/stock-rest`,
    `openapi.json`), no dependency, no GraphQL, nothing published.
  - **`stock-api`** is the adapter, a GraphQL subgraph written by hand from that contract (`apis/stock-api`): one function
    per operation, one entity (`Item @key(fields: "sku")`) so that other subgraphs can refer to it. No generator: it
    would add a dependency or a build step, and three operations do not need one (none was tried).
  - **Two bricks, not one with two services**, because in real use only the adapter is a brick of the platform: its
    `dependencies` (D21) name the stand-in, and one drops that dependency when pointing it at a real service.
  - **The address.** `STOCK_API_URL` in the adapter's manifest. A manifest has no variable for the address of another brick,
    so it names the runtime name plugbricks gives that service, `<brick>-<service>` (D32), the same on Compose and on
    Kubernetes: `http://stock-rest-app:8080`. A real service is named by its own address there.
  - **What the adapter decides**, and its tests hold it to:
    - an id is checked against the contract's pattern before it enters a URL (`..`, `/`, `?` never reach the REST API);
    - the REST API's `404` is `null`, its `400` is `BAD_USER_INPUT` with its message; anything else (unreachable, slower
      than 5 s, another status, an answer off the contract) is `UPSTREAM_UNAVAILABLE`, and the caller learns neither the
      address nor the answer, which go to the log;
    - no redirect is followed;
    - `/health` says the adapter runs, not that the REST API does: restarting the adapter would not bring it back;
    - one REST call per entity reference, with a comment saying where to batch;
    - **no credential is passed on.** The router checks the token (D19); the example does not check it again (it does not
      declare `requires.oidc`) and does not send it to the REST API. A real adapter has to decide both, per service: its own
      credential for the REST API, or the caller's token when that API accepts the platform's issuer.
- **Tested.** `apis/stock-rest`: four tests (`node --test`). `apis/stock-api`: thirteen, the adapter in front of the real
  stand-in (including the six refused ids, the references, the failures and the timeout) and the contract (every call it made
  is an operation of `openapi.json`; the sku pattern is the contract's; the brick's schema is the one served). Three
  mutations, each caught: no id check, redirects followed, the upstream's message passed to the caller. CLI scenario
  `rest-adapter` (the dependency, the address in the Compose file and the Service of that name in the Kubernetes manifests).
  `examples-federation` composes it with the others. By hand with plugbricks on Docker Compose (images built locally):
  `add stock-api --yes` added `stock-rest`, `up`, a list, a restock, both refusals, `null` for an unknown sku, and with
  `stock-rest` stopped `UPSTREAM_UNAVAILABLE` and the reason in `logs`, `status --runtime` showing which one stopped. The
  router wraps a subgraph's error: the code is in `errors[0].extensions.errors[0].extensions.code`.
- **Not tested.** Kubernetes (rendered, not applied). An adapter that checks tokens or calls a REST API that asks for one.

## D37. `plugbricks dev <brick>`: rebuild one brick and restart it alone

- **Status:** implemented (2026-11-26). Item 2 of section 5 of `docs/roadmap.md`.
- **Context:** after a change to a service, its author typed the `docker build` that `create` printed, then went through
  `up` on the whole platform, then asked for the logs. A change of schema was worse: the router composes the installed copy of the brick, and `add`
  refuses a brick that changed (`BRICK_NAME_CONFLICT`), so a new field meant `remove`, then `add`.
- **Decision.**
  - **The command.** `dev <brick> [--service <name>] [--no-follow]`: in a platform that is up, builds
    `docker build -t <image> -f services/<brick>/Dockerfile .` (the command `create` prints, D28), recreates that service
    alone with `docker compose up --no-deps --force-recreate --wait`, and follows its logs (`--no-follow`: the last 20
    lines). One turn per command: run it again after the next change. No watching of files: it would need a long-running
    process, and a rebuild on every save is rarely what is wanted.
  - **The contract follows the code.** When the schema of the brick's subgraph (and, for a gRPC one, the proto and the
    mapping) differs from the installed copy, `dev` takes it: it checks that the new one composes before anything is built,
    updates the installed copy and the lock after the build, and recreates the router with the service.
  - **Only the contract.** Any other difference in the brick's folder, the manifest first, is refused
    (`DEV_BRICK_CHANGED`): a new service, volume or requirement changes what the platform is made of. Updating an installed
    brick in general is chantier 11 and needs its own decision (what happens to volumes, secrets, web ports).
  - **Nothing changes unless the image is built.** Not installed, disabled, external, no code in `services/` (`DEV_NO_SOURCE`),
    an image named by digest (`DEV_IMAGE_BY_DIGEST`), a platform that is not up, a schema that does not parse or compose:
    refused before the build. A failed build (`DEV_BUILD_FAILED`) leaves the installed copy, the lock and the containers as
    they were. A service that does not start (`DEV_RESTART_FAILED`) shows its last 50 lines; the new contract is then
    installed, as the next turn expects.
  - **The lock** (D16) covers the check, the build and the restart, not the following of the logs: another command can run
    meanwhile.
  - **Docker Compose only.** On Kubernetes the image has to reach the cluster (import or push, D28), which differs per
    cluster; `dev` has no `--runtime`.
- **Tested.** CLI scenarios `dev-compose` (the commands run, the router only with a new schema, nothing changed by a failed
  build, the logs of a service that does not start) and `dev-refusals`. Three mutations, each caught: the contract applied
  before the build, the router never restarted, any changed file accepted. By hand on Docker Compose with an API written by
  `create`: a new field in the schema and its resolver answered through the router after about 27 s; a TypeScript error left
  the platform serving as before; a manifest change and a broken schema were refused; a crash at start showed the error;
  while the logs were followed another command ran, and SIGINT stopped the following.
- **Not done.** Kubernetes; a brick whose services use several images built from one folder; `dev` for several bricks at
  once. `up` itself returns before the router listens (it has no health check on Compose, D9).

## D38. `create --kind api --lang python`: a second service template

- **Status:** implemented (2026-11-26). Item 3 of section 5 of `docs/roadmap.md`, its Python half.
- **Context:** the README says plugbricks does not care what is inside an image, and only Node services existed: nothing
  tested the claim.
- **Decision.**
  - **The option.** `--lang node|python`, with `--kind api` only (a web brick has one template). `node` stays the default.
  - **The brick is the same.** One manifest and one schema template for every language: the contract is the schema. Only
    the service folder differs (`templates/api/service-python`).
  - **Ariadne** (1.1.1) with uvicorn (0.54.0) on `python:3.13.18-alpine`: it starts from the SDL, so the schema of the
    brick stays the only one, and it has the federation entities. A library that builds the schema from classes would
    describe it twice.
  - **Requirements** pinned with their hashes (`requirements.in`, `requirements.txt` from `pip-compile --generate-hashes`,
    installed with `--require-hashes`), the equivalent of the Node template's lock file; Dependabot follows them.
  - **What it does like the Node one:** `/graphql` and `/health`, nothing else; no web explorer; a non-root image; an
    entity and its reference resolver; the message of an unexpected exception stays out of the answer (Ariadne passes it
    on by default: the template masks it, and lets a `GraphQLError` through).
  - **The health check** of the API brick now calls `http://127.0.0.1:4000/health`, not `localhost`: in the Python image
    `wget` resolves `localhost` to `::1`, and a server that listens on IPv4 only was reported unhealthy (found by running
    it). Bricks already created keep their manifest.
- **Tested.** CLI scenarios `create-api-python` (the same brick, a Python and a Node API composing) and the refusals; the
  packed package ships the template (`dist`: this check was written with D39, it was missing when D38 first said so); end
  to end on Docker Compose (`e2e-compose`): the Python image built with the printed
  command, `stockItems` through the router, then `dev` added a field. One mutation caught: `--lang` ignored. By hand: a
  Node API referring to an entity of the Python one (`_entities` across languages), an unexpected error masked and a
  `GraphQLError` passed with its code, `_service` answering, `docker stop` in under a second with exit code 0.
- **Not done.** Go (D39, done after); a Python web brick; token checks in
  either template (D28: no brick requires anything); Kubernetes for a Python service.

## D39. `create --kind api --lang go`: a service whose code is generated when the image is built

- **Status:** implemented (2026-11-26). Item 3 of section 5 of `docs/roadmap.md`, its Go half; with D37 and D38, chantier
  9 is done.
- **Context:** the Go library for a federation subgraph, gqlgen, writes Go code from the schema: where that generation
  happens had to be decided.
- **Decision.**
  - **gqlgen** (0.17.98) on `golang:1.27.4-alpine`, the binary copied alone into `alpine:3.24.4` (about 24 MB, against
    about 270 MB for the Node image), non-root, with `go.mod` and `go.sum` (every module verified by its checksum);
    Dependabot follows them.
  - **Generation in the image build,** from the schema of the brick (`go tool gqlgen generate`), so that the schema stays the
    only one and no generated file is committed. No resolver section in `gqlgen.yml`: gqlgen writes no stub, so a field
    without a resolver is a compile error that names the missing method, rather than a service that fails when the field is
    asked. For an editor, the same command runs in the service folder (the comment of `graph/resolver.go` gives it, and
    `.gitignore` of a new project ignores what it writes).
  - **Names.** `graph/resolver.go` names the types and methods that gqlgen will generate, so `create` follows gqlgen's naming
    rule, with its list of initialisms (`UserUrlItem` is `UserURLItem` in Go). The method comes from the field's name, the
    type from the type's: for `x-id`, `XIDItems` returns `[]*model.XIdItem`. A first version named both from the type and
    two names of forty-four did not compile.
  - **Like the other templates:** `/graphql` (POST only) and `/health`, no web explorer, introspection on, an entity and its
    resolver; the message of an unexpected error stays in the log (gqlgen passes it on by default: `graph/errors.go` masks
    it and lets a `*gqlerror.Error` through); a clean stop on SIGTERM.
- **Tested.** `test/create.test.ts` (sixteen names as gqlgen wrote them); CLI scenario `create-api-go`; the packed package
  ships the template; end to end on Docker Compose, a brick named `x-id` built with the printed command and queried through
  the router. Two mutations, each caught: the method named from the type, no initialisms. By hand: the names of 44 brick
  names compared with the code gqlgen generated (no difference); a Go API and a Node one composed; a field without a
  resolver stopped `dev` with the missing method, the platform unchanged; an unexpected error masked and logged, a
  `*gqlerror.Error` passed with its code; a Node API referring to an entity of the Go one; `_service` answering; `docker
  stop` immediate, exit code 0.
- **Limit.** A gqlgen update that changes its naming rule or its initialisms would break the template for some names: the
  end-to-end test builds one awkward name, and the list in `src/create.ts` says which version it comes from.
- **Not done.** A Go web brick; token checks; Kubernetes for a Go service.

## D40. A documentation site from the files of `docs/`, with its guide held to the code

- **Status:** implemented (2026-11-26); not published: enabling GitHub Pages is the owner's step
  (`docs/pre-publication-checklist.md`). Section 3 of `docs/roadmap.md`.
- **Context:** the documentation was `README.md`, 460 lines written along the milestones, and the decision log: nothing led a
  newcomer from nothing to a running platform.
- **Decision.**
  - **VitePress** 1.6.4 in `docs/`, a standalone package with its lock file (not a workspace: its dependencies are not those of
    the packages). The pages are the Markdown files of `docs/`, read in place. Vite is overridden to 6.4.6: VitePress 1 asks
    for Vite 5, whose development server has open advisories (`npm audit`: 3, then 0). Diagrams (`mermaid` 12.3.0) are drawn by
    a component of the theme, without a third-party plugin; links that leave `docs/` go to GitHub; raw HTML is off, so that
    `<name>` in a sentence stays text.
  - **The pages.** Home, a guide (`docs/guide/`: getting started, a project and its bricks, writing a service, writing a
    brick, databases queues and tokens, existing services, running, the admin, known limits), and "How it is built"
    (architecture, Keycloak, decisions, roadmap). The owner's checklist is left out.
  - **One place per fact.** The reference sections of `README.md` moved into the guide; the README keeps what plugbricks is,
    a quick start, the table of the pages, and what a contributor needs (from 463 lines to about 180).
  - **Held to the code** (`packages/create-plugbricks/test/docs.test.js`, in `npm test`): the commands of "Getting started"
    run in order against a project the generator writes, with Docker faked, and its queries are checked against the composed
    schema; every command and option the guide names is in `--help`; every manifest and fragment it shows is valid; every field
    of the manifest and every variable a provider gives is named.
  - **Publication.** The workflow `docs.yml` builds the site on a pull request that touches `docs/`, and on `main` deploys it
    only when the repository variable `PAGES_ENABLED` is `true`: until the owner enables Pages, `main` stays green and nothing
    is public. The actions are pinned by commit SHA.
- **Tested.** The site builds (a dead link between pages fails it); screenshots in headless Chrome of the home page, the guide
  and the architecture, whose six diagrams are drawn. The guide's test found two admin options missing from `--help`
  (`--issuer`, `--client-id`), now there. Three mutations, each caught: a query on a field that does not exist, an option that
  does not exist, an invalid manifest. By hand with Docker, "Getting started" from a clone: the API created, built, queried,
  changed with `dev` and queried again, `postgres` added, `down`; and the example shop (its web port changed, 8080 being taken
  on that machine): queried, its page answered 200.
- **Not tested.** The deployment itself, and whether the repository's token may deploy to Pages (a setting). The pages read on
  a phone. The commands of the other pages are checked for their names, not run.
- **Limit.** The screenshot of the admin's dependencies was from an earlier version when the site was written, and the
  page said so; the admin's screenshots were taken again on 2026-11-27.

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
