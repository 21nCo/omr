import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isSuperFunctionsOrigin } from "./superfunctions-origin.mjs";

const script = fileURLToPath(new URL("./superfunctions.mjs", import.meta.url));
// Stands in for `ssh -G`: github-21n is an alias for github.com; other names resolve to themselves.
const sshConfig = {
  "github-21n": { hostname: "github.com", port: "22" },
  "github.com-work": { hostname: "GitHub.com", port: "22" },
  "github-port": { hostname: "github.com", port: "2222" },
  "github-elsewhere": { hostname: "attacker.example", port: "22" },
};
const resolved = [];
function resolveSsh(destination) {
  resolved.push(destination);
  const host = destination.replace(/^git@/, "");
  return sshConfig[host] ?? { hostname: host, port: "22" };
}
const accepted = [
  "https://github.com/21nCo/superfunctions.git",
  "https://github.com/21nCo/superfunctions",
  "https://github.com/21nco/SuperFunctions/",
  "https://github.com:443/21nCo/superfunctions.git",
  "git@github.com:21nCo/superfunctions.git",
  "git@github-21n:21nCo/superfunctions.git",
  "ssh://git@github.com/21nCo/superfunctions.git",
  "ssh://github.com/21nCo/superfunctions.git",
  "ssh://git@github.com:22/21nCo/superfunctions.git",
  "ssh://git@github-21n/21nCo/superfunctions.git",
  "https://x-access-token:token@github.com/21nCo/superfunctions.git",
  "github.com:21nCo/superfunctions.git",
  "git@github.com-work:21nCo/superfunctions.git",
  "https://github.com/21nCo/super-functions.git",
  "git@github.com:21nCo/super-functions.git",
];
const rejected = [
  "https://github.com/someone/superfunctions.git",
  "https://github.com/21nCo/superfunctions-fork.git",
  "https://github.com/21nCo/omr.git",
  "https://github.com/someone/21nCo/superfunctions.git",
  "git@github.com:someone/super-functions.git",
  "/srv/mirrors/21nCo/superfunctions.git",
  "file:///srv/mirrors/21nCo/superfunctions.git",
  "file:///21nCo/superfunctions.git",
  "https://attacker.example/21nCo/superfunctions.git",
  "https://gitlab.com/21nCo/superfunctions.git",
  "https://github.com.attacker.example/21nCo/superfunctions.git",
  "https://github.com@attacker.example/21nCo/superfunctions.git",
  "http://github.com/21nCo/superfunctions.git",
  "git://github.com/21nCo/superfunctions.git",
  "ftp://github.com/21nCo/super-functions",
  "ftp://attacker.example/21nCo/superfunctions.git",
  "ssh://git@evil.example/21nCo/superfunctions.git",
  "ssh://attacker@github.com/21nCo/superfunctions.git",
  "git+ssh://git@github.com/21nCo/superfunctions.git",
  "git@evil.example:21nCo/superfunctions.git",
  "git@gitlab.com:21nCo/superfunctions.git",
  "attacker@github.com:21nCo/superfunctions.git",
  "https://github.com:8443/21nCo/superfunctions.git",
  "ssh://git@github.com:2222/21nCo/superfunctions.git",
  "git@github-attacker.example:21nCo/superfunctions.git",
  "github.com-evil.net:21nCo/superfunctions.git",
  "git@github-port:21nCo/superfunctions.git",
  "git@github-elsewhere:21nCo/superfunctions.git",
  "ssh://git@github-elsewhere/21nCo/superfunctions.git",
  "git@-oProxyCommand=id:21nCo/superfunctions.git",
  "-oProxyCommand=id:21nCo/superfunctions.git",
  "",
];

describe("Super Functions origin guard", () => {
  it.each(accepted)("accepts %s", (url) => {
    expect(isSuperFunctionsOrigin(url, { resolveSsh })).toBe(true);
  });

  it.each(rejected)("rejects %j", (url) => {
    expect(isSuperFunctionsOrigin(url, { resolveSsh })).toBe(false);
  });

  it("resolves the SSH destination git would use", () => {
    resolved.length = 0;
    isSuperFunctionsOrigin("git@github-21n:21nCo/superfunctions.git", { resolveSsh });
    isSuperFunctionsOrigin("ssh://github.com/21nCo/superfunctions.git", { resolveSsh });
    expect(resolved).toEqual(["git@github-21n", "github.com"]);
  });

  it("rejects an SSH remote when its destination cannot be resolved", () => {
    const unavailable = () => {
      throw new Error("spawnSync ssh ENOENT");
    };
    expect(isSuperFunctionsOrigin("git@github.com:21nCo/superfunctions.git", { resolveSsh: unavailable })).toBe(false);
  });

  it("never resolves a host that ssh would parse as an option", () => {
    resolved.length = 0;
    isSuperFunctionsOrigin("git@-oProxyCommand=id:21nCo/superfunctions.git", { resolveSsh });
    isSuperFunctionsOrigin("ssh://-oProxyCommand=id/21nCo/superfunctions.git", { resolveSsh });
    expect(resolved).toEqual([]);
  });

  describe("sf:status", () => {
    const roots = [];
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });

    function status(origin, config = []) {
      const root = mkdtempSync(join(tmpdir(), "omr-sf-origin-"));
      roots.push(root);
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
      for (const [key, value] of config) execFileSync("git", ["-C", root, "config", key, value]);
      return spawnSync(process.execPath, [script, "status"], {
        encoding: "utf8",
        env: { ...process.env, OMR_SUPERFUNCTIONS_WORKTREE: root },
      });
    }

    // An empty checkout fails at the first package manifest only after its origin passes.
    it.each([
      "https://github.com/21nCo/superfunctions.git",
      "https://github.com/21nCo/super-functions.git",
    ])("passes the origin check for %s", (origin) => {
      const result = status(origin);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Missing linked package manifest");
      expect(result.stderr).not.toContain("Unexpected Super Functions origin");
    });

    it.each([
      "https://github.com/someone/superfunctions.git",
      "https://attacker.example/21nCo/superfunctions.git",
      "file:///21nCo/superfunctions.git",
      "https://github.com:8443/21nCo/superfunctions.git",
      // Uses the real `ssh -G`, which resolves an unconfigured alias to itself.
      "git@github-attacker.example:21nCo/superfunctions.git",
    ])("refuses %s before reading packages", (origin) => {
      const result = status(origin);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Unexpected Super Functions origin: ${origin}`);
      expect(result.stderr).not.toContain("Missing linked package manifest");
    });

    it("checks the URL after insteadOf rewriting", () => {
      const result = status("https://github.com/21nCo/superfunctions.git", [
        ["url.https://attacker.example/.insteadOf", "https://github.com/"],
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unexpected Super Functions origin: https://attacker.example/21nCo/superfunctions.git");
      expect(result.stderr).not.toContain("Missing linked package manifest");
    });
  });
});
