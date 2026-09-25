<script lang="ts">
  import { onMount } from "svelte";

  type ManualGrant = {
    id: string;
    clientId: string;
    workspaceId: string;
    clientName: string;
    kind: "cli" | "mcp_remote" | "mcp_stdio" | "headless";
    capabilities: string[];
    expiresAt: number;
    createdAt: number;
  };
  type GrantPage = { grants: ManualGrant[]; nextCursor: string | null };

  let grants: ManualGrant[] = [];
  let nextCursor: string | null = null;
  let loading = true;
  let busy = "";
  let confirmingClientId = "";
  let error = "";
  let notice = "";

  function timestamp(value: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (response.status === 401) {
      location.assign(`/login?returnTo=${encodeURIComponent(location.pathname)}`);
      throw new Error("Authentication required");
    }
    if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
    return body as T;
  }

  async function load(cursor?: string): Promise<void> {
    loading = true;
    error = "";
    try {
      const page = await request<GrantPage>(`/api/client-grants${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      grants = cursor ? [...grants, ...page.grants] : page.grants;
      nextCursor = page.nextCursor;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not load client access";
    } finally {
      loading = false;
    }
  }

  async function revoke(client: ManualGrant): Promise<void> {
    busy = client.clientId;
    error = "";
    notice = "";
    try {
      await request("/api/client-grants/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: client.clientId }),
      });
      confirmingClientId = "";
      notice = `Revoked ${client.clientName}. Its OMR credentials no longer work.`;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not revoke client access";
    } finally {
      busy = "";
    }
  }

  onMount(() => { void load(); });
</script>

<svelte:head>
  <title>Client access · OMR</title>
  <meta name="description" content="Review and revoke manually authorized OMR clients." />
</svelte:head>

<main>
  <nav><a href="/app">← Control plane</a><a href="/oauth/manage">OAuth MCP access</a></nav>
  <p class="eyebrow">Security</p>
  <h1>Client access</h1>
  <p>These are your active device and manual client grants, across workspaces. OAuth MCP grants are managed separately. Revoking a client immediately stops all of its OMR credentials.</p>

  {#if error}<p class="banner error" role="alert">{error}</p>{/if}
  {#if notice}<p class="banner notice" role="status">{notice}</p>{/if}

  {#if loading && grants.length === 0}
    <p>Loading client access…</p>
  {:else if grants.length === 0}
    <p>No active manual client grants.</p>
  {:else}
    <div class="list">
      {#each grants as grant (grant.id)}
        <article>
          <div>
            <h2>{grant.clientName}</h2>
            <p>{grant.kind} · Workspace {grant.workspaceId}</p>
            <p>Capabilities: {grant.capabilities.join(", ")}</p>
            <p>Authorized {timestamp(grant.createdAt)} · Expires {timestamp(grant.expiresAt)}</p>
          </div>
          {#if confirmingClientId === grant.clientId}
            <div class="actions">
              <span>Revoke this client's access?</span>
              <button class="danger" disabled={Boolean(busy)} onclick={() => void revoke(grant)}>
                {busy === grant.clientId ? "Revoking…" : "Confirm revoke"}
              </button>
              <button disabled={Boolean(busy)} onclick={() => confirmingClientId = ""}>Cancel</button>
            </div>
          {:else}
            <button class="danger" disabled={Boolean(busy)} onclick={() => confirmingClientId = grant.clientId}>Revoke</button>
          {/if}
        </article>
      {/each}
    </div>
    {#if nextCursor}
      <button disabled={loading || Boolean(busy)} onclick={() => void load(nextCursor ?? undefined)}>
        {loading ? "Loading…" : "Load more"}
      </button>
    {/if}
  {/if}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; color: #eeeee7; background: #0e0f0d; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  :global(button) { font: inherit; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 24px 80px; }
  nav { display: flex; gap: 24px; margin-bottom: 56px; }
  a { color: #c9e78b; }
  .eyebrow { color: #a7c56e; text-transform: uppercase; letter-spacing: .14em; font-size: .75rem; }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); margin: 8px 0 12px; }
  h2 { font-size: 1.1rem; margin: 0 0 8px; }
  p { line-height: 1.5; color: #c2c4ba; }
  .banner { padding: 12px 16px; border-radius: 10px; }
  .error { background: #552824; color: #ffddd7; }
  .notice { background: #263c23; color: #d7efbf; }
  .list { display: grid; gap: 12px; margin: 32px 0; }
  article { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 20px; border: 1px solid #33372e; border-radius: 14px; background: #171914; }
  article p { margin: 4px 0; font-size: .9rem; overflow-wrap: anywhere; }
  button { padding: 10px 14px; border: 1px solid #555d4b; border-radius: 8px; background: #23271f; color: #eeeee7; cursor: pointer; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .danger { border-color: #864640; color: #ffb9b2; }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 640px) { article { align-items: flex-start; flex-direction: column; } }
</style>
