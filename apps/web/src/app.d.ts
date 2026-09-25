/// <reference path="../worker-configuration.d.ts" />

declare global {
  namespace App {
    interface Platform {
      env: Cloudflare.Env & {
        HYPERDRIVE?: { connectionString: string };
        DATABASE_URL?: string;
      };
      ctx: ExecutionContext;
      caches: CacheStorage;
    }
  }
}

export {};
