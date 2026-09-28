import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, readdirSync, linkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import ini from "ini";

export interface OMRProfile { backend: string; key: string; workspaceId: string }
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

export class InvalidProfileNameError extends Error {}
export class InvalidActiveProfileError extends Error {}
export class ProfileMissingError extends Error {}
export class ProfileRecoveryRequiredError extends Error {}

export function profileRoot(): string {
  return process.env.OMR_CONFIG_DIR ?? join(homedir(), ".config", "oh-my-router");
}

export function assertProfileName(name: string): string {
  if (NAME.exec(name)?.[0] !== name) {
    throw new InvalidProfileNameError("Invalid profile name (use letters, digits, _ or -)");
  }
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
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function withCleanup<T>(operation: () => T, cleanup: () => void): T {
  let value: T | undefined;
  let primary: unknown;
  let failed = false;
  try { value = operation(); }
  catch (error) { primary = error; failed = true; }
  try { cleanup(); }
  catch (cleanupError) {
    if (!failed) throw cleanupError;
    if (primary instanceof Error && primary.cause === undefined) primary.cause = cleanupError;
  }
  if (failed) throw primary;
  return value as T;
}

function writePrivate(path: string, contents: string, exclusive = false): void {
  safeFile(path);
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    // The next operation may erase the only other copy of a live grant.
    // Persist both contents and the published directory entry first.
    fsyncSync(fd);
    closeSync(fd);
    if (exclusive) {
      linkSync(temp, path);
      rmSync(temp);
    } else renameSync(temp, path);
    if (process.platform !== "win32") {
      const parent = openSync(dirname(path), "r");
      try { fsyncSync(parent); }
      finally { closeSync(parent); }
    }
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(temp, { force: true }); }
    catch (cleanupError) {
      if (error instanceof Error && error.cause === undefined) error.cause = cleanupError;
    }
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function removeStaleLock(lock: string): void {
  let stats;
  let contents;
  try {
    stats = lstatSync(lock);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Credential lock must be a regular file");
    contents = readFileSync(lock, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const owner = /^([1-9]\d*)\n$/.exec(contents);
  if ((owner && processAlive(Number(owner[1]))) ||
      (!owner && Date.now() - stats.mtimeMs <= 250)) return;
  try {
    const again = lstatSync(lock);
    if (again.dev === stats.dev && again.ino === stats.ino && again.mtimeMs === stats.mtimeMs) rmSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

  private acquireCredentialLock(): { fd: number; lock: string } {
    const lock = `${this.legacyCredentials}.lock`;
    const deadline = Date.now() + 3_000;
    for (;;) {
      try {
        // Publish a complete owner record in one filesystem operation. A live
        // process paused here must never expose an empty lock as stale.
        writePrivate(lock, `${process.pid}\n`, true);
        return { fd: openSync(lock, "r"), lock };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.reclaimCredentialLock(lock, deadline);
        if (Date.now() >= deadline) throw new Error("Credential store is busy; retry the command");
        Atomics.wait(waitArray, 0, 0, 25);
      }
    }
  }

  private reclaimCredentialLock(lock: string, deadline: number): void {
    const reclaim = `${lock}.reclaim`;
    // Serialize stale-lock removal so a second reclaimer cannot unlink a new owner.
    try { writePrivate(reclaim, `${process.pid}\n`, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Credential recovery is busy; inspect credentials.lock.reclaim before retrying");
      }
      return;
    }
    withCleanup(() => removeStaleLock(lock), () => rmSync(reclaim));
  }

  private releaseCredentialLock(fd: number, lock: string): void {
    const owned = fstatSync(fd);
    closeSync(fd);
    try {
      const current = lstatSync(lock);
      if (current.dev === owned.dev && current.ino === owned.ino) rmSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // The old credential file contains every profile. Serialize updates to it and profile
  // transitions so two CLI processes cannot restore a removed grant from stale input.
  private locked<T>(operation: () => T): T {
    this.prepare();
    const { fd, lock } = this.acquireCredentialLock();
    return withCleanup(() => {
      this.cleanupInterruptedWrites();
      return operation();
    }, () => this.releaseCredentialLock(fd, lock));
  }

  private removeLegacy(name: string): void {
    if (!existsSync(this.legacyCredentials)) return;
    const profiles = this.legacy();
    if (Object.hasOwn(profiles, name)) {
      delete profiles[name];
      writePrivate(this.legacyCredentials, ini.stringify(profiles));
    }
  }

  // A killed writer can leave a private copy of a grant beside its destination.
  // Only remove our own temp naming pattern after taking the credential lock.
  private cleanupInterruptedWrites(): void {
    for (const directory of [this.root, this.profiles]) {
      for (const entry of readdirSync(directory)) this.cleanupTemp(directory, entry);
    }
  }

  private cleanupTemp(directory: string, entry: string): void {
    const match = /^(active-profile|credentials(?:\.lock)?|[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json)\.([1-9]\d*)\.[0-9a-f-]{36}\.tmp$/.exec(entry);
    if (match === null) return;
    const [, target, ownerPid] = match;
    if (target === undefined) return;
    if ((directory === this.profiles) !== target.endsWith(".json")) return;
    const path = join(directory, entry);
    let stats;
    try { stats = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || processAlive(Number(ownerPid))) return;
    try { rmSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  activeName(): string {
    this.prepare();
    safeFile(this.active);
    if (!existsSync(this.active)) return "default";
    try { return assertProfileName(readFileSync(this.active, "utf8").trim()); }
    catch (error) {
      if (error instanceof InvalidProfileNameError)
        throw new InvalidActiveProfileError("active-profile contains an invalid profile name; run omr profiles use <name> to repair it");
      throw error;
    }
  }

  has(name: string): boolean {
    this.prepare();
    return lstatExists(this.file(name)) || Object.hasOwn(this.legacy(), assertProfileName(name));
  }

  list(onUnreadable?: (file: string) => void): { name: string; backend: string; workspaceId: string; active: boolean }[] {
    this.prepare();
    let active: string | undefined;
    try { active = this.activeName(); }
    catch (error) {
      if (!(error instanceof InvalidActiveProfileError)) throw error;
      onUnreadable?.("active-profile");
    }
    const profiles: { name: string; backend: string; workspaceId: string; active: boolean }[] = [];
    for (const file of readdirSync(this.profiles).filter((entry) => entry.endsWith(".json"))) {
      try {
        const name = assertProfileName(file.slice(0, -5));
        const { backend, workspaceId } = this.get(name);
        profiles.push({ name, backend, workspaceId, active: name === active });
      } catch {
        onUnreadable?.(file);
      }
    }
    try {
      if (Object.keys(this.legacy()).some((name) => NAME.exec(name)?.[0] === name &&
          !lstatExists(this.file(name)))) onUnreadable?.("credentials");
    } catch { onUnreadable?.("credentials"); }
    return profiles;
  }

  get(name: string): OMRProfile {
    const value = this.readProfile(name) as Partial<OMRProfile>;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Profile ${name} is invalid`);
    this.restoreLegacyGrant(name, value);
    if (typeof value.backend !== "string" || typeof value.key !== "string" ||
        typeof value.workspaceId !== "string" || !value.backend || !value.key || !value.workspaceId) {
      throw new Error(`Profile ${name} is invalid`);
    }
    let backend: URL;
    try { backend = new URL(value.backend); }
    catch { throw new Error(`Profile ${name} has an invalid backend URL`); }
    if (backend.username || backend.password || backend.search || backend.hash) {
      throw new Error(`Profile ${name} has an invalid backend URL`);
    }
    return value as OMRProfile;
  }

  workspaceId(name: string): string {
    const value = this.readProfile(name) as { workspaceId?: unknown } | null;
    if (typeof value?.workspaceId !== "string" || !value.workspaceId)
      throw new Error(`Profile ${name} is invalid`);
    return value.workspaceId;
  }

  private readProfile(name: string): unknown {
    this.prepare();
    const file = this.file(name);
    try { safeProfileFile(file); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Profile ${name} has invalid JSON in ${name}.json`);
      throw error;
    }
    if (!existsSync(file)) {
      if (Object.hasOwn(this.legacy(), name)) {
        throw new ProfileRecoveryRequiredError(`Profile ${name} has a legacy grant without workspace metadata; revoke it at /app/clients before logout --local`);
      }
      throw new ProfileMissingError(`Profile ${name} is missing; run omr login`);
    }
    try { return JSON.parse(readFileSync(file, "utf8")) as unknown; }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Profile ${name} has invalid JSON in ${name}.json`);
      throw error;
    }
  }

  private restoreLegacyGrant(name: string, value: Partial<OMRProfile>): void {
    if (typeof value.key === "string" && typeof value.backend === "string") return;
    const legacy = this.legacy()[name];
    if (!legacy || typeof legacy !== "object") return;
    const { backend, key } = legacy as Partial<OMRProfile>;
    value.backend = backend;
    value.key = key;
  }

  save(name: string, profile: OMRProfile): void {
    this.locked(() => {
      const file = this.file(name);
      if (existsSync(file) || Object.hasOwn(this.legacy(), name)) {
        throw new Error(`Profile ${name} already exists; log out first`);
      }
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
      if (!existsSync(file) && !Object.hasOwn(this.legacy(), name)) {
        throw new ProfileMissingError(`Profile ${name} is missing`);
      }
      this.removeLegacy(name);
      if (existsSync(file)) rmSync(file);
      if (this.activeMatches(name)) rmSync(this.active, { force: true });
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
      if (this.activeMatches(name)) rmSync(this.active, { force: true });
      return true;
    });
  }

  private activeMatches(name: string): boolean {
    try { return this.activeName() === name; }
    catch (error) {
      if (error instanceof InvalidActiveProfileError) return false;
      throw error;
    }
  }
}
