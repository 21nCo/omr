import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, readdirSync, linkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ini from "ini";

export interface OMRProfile { backend: string; key: string; workspaceId: string }
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

export class InvalidProfileNameError extends Error {}

export function profileRoot(): string {
  return process.env.OMR_CONFIG_DIR ?? join(homedir(), ".config", "oh-my-router");
}

export function assertProfileName(name: string): string {
  if (!NAME.test(name)) throw new InvalidProfileNameError("Invalid profile name (use letters, digits, _ or -)");
  return name;
}

function safeDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Profile directory cannot be a symlink");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error("Profile path is not a directory");
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function safeFile(path: string): void {
  if (existsSync(path) || lstatExists(path)) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Profile file must be a regular file");
    if (process.platform !== "win32" && (stats.mode & 0o077)) {
      throw new Error("Profile file permissions are too broad");
    }
  }
}

function safeProfileFile(path: string): void {
  if (lstatExists(path)) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Profile file must be a regular file");
    if (process.platform !== "win32" && (stats.mode & 0o077)) {
      // The prior CLI wrote workspace-only metadata with the default umask.
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (!value || Array.isArray(value) || typeof value !== "object" ||
          typeof value.workspaceId !== "string" || Object.keys(value).some((key) => key !== "workspaceId")) {
        throw new Error("Profile file permissions are too broad");
      }
      chmodSync(path, 0o600);
    }
  }
  safeFile(path);
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function writePrivate(path: string, contents: string, exclusive = false): void {
  safeFile(path);
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    if (exclusive) fsyncSync(fd);
    closeSync(fd);
    if (exclusive) {
      linkSync(temp, path);
      rmSync(temp);
    } else renameSync(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(temp, { force: true });
    throw error;
  }
}

export class OMRProfileStore {
  private readonly profiles: string;
  private readonly active: string;
  private readonly legacyCredentials: string;
  constructor(private readonly root = profileRoot()) {
    this.profiles = join(root, "profiles");
    this.active = join(root, "active-profile");
    this.legacyCredentials = join(root, "credentials");
  }

  private prepare(): void {
    safeDirectory(this.root);
    safeDirectory(this.profiles);
  }

  private file(name: string): string { return join(this.profiles, `${assertProfileName(name)}.json`); }

  private legacy(): Record<string, unknown> {
    safeFile(this.legacyCredentials);
    return existsSync(this.legacyCredentials)
      ? ini.parse(readFileSync(this.legacyCredentials, "utf8")) as Record<string, unknown>
      : {};
  }

