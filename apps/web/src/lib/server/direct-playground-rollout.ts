/** OMR-15 enables this only after staged direct-tool acceptance. */
export function directPlaygroundEnabled(env: object | undefined): boolean {
  return Boolean(env && "OMR_DIRECT_PLAYGROUND_ENABLED" in env &&
    env.OMR_DIRECT_PLAYGROUND_ENABLED === "true");
}

/** Assisted testing requires its own flag and the verified personal vault boundary. */
export function assistedPlaygroundEnabled(env: object | undefined): boolean {
  return Boolean(directPlaygroundEnabled(env) && env &&
    "OMR_ASSISTED_PLAYGROUND_ENABLED" in env &&
    env.OMR_ASSISTED_PLAYGROUND_ENABLED === "true" &&
    "OMR_OPENROUTER_VAULT_ENABLED" in env && env.OMR_OPENROUTER_VAULT_ENABLED === "true" &&
    "OMR_OPENROUTER_VAULT_CACHE_DISABLED_CONFIRMED" in env &&
    env.OMR_OPENROUTER_VAULT_CACHE_DISABLED_CONFIRMED === "true");
}
