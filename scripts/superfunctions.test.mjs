import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { superFunctionsOriginTransport } from "./superfunctions-origin.mjs";

const script = fileURLToPath(new URL("./superfunctions.mjs", import.meta.url));
// Synthetic credentials are built at runtime so no committed file holds a credential-bearing URL.
const secret = `synth${randomUUID().replaceAll("-", "")}`;
/** `user:<secret>@`, the userinfo of a credential-bearing origin. */
const credentials = (user) => `${user}:${secret}@`;
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
  `https://${credentials("x-access-token")}github.com/21nCo/superfunctions.git`,
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

    /** Run sf:status against a fresh repo, in directory `dir` of a temporary root, whose origin is `origin`. */
    function status(origin, { config = [], env = {}, dir } = {}) {
      const tempRoot = mkdtempSync(join(tmpdir(), "omr-sf-origin-"));
      roots.push(tempRoot);
      const root = dir === undefined ? tempRoot : join(tempRoot, dir);
      // Hermetic: no inherited GIT_CONFIG_* overrides, user or system git config, or git SSH overrides.
      const base = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("GIT_CONFIG_") && key !== "GIT_SSH_COMMAND" && key !== "GIT_SSH",
        ),
      );
      base.GIT_CONFIG_GLOBAL = "/dev/null";
      base.GIT_CONFIG_NOSYSTEM = "1";
      mkdirSync(root, { recursive: true });
      execFileSync("git", ["init", "--quiet", root], { env: base });
      execFileSync("git", ["-C", root, "remote", "add", "origin", origin], { env: base });
      for (const [key, value] of config) execFileSync("git", ["-C", root, "config", key, value], { env: base });
      const result = spawnSync(process.execPath, [script, "status"], {
        encoding: "utf8",
        env: { ...base, ...env, OMR_SUPERFUNCTIONS_WORKTREE: root },
      });
      return { ...result, tempRoot, root, env: base };
    }

    /** Assert the origin check passed and the run then failed on the empty checkout. */
    function expectOriginPassed(result) {
      expect(result.status).not.toBe(0);
      // An empty checkout fails at the first package manifest only after its origin passes.
      expect(result.stderr).toContain("Missing linked package manifest");
      expect(result.stderr).not.toContain("Unexpected Super Functions");
    }

    /** Assert the run was refused with `message` before any package manifest was read. */
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
    ])("refuses %s before reading packages, without printing it", (origin) => {
      const result = status(origin);
      expectRefused(result, "Unexpected Super Functions origin in ");
      expect(result.stderr).toContain("(expected https://github.com/21nCo/superfunctions.git)");
      expect(result.stdout + result.stderr).not.toContain(origin);
    });

    // A token can sit in any part of an untrusted origin, so no part of a rejected one is printed.
    it.each([
      `https://github.com/${secret}/21nCo/superfunctions.git`,
      `git@github.com:${secret}/21nCo/superfunctions.git`,
      `https://${secret}.example/21nCo/superfunctions.git`,
      `https://mirror.example/${secret}/superfunctions.git`,
      `https://${credentials("x-access-token")}github.com/21nCo/superfunctions.git`,
      `https:/${credentials("x-access-token")}github.com/21nCo/superfunctions.git`,
      `https:${credentials("x-access-token")}github.com/21nCo/superfunctions.git`,
      `https://github.com/21nCo/superfunctions.git?token=${secret}`,
      `https://${secret}@[bad/21nCo/superfunctions.git`,
      `${secret}@github.com:21nCo/superfunctions.git`,
      `github.com/${credentials("u")}21nCo/superfunctions.git`,
      `ext::ssh -i ${secret} host`,
      `fd::${secret}`,
      `\\\\host\\${credentials("u")}x`,
      `./${credentials(secret)}x`,
      `/srv/${secret}/21nCo/superfunctions.git`,
    ])("refuses %s without printing any part of it", (origin) => {
      const result = status(origin);
      expectRefused(result, "Unexpected Super Functions origin");
      expect(result.stdout + result.stderr).not.toContain(secret);
    });

    it("checks the URL after insteadOf rewriting", () => {
      const result = status("https://github.com/21nCo/superfunctions.git", {
        config: [["url.https://attacker.example/.insteadOf", "https://github.com/"]],
      });
      expectRefused(result, "Unexpected Super Functions origin in ");
      expect(result.stdout + result.stderr).not.toContain("attacker.example");
    });

    // Shell syntax in the worktree path must not reach a command the user is told to copy.
    it.each([
      "sf $(touch MARK)",
      "sf `touch MARK`",
      `sf "$(touch MARK)" 'q' $HOME`,
    ])("suggests an inspect command that runs literally in worktree %j", (dir) => {
      const result = status("https://attacker.example/21nCo/superfunctions.git", { dir });
      expectRefused(result, `Unexpected Super Functions origin in ${result.root} (`);
      expect(result.stderr).not.toContain("attacker.example");
      const command = /run `([^`]+)` inside that worktree/.exec(result.stderr)?.[1];
      expect(command).toBe("git remote get-url origin");
      const output = execFileSync("sh", ["-c", command], { cwd: result.root, encoding: "utf8", env: result.env });
      expect(output.trim()).toBe("https://attacker.example/21nCo/superfunctions.git");
      expect(existsSync(join(result.tempRoot, "MARK"))).toBe(false);
      expect(existsSync(join(result.root, "MARK"))).toBe(false);
    });

    it.each([
      ["GIT_SSH_COMMAND", { env: { GIT_SSH_COMMAND: `ssh -o ProxyCommand='curl -H token:${secret} x'` } }],
      ["GIT_SSH", { env: { GIT_SSH: `/tmp/${secret}/ssh` } }],
      ["core.sshCommand", { config: [["core.sshCommand", `ssh -i /tmp/${secret}`]] }],
    ])("refuses an SSH origin when %s selects a custom SSH program, naming only the setting", (source, options) => {
      const result = status("git@github.com:21nCo/superfunctions.git", options);
      expectRefused(result, `Unexpected Super Functions SSH command set by ${source} (`);
      expect(result.stdout + result.stderr).not.toContain(secret);
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
