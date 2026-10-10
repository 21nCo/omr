import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isSuperFunctionsOrigin } from "./superfunctions-origin.mjs";

const script = fileURLToPath(new URL("./superfunctions.mjs", import.meta.url));
const accepted = [
  "https://github.com/21nCo/superfunctions.git",
  "https://github.com/21nCo/superfunctions",
  "https://github.com/21nco/SuperFunctions/",
  "git@github.com:21nCo/superfunctions.git",
  "git@github-21n:21nCo/superfunctions.git",
  "ssh://git@github.com/21nCo/superfunctions.git",
  "ssh://github.com/21nCo/superfunctions.git",
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
  "",
];

describe("Super Functions origin guard", () => {
  it.each(accepted)("accepts %s", (url) => {
    expect(isSuperFunctionsOrigin(url)).toBe(true);
  });

  it.each(rejected)("rejects %j", (url) => {
    expect(isSuperFunctionsOrigin(url)).toBe(false);
  });

  describe("sf:status", () => {
    const roots = [];
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function status(origin) {
      const root = mkdtempSync(join(tmpdir(), "omr-sf-origin-"));
      roots.push(root);
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
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
    ])("refuses %s before reading packages", (origin) => {
      const result = status(origin);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Unexpected Super Functions origin: ${origin}`);
      expect(result.stderr).not.toContain("Missing linked package manifest");
    });
  });
});
