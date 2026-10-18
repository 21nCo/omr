const owner = "21nco";
// GitHub renamed super-functions to superfunctions; existing clones keep the legacy remote.
const repositories = new Set(["superfunctions", "super-functions"]);
// Host, owner and repository are captured as ASCII and compared case-insensitively below.
const path = String.raw`([A-Za-z0-9-]+)\/([A-Za-z0-9-]+?)(?:\.git)?\/?$`;
const forms = [
  ["https", new RegExp(String.raw`^https:\/\/(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+)(?::443)?\/${path}`)],
  ["ssh", new RegExp(String.raw`^ssh:\/\/(?:git@)?([A-Za-z0-9.-]+)(?::22)?\/${path}`)],
  ["ssh", new RegExp(String.raw`^(?:git@)?([A-Za-z0-9.-]+):${path}`)],
];

/**
 * Classify a Super Functions `origin` URL by the literal endpoint it names: `"https"` for
 * `https://[user@]github.com[:443]/`, `"ssh"` for `ssh://[git@]github.com[:22]/` or
 * scp-style `[git@]github.com:`, and `null` for anything else. The path must be exactly
 * `21nCo/superfunctions` or the legacy `21nCo/super-functions`, optionally with `.git` and a
 * trailing slash. The raw string is matched against this ASCII grammar, not parsed as a WHATWG
 * URL, so text that only names github.com after URL canonicalization (non-ASCII, percent
 * escapes, dot segments, backslashes, whitespace or control characters) is rejected, as are SSH
 * aliases (even ones your SSH config maps to github.com), other hosts, ports, schemes, users,
 * query strings, fragments, HTTPS passwords and local paths.
 *
 * This is a static misconfiguration guard, not an attestation of the endpoint git contacts:
 * local SSH config, `PATH` and git config are trusted. It does not prove package content
 * either: the developer chooses the checked-out revision, and `sf:status` only reports
 * whether it descends from the locked `baseSha` (`baseIsAncestor`); no command enforces it.
 *
 * @param {string} url Remote URL after `insteadOf` rewriting (`git remote get-url origin`),
 *   untrimmed.
 * @returns {"https" | "ssh" | null}
 */
export function superFunctionsOriginTransport(url) {
  for (const [transport, form] of forms) {
    const [, host, user, repository] = form.exec(url) ?? [];
    if (host?.toLowerCase() !== "github.com" || user.toLowerCase() !== owner) continue;
    if (repositories.has(repository.toLowerCase())) return transport;
  }
  return null;
}
