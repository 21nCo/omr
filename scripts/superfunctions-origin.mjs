const owner = "21nco";
// GitHub renamed super-functions to superfunctions; existing clones keep the legacy remote.
const repositories = new Set(["superfunctions", "super-functions"]);

/**
 * Accept a `21nCo/superfunctions` remote under its canonical or legacy name, over
 * HTTPS, ssh:// or scp-style SSH (including host aliases). The path must be exactly
 * owner/repository, so forks, other repositories and local paths are rejected.
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
    try {
      return new URL(url).pathname;
    } catch {
      return null;
    }
  }
  return /^(?:[^@/:]+@)?[^@/:]+:(?!\/)(.+)$/.exec(url)?.[1] ?? null;
}
