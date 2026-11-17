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
  for the rollout deadline). The decision stands. That run shows the driver works; it does not
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

- **Status:** implemented for the rendering (milestone 4, step 4b-3). The router has been run by hand
  against its image with fake subgraphs; no end-to-end test runs it yet (4b-4 on Compose, 4b-5 on
  Kubernetes).
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
- **Verified on Docker only:** `runAsNonRoot` (a numeric `runAsUser` 65532), `readOnlyRootFilesystem` and the
  HTTP probes were verified by running the image with Docker (`--user`, `--read-only`, `curl` on the health paths),
  not on a kubelet. They are verified on a kubelet only by the k3d CI job, which runs the router for the first
  time when this is merged; until it is green, treat the Kubernetes security context and probes as unverified.
- **Not verified:** the router on a Kubernetes cluster (no cluster was used); `securityContext` and the
  probes on a real kubelet; a query that goes through the router to real subgraphs (the manual check used
  fake ones); macOS and Windows (the rendering is pure text, the router runs only in Linux containers);
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
