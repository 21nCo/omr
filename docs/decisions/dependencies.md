# Dependency development model

OMR develops against a dedicated local worktree of `21nCo/super-functions` instead of relying on published npm packages.

- Default worktree: `../../../worktrees/superfunctions/omr-upstream`
- Upstream branch: `omr/upstream`
- Required revision: the `origin/omr/upstream` commit recorded in `superfunctions.lock.json`
- Override for another checkout: set `OMR_SUPERFUNCTIONS_WORKTREE` to an absolute path

Generic fixes discovered while building OMR belong in the Super Functions worktree. OMR-specific authorization, product state, UI, and policy remain in this repository.

The committed lock records the expected repository, minimum required upstream commit, and package-to-path mapping. Check out that commit (or a descendant on `omr/upstream`) in the separate worktree. `.superfunctions.local.json` is generated locally and records the currently linked worktree state; it is intentionally ignored.

Use:

```sh
npm run sf:status
npm run sf:install
npm run sf:build
npm run sf:link
npm run sf:smoke
```

`sf:link` creates repository-local symlinks under OMR's `node_modules`; it does not mutate global npm links. A regular file or directory at a target path is never overwritten.

`sf:smoke` imports every Node-loadable linked package through Node's normal package resolution. This catches missing builds, invalid exports, and links that accidentally resolve to registry packages. Svelte component packages are resolved without importing because their `.svelte` exports require a bundler loader.
