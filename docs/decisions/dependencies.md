# Dependency development model

OMR develops against a dedicated local worktree of `21nCo/superfunctions` instead of relying on published npm packages.

- Default worktree: `../../../worktrees/superfunctions/omr-upstream`
- Upstream branch: `omr/upstream`
- Required revision: the `origin/omr/upstream` commit recorded in `superfunctions.lock.json`
- Override for another checkout: set `OMR_SUPERFUNCTIONS_WORKTREE` to an absolute path

Generic fixes discovered while building OMR belong in the Super Functions worktree. OMR-specific authorization, product state, UI, and policy remain in this repository.

The committed lock records the expected repository, minimum required upstream commit, and package-to-path mapping. The worktree's `origin` must literally name `21nCo/superfunctions` on GitHub, checked after git's `url.<base>.insteadOf` rewriting (`git remote get-url origin`). HTTPS remotes must use `https://github.com/` on the default port, without a password, query or fragment. SSH remotes must use `ssh://[git@]github.com/` (optionally `:22`) or scp-style `[git@]github.com:`. SSH aliases such as `github-21n` are rejected even when your SSH config maps them to github.com; alias users keep the HTTPS fetch URL (an SSH `pushurl` is fine). An SSH origin is also rejected when git would run a custom SSH program through `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`. Clones that still use the pre-rename `21nCo/super-functions` remote are also accepted. Any other host, port, scheme (`http`, `git`, `file`, `ftp`, ...), SSH user than `git`, local path, or repository is rejected before packages are read or built. This is a static misconfiguration check, not proof of the endpoint git contacts: local SSH config, `PATH` and git config are trusted. Rejection messages never print any part of a rejected origin, since a token can sit in its userinfo, host, path or query: they name only the worktree and the expected repository, so inspect the value yourself by running `git remote get-url origin` inside that worktree. The suggested command never embeds the worktree path, so copying it cannot run shell syntax from a directory name. A custom SSH setting is reported by name only, never by value. Nor does the check prove package content: you choose the checked-out revision, and `npm run sf:status` only reports whether it descends from the locked `baseSha` (`baseIsAncestor`); `sf:install`, `sf:build` and `sf:link` do not enforce it. Check out that commit (or a descendant on `omr/upstream`) in the separate worktree. `.superfunctions.local.json` is generated locally and records the currently linked worktree state; it is intentionally ignored.

Use:

```sh
npm run sf:status
npm run sf:install
npm run sf:build
npm run sf:link
npm run sf:smoke
```

`sf:link` creates repository-local symlinks under OMR's `node_modules`; it does not mutate global npm links. A regular file or directory at a target path is never overwritten.

A clean CI checkout needs the same bootstrap before `npm run test:prepare` or `npm test`: `npm ci --ignore-scripts` in OMR, then a checkout of `21nCo/superfunctions` at the locked `omr/upstream` revision (or a descendant), followed by `sf:install`, `sf:build`, and `sf:link` with `OMR_SUPERFUNCTIONS_WORKTREE` pointing at that checkout. `sf:install` also uses `npm ci --ignore-scripts` in the locked tree. Both installs use their committed lockfiles without running dependency lifecycle scripts; explicit build commands run only after installation. OMR's npm lockfile intentionally does not publish or install those local packages. Running `test:prepare` after only `npm ci` leaves imports such as `@datafn/server` and `@superfunctions/db` unresolved. The `Vault contract` PR workflow performs this bootstrap at the exact locked revision and invokes the installed Vitest binary directly; missing local binaries fail the job instead of triggering on-demand installation. It requires package preparation, focused vault, settings, and route tests, and the full `npm test` suite to pass. A review bot that runs its own shell commands must also bootstrap before interpreting its test result; a provider usage-limit failure is a separate review-service gate.

`sf:smoke` imports every Node-loadable linked package through Node's normal package resolution. This catches missing builds, invalid exports, and links that accidentally resolve to registry packages. Svelte component packages are resolved without importing because their `.svelte` exports require a bundler loader.
