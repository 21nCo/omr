import { execFileSync } from "node:child_process";

const owner = "21nco";
// GitHub renamed super-functions to superfunctions; existing clones keep the legacy remote.
const repositories = new Set(["superfunctions", "super-functions"]);
// Plain host names or ~/.ssh/config aliases only; this also keeps `ssh -G` from parsing options.
const sshHost = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Accept a `21nCo/superfunctions` remote under its canonical or legacy name, but only when
 * its effective endpoint is GitHub. HTTPS must target `github.com` on the default port. SSH
 * remotes (`ssh://[git@]host[:22]/` or scp-style `[git@]host:`) are trusted only after
 * `resolveSsh` reports that the destination, after the user's SSH configuration, is
 * `github.com` on port 22, so aliases such as `github-21n` work while the name alone is never
 * trusted. A resolver failure, every other scheme (http, git, file, ftp, ...), port, host and
 * local path is rejected, and the path must be exactly owner/repository.
 *
 * @param {string} url Remote URL after `insteadOf` rewriting (`git remote get-url origin`).
 * @param {{ resolveSsh?: (destination: string) => { hostname: string, port: string } }} [options]
 */
export function isSuperFunctionsOrigin(url, { resolveSsh = resolveSshDestination } = {}) {
  const remote = parseRemote(url.trim());
  if (remote === null) return false;
  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.path);
  if (match === null || match[1].toLowerCase() !== owner || !repositories.has(match[2].toLowerCase())) {
    return false;
  }
  if (remote.ssh === undefined) return true;
  try {
    const destination = resolveSsh(remote.ssh);
    return destination.hostname.toLowerCase() === "github.com" && destination.port === "22";
  } catch {
    return false;
  }
}

/**
 * Report where OpenSSH would connect for `destination` (`[user@]host`), using `ssh -G`.
 *
 * @param {string} destination
 */
export function resolveSshDestination(destination) {
  const config = execFileSync("ssh", ["-G", destination], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const value = (key) => new RegExp(`^${key} (\\S+)$`, "m").exec(config)?.[1] ?? "";
  return { hostname: value("hostname"), port: value("port") };
}

function parseRemote(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.search || parsed.hash) return null;
    const host = parsed.hostname.toLowerCase();
    // WHATWG URL drops a default port, so an explicit :443 parses as "".
    if (parsed.protocol === "https:") return host === "github.com" && parsed.port === "" ? { path: parsed.pathname } : null;
    if (parsed.protocol !== "ssh:" || parsed.password || !["", "22"].includes(parsed.port)) return null;
    return sshRemote(parsed.username, host, parsed.pathname);
  }
  const scp = /^(?:([^@/:]+)@)?([^@/:]+):(?!\/)(.+)$/.exec(url);
  return scp === null ? null : sshRemote(scp[1] ?? "", scp[2], scp[3]);
}

function sshRemote(user, host, path) {
  if ((user !== "" && user !== "git") || !sshHost.test(host)) return null;
  return { path, ssh: user === "" ? host : `${user}@${host}` };
}
