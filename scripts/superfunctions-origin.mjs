const owner = "21nco";
// GitHub renamed super-functions to superfunctions; existing clones keep the legacy remote.
const repositories = new Set(["superfunctions", "super-functions"]);

/**
 * Classify a Super Functions `origin` URL by the literal endpoint it names: `"https"` for
 * `https://github.com/` on the default port, `"ssh"` for `ssh://[git@]github.com[:22]/` or
 * scp-style `[git@]github.com:`, and `null` for anything else. The path must be exactly
 * `21nCo/superfunctions` or the legacy `21nCo/super-functions`. SSH aliases (even ones your
 * SSH config maps to github.com), other hosts, ports, schemes, users, query strings, HTTPS
 * passwords and local paths are rejected.
 *
 * This is a static misconfiguration guard, not an attestation of the endpoint git contacts:
 * local SSH config, `PATH` and git config are trusted. It does not prove package content
 * either: the developer chooses the checked-out revision, and `sf:status` only reports
 * whether it descends from the locked `baseSha` (`baseIsAncestor`); no command enforces it.
 *
 * @param {string} url Remote URL after `insteadOf` rewriting (`git remote get-url origin`).
 * @returns {"https" | "ssh" | null}
 */
export function superFunctionsOriginTransport(url) {
  const remote = parseRemote(url.trim());
  if (remote === null) return null;
  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.path);
  if (match?.[1].toLowerCase() !== owner || !repositories.has(match[2].toLowerCase())) return null;
  return remote.transport;
}

/**
 * Split a remote into its transport and repository path when it literally targets GitHub,
 * or return `null`.
 *
 * @param {string} url
 * @returns {{ transport: "https" | "ssh", path: string } | null}
 */
function parseRemote(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // WHATWG URL drops a default port, so an explicit :443 parses as "" and :22 stays "22".
    const port = parsed.protocol === "https:" ? "" : "22";
    if (parsed.search || parsed.hash || parsed.password || !["", port].includes(parsed.port)) return null;
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    if (parsed.protocol === "https:") return { transport: "https", path: parsed.pathname };
    if (parsed.protocol !== "ssh:" || !["", "git"].includes(parsed.username)) return null;
    return { transport: "ssh", path: parsed.pathname };
  }
  const scp = /^(?:git@)?([^@/:]+):(?!\/)(.+)$/.exec(url);
  return scp?.[1].toLowerCase() === "github.com" ? { transport: "ssh", path: scp[2] } : null;
}
