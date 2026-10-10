const owner = "21nco";
// GitHub renamed super-functions to superfunctions; existing clones keep the legacy remote.
const repositories = new Set(["superfunctions", "super-functions"]);
// Multi-account SSH setups alias github.com in ~/.ssh/config, e.g. `github-21n` or `github.com-work`.
const sshAlias = /^github(?:\.com)?-[a-z0-9][a-z0-9._-]*$/i;

/**
 * Accept a `21nCo/superfunctions` remote under its canonical or legacy name. Allowed
 * transports are `https://github.com/`, `ssh://[git@]github.com/` and scp-style
 * `[git@]github.com:` or a `github-*` / `github.com-*` SSH alias, which the user's SSH
 * configuration must map to github.com. Every other scheme (http, git, file, ftp, ...),
 * host and local path is rejected, and the path must be exactly owner/repository, so
 * forks and other repositories are rejected too.
 */
export function isSuperFunctionsOrigin(url) {
  const path = originPath(url.trim());
  const match = path === null ? null : /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(path);
  return match !== null &&
    match[1].toLowerCase() === owner &&
    repositories.has(match[2].toLowerCase());
}

function originPath(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash) return null;
    if (parsed.protocol === "https:") return parsed.pathname;
    if (parsed.protocol === "ssh:" && sshUser(parsed.username) && !parsed.password) return parsed.pathname;
    return null;
  }
  const scp = /^(?:([^@/:]+)@)?([^@/:]+):(?!\/)(.+)$/.exec(url);
  if (scp === null || !sshUser(scp[1] ?? "")) return null;
  return scp[2].toLowerCase() === "github.com" || sshAlias.test(scp[2]) ? scp[3] : null;
}

function sshUser(user) {
  return user === "" || user === "git";
}