  // The old credential file contains every profile. Serialize updates to it and profile
  // transitions so two CLI processes cannot restore a removed grant from stale input.
  private locked<T>(operation: () => T): T {
    this.prepare();
    const lock = `${this.legacyCredentials}.lock`;
    const deadline = Date.now() + 3_000;
    let fd: number;
    for (;;) {
      try {
        // Publish a complete owner record in one filesystem operation. A live
        // process paused here must never expose an empty lock as stale.
        writePrivate(lock, `${process.pid}\n`, true);
        fd = openSync(lock, "r");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stats;
        let contents;
        try {
          stats = lstatSync(lock);
          if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Credential lock must be a regular file");
          contents = readFileSync(lock, "utf8");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw cause;
        }
        const owner = /^([1-9]\d*)\n$/.exec(contents);
        let alive = false;
        if (owner) {
          try { process.kill(Number(owner[1]), 0); alive = true; }
          catch (cause) { alive = (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
        }
        // Only older empty locks from an interrupted previous CLI need a grace period.
        if (!alive && (owner || Date.now() - stats.mtimeMs > 250)) {
          try {
            const again = lstatSync(lock);
            if (again.dev === stats.dev && again.ino === stats.ino && again.mtimeMs === stats.mtimeMs) rmSync(lock);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Credential store is busy; retry the command");
        Atomics.wait(waitArray, 0, 0, 25);
      }
    }
    try {
      return operation();
    } finally {
      const owned = fstatSync(fd);
      closeSync(fd);
      try {
        const current = lstatSync(lock);
        if (current.dev === owned.dev && current.ino === owned.ino) rmSync(lock);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private removeLegacy(name: string): void {
    if (!existsSync(this.legacyCredentials)) return;
    const profiles = this.legacy();
    if (Object.hasOwn(profiles, name)) {
      delete profiles[name];
      writePrivate(this.legacyCredentials, ini.stringify(profiles));
    }
  }

  activeName(): string {
    this.prepare();
    safeFile(this.active);
    return existsSync(this.active) ? assertProfileName(readFileSync(this.active, "utf8").trim()) : "default";
  }

  list(): { name: string; backend: string; workspaceId: string; active: boolean }[] {
    this.prepare();
    const active = this.activeName();
    return readdirSync(this.profiles).filter((file) => file.endsWith(".json")).map((file) => {
      const name = assertProfileName(file.slice(0, -5));
      const { backend, workspaceId } = this.get(name);
      return { name, backend, workspaceId, active: name === active };
    });
  }

  get(name: string): OMRProfile {
    this.prepare();
    const file = this.file(name);
    safeProfileFile(file);
    if (!existsSync(file)) throw new Error(`Profile ${name} is missing; run omr login`);
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<OMRProfile>;
    if (typeof value.key !== "string" || typeof value.backend !== "string") {
      const legacy = this.legacy()[name];
      if (legacy && typeof legacy === "object") {
        const { backend, key } = legacy as Partial<OMRProfile>;
        value.backend = backend;
        value.key = key;
      }
    }
    if (typeof value.backend !== "string" || typeof value.key !== "string" ||
        typeof value.workspaceId !== "string" || !value.backend || !value.key || !value.workspaceId) {
      throw new Error(`Profile ${name} is invalid`);
    }
    try {
      const backend = new URL(value.backend);
      if (backend.username || backend.password || backend.search || backend.hash) throw new Error();
    } catch { throw new Error(`Profile ${name} has an invalid backend URL`); }
    return value as OMRProfile;
  }

  workspaceId(name: string): string {
    this.prepare();
    const file = this.file(name);
    safeProfileFile(file);
    if (!existsSync(file)) throw new Error(`Profile ${name} is missing; run omr login`);
    const value = JSON.parse(readFileSync(file, "utf8")) as { workspaceId?: unknown };
    if (typeof value?.workspaceId !== "string" || !value.workspaceId)
      throw new Error(`Profile ${name} is invalid`);
    return value.workspaceId;
  }

  save(name: string, profile: OMRProfile): void {
    this.locked(() => {
      const file = this.file(name);
      if (existsSync(file)) throw new Error(`Profile ${name} already exists; log out first`);
      writePrivate(file, JSON.stringify(profile), true);
      writePrivate(this.active, `${name}\n`);
    });
  }

  use(name: string): void {
    this.locked(() => {
      this.get(name);
      writePrivate(this.active, `${name}\n`);
    });
  }

  setWorkspaceIfGrantMatches(name: string, workspaceId: string,
    expected: Pick<OMRProfile, "backend" | "key">): boolean {
    return this.locked(() => {
      if (!existsSync(this.file(name))) return false;
      const profile = this.get(name);
      if (profile.backend !== expected.backend || profile.key !== expected.key) return false;
      writePrivate(this.file(name), JSON.stringify({ ...profile, workspaceId }));
      this.removeLegacy(name);
      return true;
    });
  }

  remove(name: string): void {
    this.locked(() => {
      const file = this.file(name);
      safeProfileFile(file);
      if (!existsSync(file)) throw new Error(`Profile ${name} is missing`);
      this.removeLegacy(name);
      rmSync(file);
      if (this.activeName() === name) rmSync(this.active, { force: true });
    });
  }

  // A remote revoke can take time. Only remove the grant that the caller
  // actually revoked, even if another process reused the profile name.
  removeIfGrantMatches(name: string, expected: Pick<OMRProfile, "backend" | "key">): boolean {
    return this.locked(() => {
      const file = this.file(name);
      if (!existsSync(file)) return false;
      const current = this.get(name);
      if (current.backend !== expected.backend || current.key !== expected.key) return false;
      this.removeLegacy(name);
      rmSync(file);
      if (this.activeName() === name) rmSync(this.active, { force: true });
      return true;
    });
  }
}
