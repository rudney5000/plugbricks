# config/

Your own configuration files: settings your services read that are **not secret**
(feature flags, limits, URLs of public services).

- Commit this folder.
- Never put a password, token or key here: those belong in `.secrets/`, which git ignores.
