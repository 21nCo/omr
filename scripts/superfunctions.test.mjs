import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { superFunctionsOriginTransport } from "./superfunctions-origin.mjs";

const script = fileURLToPath(new URL("./superfunctions.mjs", import.meta.url));
const accepted = [
  ["https://github.com/21nCo/superfunctions.git", "https"],
  ["https://github.com/21nCo/superfunctions", "https"],
  ["https://github.com/21nco/SuperFunctions/", "https"],
  ["https://GitHub.com/21nCo/super-functions", "https"],
  ["https://github.com:443/21nCo/superfunctions.git", "https"],
  ["https://x-access-token@github.com/21nCo/superfunctions.git", "https"],
  ["https://github.com/21nCo/super-functions.git", "https"],
  ["git@github.com:21nCo/superfunctions.git", "ssh"],
  ["git@GitHub.com:21nCo/superfunctions.git", "ssh"],
  ["github.com:21nCo/super-functions", "ssh"],
  ["git@github.com:21nCo/super-functions.git", "ssh"],
  ["ssh://git@github.com/21nCo/superfunctions.git", "ssh"],
  ["ssh://github.com/21nCo/superfunctions.git", "ssh"],
  ["ssh://git@github.com:22/21nCo/superfunctions.git", "ssh"],
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
  "https://x-access-token:token@github.com/21nCo/superfunctions.git",
  "https://github.com/21nCo/superfunctions.git?ref=main",
  "http://github.com/21nCo/superfunctions.git",
  "git://github.com/21nCo/superfunctions.git",
  "ftp://github.com/21nCo/super-functions",
  "ftp://attacker.example/21nCo/superfunctions.git",
  "https://github.com:8443/21nCo/superfunctions.git",
  "https://github.com:22/21nCo/superfunctions.git",
  "ssh://git@evil.example/21nCo/superfunctions.git",
  "ssh://attacker@github.com/21nCo/superfunctions.git",
  "ssh://git@github.com:2222/21nCo/superfunctions.git",
  "ssh://git@github.com:443/21nCo/superfunctions.git",
  "git+ssh://git@github.com/21nCo/superfunctions.git",
  "git@evil.example:21nCo/superfunctions.git",
  "git@gitlab.com:21nCo/superfunctions.git",
  "attacker@github.com:21nCo/superfunctions.git",
  "GIT@github.com:21nCo/superfunctions.git",
  "git@github.com.attacker.example:21nCo/superfunctions.git",
  // SSH aliases are rejected even when the user's SSH config maps them to github.com.
  "git@github-21n:21nCo/superfunctions.git",
  "github.com-work:21nCo/superfunctions.git",
  "ssh://git@github-port:22/21nCo/superfunctions.git",
  "git@github-attacker.example:21nCo/superfunctions.git",
  "git@-oProxyCommand=id:21nCo/superfunctions.git",
  "ssh://-oProxyCommand=id/21nCo/superfunctions.git",
  "",
];

describe("Super Functions origin guard", () => {
  it.each(accepted)("accepts %s over %s", (url, transport) => {
    expect(superFunctionsOriginTransport(url)).toBe(transport);
  });

  it.each(rejected)("rejects %j", (url) => {
    expect(superFunctionsOriginTransport(url)).toBeNull();
  });

  describe("sf:status", () => {
    const roots = [];
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });

    // Hermetic: no user or system git config and no inherited git SSH overrides.
    function status(origin, { config = [], env = {} } = {}) {
      const root = mkdtempSync(join(tmpdir(), "omr-sf-origin-"));
      roots.push(root);
      const base = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      delete base.GIT_SSH_COMMAND;
      delete base.GIT_SSH;
      execFileSync("git", ["init", "--quiet", root], { env: base });
      execFileSync("git", ["-C", root, "remote", "add", "origin", origin], { env: base });
      for (const [key, value] of config) execFileSync("git", ["-C", root, "config", key, value], { env: base });
      return spawnSync(process.execPath, [script, "status"], {
        encoding: "utf8",
        env: { ...base, ...env, OMR_SUPERFUNCTIONS_WORKTREE: root },
      });
    }

    function expectOriginPassed(result) {
      expect(result.status).not.toBe(0);
      // An empty checkout fails at the first package manifest only after its origin passes.
      expect(result.stderr).toContain("Missing linked package manifest");
      expect(result.stderr).not.toContain("Unexpected Super Functions");
    }

    function expectRefused(result, message) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("Missing linked package manifest");
    }

    it.each([
      "https://github.com/21nCo/superfunctions.git",
      "https://github.com/21nCo/super-functions.git",
      "git@github.com:21nCo/superfunctions.git",
    ])("passes the origin check for %s", (origin) => {
      expectOriginPassed(status(origin));
    });

    it.each([
      "https://github.com/someone/superfunctions.git",
      "https://attacker.example/21nCo/superfunctions.git",
      "file:///21nCo/superfunctions.git",
      "https://github.com:8443/21nCo/superfunctions.git",
      "git@github-attacker.example:21nCo/superfunctions.git",
    ])("refuses %s before reading packages", (origin) => {
      expectRefused(status(origin), `Unexpected Super Functions origin: ${origin}`);
    });

    it("checks the URL after insteadOf rewriting", () => {
      const result = status("https://github.com/21nCo/superfunctions.git", {
        config: [["url.https://attacker.example/.insteadOf", "https://github.com/"]],
      });
      expectRefused(result, "Unexpected Super Functions origin: https://attacker.example/21nCo/superfunctions.git");
    });

    it.each([
      ["GIT_SSH_COMMAND", { env: { GIT_SSH_COMMAND: "ssh -o HostName=attacker.example" } }],
      ["GIT_SSH", { env: { GIT_SSH: "/tmp/attacker-ssh" } }],
      ["core.sshCommand", { config: [["core.sshCommand", "ssh -o HostName=attacker.example"]] }],
    ])("refuses an SSH origin when %s selects a custom SSH program", (source, options) => {
      expectRefused(
        status("git@github.com:21nCo/superfunctions.git", options),
        `Unexpected Super Functions SSH command: ${source}=`,
      );
    });

    it("ignores git SSH settings for an HTTPS origin", () => {
      expectOriginPassed(
        status("https://github.com/21nCo/superfunctions.git", {
          config: [["core.sshCommand", "ssh -o HostName=attacker.example"]],
          env: { GIT_SSH_COMMAND: "ssh -o HostName=attacker.example" },
        }),
      );
    });
  });
});
