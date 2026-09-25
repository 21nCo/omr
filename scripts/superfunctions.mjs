import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repositoryRoot, "superfunctions.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const configuredRoot = process.env.OMR_SUPERFUNCTIONS_WORKTREE ?? lock.defaultRelativePath;
const superfunctionsRoot = isAbsolute(configuredRoot)
  ? resolve(configuredRoot)
  : resolve(repositoryRoot, configuredRoot);
const command = process.argv[2] ?? "status";

function run(program, args, options = {}) {
  return execFileSync(program, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function capture(program, args, cwd = superfunctionsRoot) {
  return run(program, args, { cwd, capture: true }).trim();
}

function assertWorktree() {
  if (!existsSync(join(superfunctionsRoot, ".git"))) {
    throw new Error(
      `Super Functions worktree not found at ${superfunctionsRoot}. Set OMR_SUPERFUNCTIONS_WORKTREE to override it.`,
    );
  }

  const repository = capture("git", ["config", "--get", "remote.origin.url"]);
  if (!repository.endsWith("/21nCo/super-functions.git")) {
    throw new Error(`Unexpected Super Functions origin: ${repository}`);
  }

  for (const dependency of lock.packages) {
    const manifestPath = join(superfunctionsRoot, dependency.path, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing linked package manifest: ${manifestPath}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== dependency.name) {
      throw new Error(
        `Package mismatch at ${dependency.path}: expected ${dependency.name}, found ${manifest.name ?? "<unnamed>"}`,
      );
    }
  }
}

function packageDestination(packageName) {
  return join(repositoryRoot, "node_modules", ...packageName.split("/"));
}

function linkPackages() {
  assertWorktree();
  mkdirSync(join(repositoryRoot, "node_modules"), { recursive: true });

  for (const dependency of lock.packages) {
    const source = join(superfunctionsRoot, dependency.path);
    const destination = packageDestination(dependency.name);
    mkdirSync(dirname(destination), { recursive: true });

    if (existsSync(destination) || lstatExists(destination)) {
      const stats = lstatSync(destination);
      if (!stats.isSymbolicLink()) {
        throw new Error(`Refusing to replace non-symlink dependency at ${destination}`);
      }
      const currentTarget = resolve(dirname(destination), readlinkSync(destination));
      if (currentTarget === source) continue;
      rmSync(destination);
    }

    symlinkSync(relative(dirname(destination), source), destination, "dir");
  }

  const state = collectStatus();
  writeFileSync(
    join(repositoryRoot, ".superfunctions.local.json"),
    `${JSON.stringify({ ...state, linkedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  printStatus(state);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function collectStatus() {
  assertWorktree();
  const head = capture("git", ["rev-parse", "HEAD"]);
  const branch = capture("git", ["branch", "--show-current"]);
  const changes = run("git", ["status", "--short"], {
    cwd: superfunctionsRoot,
    capture: true,
  }).trimEnd();
  const baseIsAncestor = (() => {
    try {
      run("git", ["merge-base", "--is-ancestor", lock.baseSha, "HEAD"], {
        cwd: superfunctionsRoot,
        capture: true,
      });
      return true;
    } catch {
      return false;
    }
  })();
  const packages = lock.packages.map((dependency) => {
    const destination = packageDestination(dependency.name);
    const source = join(superfunctionsRoot, dependency.path);
    let linked = false;
    if (lstatExists(destination) && lstatSync(destination).isSymbolicLink()) {
      linked = resolve(dirname(destination), readlinkSync(destination)) === source;
    }
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const entrypoint = manifest.module ?? manifest.main;
    return {
      name: dependency.name,
      path: dependency.path,
      version: manifest.version ?? null,
      linked,
      built: typeof entrypoint === "string" ? existsSync(join(source, entrypoint)) : null,
    };
  });

  return {
    worktree: superfunctionsRoot,
    branch,
    head,
    baseSha: lock.baseSha,
    baseIsAncestor,
    dirty: changes.length > 0,
    changes: changes ? changes.split("\n") : [],
    dependenciesInstalled: existsSync(join(superfunctionsRoot, "node_modules")),
    packages,
  };
}

function printStatus(status) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

function installDependencies() {
  assertWorktree();
  run("npm", ["ci"], { cwd: superfunctionsRoot });
}

function buildPackages() {
  assertWorktree();
  if (!existsSync(join(superfunctionsRoot, "node_modules"))) {
    throw new Error("Super Functions dependencies are not installed. Run npm run sf:install first.");
  }
  const filters = lock.packages.map((dependency) => `--filter=${dependency.name}...`);
  run("npm", ["run", "build", "--", ...filters], { cwd: superfunctionsRoot });
}

async function smokePackages() {
  const status = collectStatus();
  const unavailable = status.packages.filter((dependency) => !dependency.linked || !dependency.built);
  if (unavailable.length > 0) {
    throw new Error(
      `Super Functions packages are not ready: ${unavailable.map(({ name }) => name).join(", ")}`,
    );
  }

  const imported = [];
  const resolved = [];
  for (const dependency of lock.packages) {
    if (dependency.smoke === "resolve") {
      import.meta.resolve(dependency.name);
      resolved.push(dependency.name);
      continue;
    }
    const module = await import(dependency.name);
    if (Object.keys(module).length === 0) {
      throw new Error(`Linked package has no public exports: ${dependency.name}`);
    }
    imported.push(dependency.name);
  }
  process.stdout.write(`${JSON.stringify({ imported, resolved }, null, 2)}\n`);
}

switch (command) {
  case "status":
    printStatus(collectStatus());
    break;
  case "install":
    installDependencies();
    break;
  case "build":
    buildPackages();
    break;
  case "link":
    linkPackages();
    break;
  case "smoke":
    await smokePackages();
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
