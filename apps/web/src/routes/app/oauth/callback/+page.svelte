<script lang="ts">
  import { onMount } from "svelte";
  import { clearPendingOAuthConnection, readPendingOAuthConnection } from "$lib/oauth-connection.js";

  let status = "Completing the provider connection…";
  let failed = false;

  onMount(() => {
    void complete();
  });

  async function complete() {
    const query = new URLSearchParams(location.search);
    const state = query.get("state") ?? "";
    const providerError = query.get("error");
    if (providerError) {
      clearPendingOAuthConnection(sessionStorage, state);
      status = `The provider did not authorize this connection (${providerError}).`;
      failed = true;
      return;
    }

    const code = query.get("code");
    const pending = readPendingOAuthConnection(sessionStorage, state, location.origin);
    if (!code || !pending) {
      status = "This authorization could not be matched to a recent request in this browser. Start again from the control plane.";
      failed = true;
      return;
    }
    try {
      const response = await fetch("/api/connections/oauth/callback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: pending.workspaceId,
          provider: pending.provider,
          ownership: pending.ownership,
          label: pending.label,
          redirectUri: pending.redirectUri,
          code,
          state,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `Connection failed (${response.status})`);
      }
      clearPendingOAuthConnection(sessionStorage, state);
      location.replace(`/app?connected=${encodeURIComponent(pending.provider)}`);
    } catch (error) {
      status = error instanceof Error ? error.message : "The provider connection failed.";
      failed = true;
    }
  }
</script>

<svelte:head>
  <title>Connect provider · OMR</title>
  <meta name="description" content="Complete a provider connection in OMR." />
</svelte:head>

<main>
  <p class="eyebrow">Provider connection</p>
  <h1>{failed ? "Connection not completed" : "One moment"}</h1>
  <p role={failed ? "alert" : "status"}>{status}</p>
  {#if failed}<a href="/app">Return to control plane</a>{/if}
</main>

<style>
  :global(body) { margin: 0; color: #eeeee7; background: #0e0f0d; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  main { width: min(100% - 2rem, 38rem); margin: 14vh auto; }
  .eyebrow { color: #b7d76a; font-size: 0.75rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  h1 { margin: 0.5rem 0; font-size: clamp(2.5rem, 7vw, 4rem); letter-spacing: -0.05em; }
  p { line-height: 1.6; color: #aab0a2; }
  a { color: #b7d76a; }
  a:focus-visible { outline: 3px solid #d9efa4; outline-offset: 3px; }
</style>
