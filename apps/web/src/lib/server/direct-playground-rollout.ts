/** OMR-15 enables this only after staged direct-tool acceptance. */
export function directPlaygroundEnabled(env: object | undefined): boolean {
  return Boolean(env && "OMR_DIRECT_PLAYGROUND_ENABLED" in env &&
    env.OMR_DIRECT_PLAYGROUND_ENABLED === "true");
}
