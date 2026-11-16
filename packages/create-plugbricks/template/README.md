# {{name}}

A platform managed by [plugbricks](https://github.com/rudney5000/plugbricks): you describe
which **bricks** you want (a database, your own services, …) and plugbricks keeps track of
them and of what they need from each other.

## What is in this folder

| Path | What it is | Commit it? | Edit it by hand? |
|---|---|---|---|
| `platform.json` | **What you want**: the list of installed bricks and where each came from. | yes | no, use `plugbricks add` / `remove` |
| `platform.lock` | **What plugbricks resolved**: exact versions, a fingerprint of every brick, which brick provides which capability, the volumes kept after a removal, and the volumes waiting to be deleted (deleted only when you ask for it explicitly). | yes | never |
| `.platform/bricks/` | A **copy of every installed brick**, so the project does not depend on where a brick came from. `plugbricks status` warns if a copy was changed. | yes | never |
| `services/` | **Your own services.** Each folder is a brick: a `plugin.json` that says what the service is, plus its files. `services/orders/` is an example to start from. | yes | yes, this is your code |
| `config/` | **Your non-secret settings** that services read. | yes | yes |
| `.generated/` | Files **produced by plugbricks** (Docker Compose files, Kubernetes manifests) when the drivers arrive. Always rebuilt from the files above. | no (ignored) | never |
| `.secrets/` | **Passwords and keys** created on this machine. Restricted to your user (mode 700 on Linux and macOS, an ACL on Windows); if that fails you get a `SECRETS_NOT_RESTRICTED` warning. | **never** (ignored) | no |
| `.gitattributes` | Keeps LF line endings on every OS, so brick scripts still run in Linux containers. | yes | rarely |
| `package.json` | Installs the `plugbricks` command for this project. | yes | rarely |

## First steps

```bash
npm install                 # installs the plugbricks command locally
npx plugbricks status       # an empty platform: no bricks yet
```

`services/orders` needs a `database`, so add a brick that provides one first. There is no
brick catalog yet: point `add` at a brick folder, for example the `postgres` example of the
plugbricks repository.

```bash
npx plugbricks add path/to/postgres     # provides "database"
npx plugbricks add services/orders      # requires "database": now satisfied
npx plugbricks status
```

What plugbricks refuses, and why:

- adding a brick whose required capability no installed brick provides;
- adding a second brick with the same name, or a second provider of the same capability;
- removing a brick that another brick still needs.

Every refusal prints a stable code such as `error REQUIRED_CAPABILITY_MISSING: …`.

Starting and stopping the platform (`plugbricks up` / `down`, on Docker Compose or
Kubernetes) comes in a later version.
