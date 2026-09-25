import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lock = JSON.parse(
  readFileSync(join(repositoryRoot, "superfunctions.lock.json"), "utf8"),
) as {
  schemaVersion: number;
  mode: string;
  repository: string;
  branch: string;
  baseSha: string;
  defaultRelativePath: string;
  packages: Array<{ name: string; path: string }>;
};
const configuredRoot = process.env.OMR_SUPERFUNCTIONS_WORKTREE ?? lock.defaultRelativePath;
const superfunctionsRoot = isAbsolute(configuredRoot)
  ? resolve(configuredRoot)
  : resolve(repositoryRoot, configuredRoot);

describe("phase 00 dependency provenance", () => {
  it("accepts the dedicated Super Functions worktree", () => {
    expect(lock.schemaVersion).toBe(1);
    expect(lock.mode).toBe("local-worktree");
    expect(lock.repository).toBe("https://github.com/21nCo/super-functions.git");
    expect(existsSync(join(superfunctionsRoot, ".git"))).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: superfunctionsRoot,
        encoding: "utf8",
      }).trim(),
    ).toBe(lock.branch);
  });

  it("rejects a package name or path mismatch", () => {
    expect(lock.packages.length).toBeGreaterThan(0);
    expect(new Set(lock.packages.map(({ name }) => name)).size).toBe(lock.packages.length);
    expect(new Set(lock.packages.map(({ path }) => path)).size).toBe(lock.packages.length);

    for (const dependency of lock.packages) {
      const manifestPath = join(superfunctionsRoot, dependency.path, "package.json");
      expect(existsSync(manifestPath), manifestPath).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.name, manifestPath).toBe(dependency.name);
    }
  });

  it("records an upstream base commit that remains in worktree history", () => {
    expect(lock.baseSha).toMatch(/^[0-9a-f]{40}$/);
    const result = spawnSync("git", ["merge-base", "--is-ancestor", lock.baseSha, "HEAD"], {
      cwd: superfunctionsRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps .conduct outside the repository contract", () => {
    const result = spawnSync("git", ["check-ignore", ".conduct"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(".conduct");
  });
});
