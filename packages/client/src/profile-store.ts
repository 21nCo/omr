import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, readdirSync, linkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OMRProfile { backend: string; key: string; workspaceId: string }
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function profileRoot(): string {
  return process.env.OMR_CONFIG_DIR ?? join(homedir(), ".config", "oh-my-router");
}

export function assertProfileName(name: string): string {
  if (!NAME.test(name)) throw new Error("Invalid profile name (use letters, digits, _ or -)");
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
  constructor(private readonly root = profileRoot()) {
    this.profiles = join(root, "profiles");
    this.active = join(root, "active-profile");
  }

  private prepare(): void {
    safeDirectory(this.root);
    safeDirectory(this.profiles);
  }

  private file(name: string): string { return join(this.profiles, `${assertProfileName(name)}.json`); }

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
    safeFile(file);
    if (!existsSync(file)) throw new Error(`Profile ${name} is missing; run omr login`);
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<OMRProfile>;
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

  save(name: string, profile: OMRProfile): void {
    this.prepare();
    const file = this.file(name);
    if (existsSync(file)) throw new Error(`Profile ${name} already exists; log out first`);
    writePrivate(file, JSON.stringify(profile), true);
    this.use(name);
  }

  use(name: string): void {
    this.get(name);
    writePrivate(this.active, `${name}\n`);
  }

  setWorkspace(name: string, workspaceId: string): void {
    const profile = this.get(name);
    writePrivate(this.file(name), JSON.stringify({ ...profile, workspaceId }));
  }

  remove(name: string): void {
    const file = this.file(name);
    this.prepare();
    safeFile(file);
    if (!existsSync(file)) throw new Error(`Profile ${name} is missing`);
    rmSync(file);
    if (this.activeName() === name) rmSync(this.active, { force: true });
  }
}
