/// <reference path="../worker-configuration.d.ts" />

declare global {
  namespace App {
    interface Platform {
      env: Cloudflare.Env & {
        HYPERDRIVE?: { connectionString: string };
        OPENROUTER_VAULT_HYPERDRIVE?: { connectionString: string };
        DATABASE_URL?: string;
        OPENROUTER_VAULT_DATABASE_URL?: string;
        OMR_OPENROUTER_VAULT_CACHE_DISABLED_CONFIRMED?: string;
      };
      ctx: ExecutionContext;
      caches: CacheStorage;
    }
  }
}

export {};
