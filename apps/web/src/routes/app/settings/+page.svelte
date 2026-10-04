<script lang="ts">
  import { onMount } from "svelte";
  import { openRouterSettingsCanMutate, openRouterSettingsDraftAfter,
    openRouterSettingsError, openRouterSettingsMessage, parseOpenRouterSettingsStatus,
    type OpenRouterSettingsAvailability,
    type OpenRouterSettingsStatus } from "$lib/openrouter-settings.js";

  let status: OpenRouterSettingsStatus | null = null;
  let key = "";
  let busy: "" | "save" | "check" | "delete" = "";
  let availability: OpenRouterSettingsAvailability = "loading";
  let error = "";

  async function send(method: "GET" | "PUT" | "POST" | "DELETE", path: string, value?: string) {
    const response = await fetch(path, {
      method, credentials: "same-origin", cache: "no-store",
      ...(value !== undefined ? { headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: value }) } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === "object" && "error" in body &&
      typeof body.error === "string" ? body.error : "";
    if (response.status === 401) {
      location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      return null;
    }
    if (!response.ok) {
      if (method === "GET") {
        availability = code === "OPENROUTER_VAULT_DISABLED" ? "disabled" : "unavailable";
      }
      throw new Error(openRouterSettingsError(code));
    }
    const parsed = parseOpenRouterSettingsStatus(body);
    if (!parsed) {
      availability = "unavailable";
      throw new Error("Could not load your saved key status. Try again later.");
    }
    return parsed;
  }

  onMount(() => {
    void (async () => {
      try {
        status = await send("GET", "/api/settings/openrouter");
        if (status) availability = "ready";
      } catch {
        if (availability === "loading") availability = "unavailable";
      }
    })();
  });

  async function act(operation: "save" | "check" | "delete") {
    if (busy || !openRouterSettingsCanMutate(availability, status)) return;
    busy = operation;
    error = "";
    const submitted = key;
    key = openRouterSettingsDraftAfter(operation, key);
    try {
      const result = await send(operation === "save" ? "PUT" : operation === "check" ? "POST" : "DELETE",
        operation === "check" ? "/api/settings/openrouter/check" : "/api/settings/openrouter",
        operation === "save" ? submitted : undefined);
      if (result) status = result;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not update settings.";
    } finally { busy = ""; }
  }
</script>

<svelte:head><title>Personal settings · OMR</title></svelte:head>

<main>
  <a href="/app">← Control plane</a>
  <h1>Personal OpenRouter key</h1>
  <p>This key belongs to your account. A future playground will use it only for your requests, in any selected workspace.</p>
  <p role="status">{openRouterSettingsMessage(status, busy, availability)}</p>
  {#if availability !== "loading"}
    {#if openRouterSettingsCanMutate(availability, status)}
      <label for="openrouter-key">{status?.configured ? "Replacement key" : "OpenRouter key"}</label>
      <input id="openrouter-key" type="password" autocomplete="off" spellcheck="false"
        bind:value={key} disabled={!!busy} />
      <div class="actions">
        <button onclick={() => void act("save")} disabled={!!busy || !key}>
          {status?.configured ? "Replace key" : "Save key"}
        </button>
        {#if status?.configured}
          <button onclick={() => void act("check")} disabled={!!busy}>Check key</button>
          <button onclick={() => void act("delete")} disabled={!!busy}>Remove key</button>
        {/if}
      </div>
      <p>The key is sent once for validation and is never shown again. Removing it prevents future playground use.</p>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/if}
</main>

<style>
  main { max-width: 42rem; margin: 3rem auto; padding: 0 1rem; font: 1rem/1.5 system-ui, sans-serif; }
  input { display: block; width: 100%; box-sizing: border-box; padding: .7rem; margin: .4rem 0 1rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .7rem; }
  button { padding: .6rem .9rem; }
  [role="alert"] { color: #a3192b; }
</style>
