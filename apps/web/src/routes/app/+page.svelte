<script lang="ts">
  import { onMount } from "svelte";
  import { oauthCallbackUri, savePendingOAuthConnection } from "$lib/oauth-connection.js";
  import { authorizationScopes, connectionActions } from "$lib/connection-ui.js";
  import { createWorkspaceCatalogLoader, providerDisplayState } from "$lib/workspace-catalog.js";
  import { V1_PROVIDERS } from "@oh-my-router/tools";

  type WorkspaceAccess = {
    workspace: { id: string; name: string; kind: "personal" | "team" };
    membership: { role: "owner" | "admin" | "member" };
  };
  type Connection = {
    id: string;
    provider: string;
    label: string;
    ownership: "personal" | "workspace";
    ownerUserId: string | null;
    status: string;
    readiness: string;
    selected: boolean;
    healthReason: string | null;
    lastCheckedAt: number | null;
  };
  type Approval = {
    id: string;
    toolId: string;
    status: string;
    params: unknown;
    createdAt: number;
    expiresAt: number;
  };
  type Execution = {
    id: string;
    toolId: string;
    status: string;
    result: unknown;
    errorCode: string | null;
    createdAt: number;
    completedAt: number | null;
  };
  type Overview = {
    actor: { id: string; email: string | null };
    workspaces: WorkspaceAccess[];
    selectedWorkspaceId: string | null;
    connections: Connection[];
    approvals: Approval[];
    executions: Execution[];
  };
  type Provider = {
    provider: string;
    displayName: string;
    state: "unsupported" | "unconfigured" | "disconnected" | "expired" | "ready";
    available: boolean;
    authMode: string;
    actionCount: number;
  };
  type Catalog = {
    catalogSchemaVersion: string;
    revision: string;
    providers: Provider[];
    tools: { id: string; hash: string }[];
  };

  let overview: Overview | null = null;
  let catalog: Catalog | null = null;
  let selectedWorkspaceId = "";
  let loading = true;
  let busy = "";
  let error = "";
  let notice = "";
  let teamName = "";
  let oauthProvider = "github";
  let oauthLabel = "";
  let oauthOwnership: "personal" | "workspace" = "personal";
  let credentialProvider = "";
  let credentialLabel = "";
  let credentialOwnership: "personal" | "workspace" = "personal";
  let apiKey = "";
  let authorizationDestination = "";
  let authorizationOwnership: "personal" | "workspace" = "personal";
  let requestedScopes: string[] = [];

  function selectedAccess(): WorkspaceAccess | undefined {
    return overview?.workspaces.find(({ workspace }) => workspace.id === selectedWorkspaceId);
  }

  function canInstallShared(): boolean {
    const role = selectedAccess()?.membership.role;
    return role === "owner" || role === "admin";
  }

  function actions(connection: Connection) {
    return connectionActions(connection, overview?.actor.id ?? "", selectedAccess()?.membership.role ?? "member", providerState(connection.provider));
  }


  function timestamp(value: number | null): string {
    return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value) : "—";
  }

  function preview(value: unknown): string {
    const serialized = JSON.stringify(value, null, 2) ?? "—";
    return serialized.length > 520 ? `${serialized.slice(0, 520)}\n…` : serialized;
  }

  function providerState(provider: string): Provider["state"] | "unknown" {
    return providerDisplayState(catalog, provider);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (response.status === 401) {
      location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error("Authentication required");
    }
    if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
    return body as T;
  }

  const loadWorkspace = createWorkspaceCatalogLoader<Overview, Catalog>(
    (workspaceId) => request<Overview>(`/api/control-plane${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
    (workspaceId) => request<Catalog>(`/api/tools?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`),
    (state) => {
      overview = state.overview;
      catalog = state.catalog;
      selectedWorkspaceId = state.selectedWorkspaceId;
      loading = state.loading;
      error = state.error;
      if (!catalog) {
        oauthProvider = "";
        credentialProvider = "";
      } else if (!catalog.providers.some((item) => item.provider === oauthProvider && item.available && item.authMode === "oauth")) {
        oauthProvider = catalog.providers.find((item) => item.available && item.authMode === "oauth")?.provider ?? "";
      }
      if (catalog && !catalog.providers.some((item) => item.provider === credentialProvider && item.available && item.authMode === "api_key")) {
        credentialProvider = catalog.providers.find((item) => item.available && item.authMode === "api_key")?.provider ?? "";
      }
      if (!canInstallShared()) {
        oauthOwnership = "personal";
        credentialOwnership = "personal";
      }
    },
  );

  async function load(workspaceId = selectedWorkspaceId) {
    await loadWorkspace(workspaceId);
  }

  function cancelAuthorization() {
    if (authorizationDestination) {
      const state = new URL(authorizationDestination).searchParams.get("state");
      if (state) sessionStorage.removeItem(`omr.provider-oauth.${state}`);
    }
    authorizationDestination = "";
    authorizationOwnership = "personal";
    requestedScopes = [];
  }

  async function switchWorkspace() {
    cancelAuthorization();
    apiKey = "";
    await load();
  }

  async function mutate(name: string, path: string, body: unknown, success: string) {
    busy = name;
    error = "";
    notice = "";
    try {
      await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      notice = success;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The operation failed";
    } finally {
      busy = "";
    }
  }

  async function createTeam() {
    const name = teamName;
    await mutate("team", "/api/workspaces/team", { name }, `Created ${name}.`);
    teamName = "";
  }

  async function connectOAuth(connection?: Connection) {
    busy = "oauth";
    error = "";
    notice = "";
    try {
      const provider = connection?.provider ?? oauthProvider;
      const ownership = connection?.ownership ?? oauthOwnership;
      const readiness = await request<{ available: boolean; authMode: string }>(
        `/api/connections/providers/readiness?provider=${encodeURIComponent(provider)}&workspaceId=${encodeURIComponent(selectedWorkspaceId)}`,
      );
      if (!readiness.available || readiness.authMode !== "oauth") {
        throw new Error(`${provider} OAuth is not configured on this OMR environment.`);
      }
      const redirectUri = oauthCallbackUri(location.origin);
      const label = connection?.label ?? (oauthLabel.trim() || catalog?.providers.find((item) => item.provider === provider)?.displayName || provider);
      const { authUrl } = await request<{ authUrl: string }>("/api/connections/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId,
          provider,
          ownership,
          label,
          redirectUri,
        }),
      });
      cancelAuthorization();
      authorizationDestination = savePendingOAuthConnection(sessionStorage, authUrl, {
        provider,
        workspaceId: selectedWorkspaceId,
        ownership,
        label,
        redirectUri,
        createdAt: Date.now(),
      });
      authorizationOwnership = ownership;
      requestedScopes = authorizationScopes(authorizationDestination);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not start provider authorization";
      busy = "";
    }
  }

  async function connectCredential() {
    const key = apiKey;
    apiKey = "";
    await mutate("credential", "/api/connections/api-key", {
      workspaceId: selectedWorkspaceId, provider: credentialProvider,
      ownership: credentialOwnership, label: credentialLabel.trim() || credentialProvider,
      apiKey: key,
    }, `Connected ${credentialProvider}.`);
  }

  async function disconnect(connection: Connection) {
    busy = `disconnect:${connection.id}`;
    error = "";
    notice = "";
    try {
      const result = await request<{ provider: { disconnected: boolean; remoteRevokeSucceeded: boolean; remoteRevokeAttempted: boolean } }>(
        "/api/connections/disconnect", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: connection.id }),
        },
      );
      notice = !result.provider.disconnected || (result.provider.remoteRevokeAttempted && !result.provider.remoteRevokeSucceeded)
        ? "OMR access was removed. Provider revocation failed; retry provider cleanup or revoke the grant at the provider."
        : `Disconnected ${connection.label}.`;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not disconnect the account";
    } finally {
      busy = "";
    }
  }

  function csrfToken(): string {
    const cookie = document.cookie.split("; ").find((value) => value.startsWith("omr.csrf="));
    return decodeURIComponent(cookie?.slice("omr.csrf=".length) ?? "");
  }

  async function signOut() {
    busy = "sign-out";
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-authfn-csrf": csrfToken() },
        body: "{}",
      });
    } finally {
      location.assign("/login");
    }
  }

  onMount(() => {
    const connected = new URLSearchParams(location.search).get("connected");
    if (connected && (V1_PROVIDERS as readonly string[]).includes(connected)) {
      notice = `Connected ${connected}.`;
    }
    void load("");
  });
</script>

<svelte:head>
  <title>Control plane · OMR</title>
  <meta name="description" content="Manage OMR workspaces, connections, approvals, and executions." />
</svelte:head>

<div class="shell">
  <header>
    <a class="brand" href="/" aria-label="Oh My Router home"><span>OMR</span><strong>Control plane</strong></a>
    <div class="account">
      <span>{overview?.actor.email ?? "Signed in"}</span>
      <a class="quiet" href="/app/clients">Client access</a>
      <a class="quiet" href="/oauth/manage">MCP access</a>
      <button class="quiet" onclick={() => void signOut()} disabled={busy === "sign-out"}>Sign out</button>
    </div>
  </header>

  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">Trusted execution</p>
        <h1>Route with control.</h1>
        <p>Connections stay centralized. Every sensitive action waits for a human decision.</p>
      </div>
      <div class="workspace-picker">
        <label for="workspace">Workspace</label>
        <select id="workspace" bind:value={selectedWorkspaceId} onchange={() => void switchWorkspace()} disabled={loading}>
          {#each overview?.workspaces ?? [] as access}
            <option value={access.workspace.id}>{access.workspace.name} · {access.membership.role}</option>
          {/each}
        </select>
      </div>
    </section>

    {#if error}<p class="banner error" role="alert">{error}</p>{/if}
    {#if notice}<p class="banner notice" role="status">{notice}</p>{/if}

    {#if loading && !overview}
      <div class="loading">Loading control plane…</div>
    {:else if overview}
      <section class="metrics" aria-label="Workspace summary">
        <article><strong>{overview.connections.length}</strong><span>connections</span></article>
        <article><strong>{overview.approvals.filter((item) => item.status === "pending").length}</strong><span>pending approvals</span></article>
        <article><strong>{overview.executions.length}</strong><span>recent executions</span></article>
      </section>

      <div class="grid">
        <section class="panel connections">
          <div class="panel-heading">
            <div><p class="kicker">Providers</p><h2>Connections</h2></div>
            <span>{overview.connections.filter((item) => item.status !== "revoked").length} connected accounts</span>
          </div>

          <p>Personal accounts are visible only to you. Team accounts are available to workspace members; only owners and admins can connect, refresh, or disconnect them.</p>

          <div class="rows" role="region" aria-label="v1 provider catalog">
            {#each catalog?.providers ?? [] as entry}
              <article class="row">
                <div class="provider-mark">{entry.provider.slice(0, 2).toUpperCase()}</div>
                <div class="grow"><strong>{entry.displayName}</strong><span>{entry.actionCount} registered actions · {entry.authMode === "oauth" ? "OAuth" : entry.authMode === "api_key" ? "API key" : entry.authMode}</span>
                  {#if entry.state === "unconfigured"}<span>Setup required: configure this provider’s client ID, client secret, and callback URL on the server.</span>{/if}
                  {#if entry.state === "expired"}<span>One or more accounts need a health check, refresh, or reconnect.</span>{/if}
                </div>
                <span class:ready={entry.state === "ready"} class="status">{entry.state}</span>
              </article>
            {/each}
          </div>
          {#if catalog}<p class="catalog-version">Catalog {catalog.catalogSchemaVersion} · {catalog.revision} · {catalog.tools.length} visible tools on this page</p>{/if}

          {#if overview.connections.length}
            <div class="rows">
              {#each overview.connections as connection}
                <article class="row">
                  <div class="provider-mark">{connection.provider.slice(0, 2).toUpperCase()}</div>
                  <div class="grow">
                    <strong>{connection.label}</strong>
                    <span>{connection.provider} · {connection.ownership === "personal" ? "Personal · only you" : "Team · shared with members"}
                      {#if connection.selected} · Selected for your actions{/if}
                    </span>
                    <span>Last checked {timestamp(connection.lastCheckedAt)}{connection.healthReason ? ` · ${connection.healthReason.replaceAll("_", " ")}` : ""}</span>
                  </div>
                  <span class:ready={actions(connection).canSelect} class="status">{connection.status === "revoked" ? "disconnected" : providerState(connection.provider) === "ready" ? connection.readiness : providerState(connection.provider)}</span>
                  {#if actions(connection).canSelect}
                    <button
                      class="quiet compact"
                      disabled={Boolean(busy) || connection.selected}
                      onclick={() => void mutate(`select:${connection.id}`, "/api/connections/select", {
                        workspaceId: selectedWorkspaceId, provider: connection.provider, connectionId: connection.id,
                      }, `Selected ${connection.label} for ${connection.provider}.`)}
                    >{connection.selected ? "Selected" : "Select account"}</button>
                  {/if}
                  {#if actions(connection).canCheck}<button
                    class="quiet compact"
                    disabled={Boolean(busy)}
                    onclick={() => void mutate(`health:${connection.id}`, "/api/connections/health", { connectionId: connection.id }, `Checked ${connection.label}.`)}
                  >Check health</button>{/if}
                  {#if actions(connection).canRefresh}<button class="quiet compact" disabled={Boolean(busy)}
                    onclick={() => void mutate(`refresh:${connection.id}`, "/api/connections/refresh", { connectionId: connection.id }, `Refreshed ${connection.label}.`)}>Refresh</button>{/if}
                  {#if actions(connection).canReconnect}<button class="quiet compact" disabled={Boolean(busy)}
                    onclick={() => connection.provider && catalog?.providers.find((entry) => entry.provider === connection.provider)?.authMode === "oauth"
                      ? void connectOAuth(connection)
                      : (credentialProvider = connection.provider, credentialOwnership = connection.ownership, credentialLabel = connection.label, notice = "Enter a new API key below to reconnect.")}>Reconnect</button>{/if}
                  {#if actions(connection).canDisconnect || (actions(connection).canRetryRevoke && (connection.healthReason === "remote_revoke_failed" || connection.healthReason === "provider_cleanup_failed" || connection.healthReason === "provider_cleanup_pending"))}<button
                    class="danger compact"
                    disabled={Boolean(busy)}
                    onclick={() => void disconnect(connection)}
                  >{connection.status === "revoked" ? "Retry provider revocation" : "Disconnect"}</button>{/if}
                </article>
              {/each}
            </div>
          {:else}
            <p class="empty">No provider accounts are connected to this workspace yet.</p>
          {/if}

          <form class="inset" onsubmit={(event) => { event.preventDefault(); void connectOAuth(); }}>
            <div class="form-heading"><strong>Connect with OAuth</strong><span>You'll review access at the provider.</span></div>
            <div class="form-grid">
              <label>Provider
                <select bind:value={oauthProvider}>
                  {#each catalog?.providers.filter((item) => item.available && item.authMode === "oauth") ?? [] as entry}
                    <option value={entry.provider}>{entry.displayName}</option>
                  {/each}
                </select>
              </label>
              <label>Ownership
                <select bind:value={oauthOwnership}><option value="personal">Personal · only me</option>{#if canInstallShared()}<option value="workspace">Team · all members</option>{/if}</select>
              </label>
              <label>Label<input bind:value={oauthLabel} placeholder="Engineering GitHub" maxlength="120" /></label>
            </div>
            <p>OMR shows the exact scopes from the provider authorization URL before you leave. Review the provider consent screen before granting access. GitHub starts with <code>read:user</code>; repository tools require a separate broader grant.</p>
            <button class="primary" type="submit" disabled={Boolean(busy) || !selectedWorkspaceId || !oauthProvider}>
              {busy === "oauth" ? "Opening provider…" : "Continue to provider"}
            </button>
          </form>
          {#if authorizationDestination}
            <div class="inset" role="region" aria-label="Review provider access">
              <strong>Review requested access</strong>
              <p>{new URL(authorizationDestination).hostname} will receive a {authorizationOwnership === "personal" ? "personal" : "team"} connection.</p>
              {#if requestedScopes.length}<p>Requested scopes: {requestedScopes.join(", ")}</p>
              {:else}<p>No named scopes appear in this authorization URL. Confirm the permissions on the provider consent screen.</p>{/if}
              <button class="primary compact" onclick={() => location.assign(authorizationDestination)}>Continue to provider</button>
              <button class="quiet compact" onclick={cancelAuthorization}>Cancel</button>
            </div>
          {/if}
          {#if catalog?.providers.some((item) => item.available && item.authMode === "api_key")}
            <form class="inset" onsubmit={(event) => { event.preventDefault(); void connectCredential(); }}>
              <div class="form-heading"><strong>Connect with API key</strong><span>Sent directly to the server; the key is cleared from this form after submission.</span></div>
              <div class="form-grid">
                <label>Provider<select bind:value={credentialProvider}>{#each catalog.providers.filter((item) => item.available && item.authMode === "api_key") as entry}<option value={entry.provider}>{entry.displayName}</option>{/each}</select></label>
                <label>Ownership<select bind:value={credentialOwnership}><option value="personal">Personal · only me</option>{#if canInstallShared()}<option value="workspace">Team · all members</option>{/if}</select></label>
                <label>Label<input bind:value={credentialLabel} maxlength="120" /></label>
                <label>API key<input type="password" bind:value={apiKey} autocomplete="off" required /></label>
              </div>
              <button class="primary" type="submit" disabled={Boolean(busy) || !credentialProvider || !apiKey}>Connect key</button>
            </form>
          {/if}
        </section>

        <section class="panel approvals">
          <div class="panel-heading"><div><p class="kicker">Human in the loop</p><h2>Approvals</h2></div></div>
          {#each overview.approvals.filter((item) => item.status === "pending") as approval}
            <article class="approval-card">
              <div class="approval-top"><strong>{approval.toolId}</strong><span>Expires {timestamp(approval.expiresAt)}</span></div>
              <pre>{preview(approval.params)}</pre>
              <div class="actions">
                <button class="primary compact" disabled={Boolean(busy)} onclick={() => void mutate(`approve:${approval.id}`, "/api/approvals/approve", { approvalId: approval.id }, `Approved ${approval.toolId}.`)}>Approve</button>
                <button class="danger compact" disabled={Boolean(busy)} onclick={() => void mutate(`reject:${approval.id}`, "/api/approvals/reject", { approvalId: approval.id }, `Rejected ${approval.toolId}.`)}>Reject</button>
              </div>
            </article>
          {:else}
            <p class="empty">No actions are waiting for your approval.</p>
          {/each}
        </section>

        <section class="panel executions">
          <div class="panel-heading"><div><p class="kicker">Audit trail</p><h2>Recent executions</h2></div></div>
          {#if overview.executions.length}
            <div class="timeline">
              {#each overview.executions as execution}
                <article>
                  <span class:ready={execution.status === "succeeded"} class:error-dot={execution.status === "failed"} class="dot"></span>
                  <div><strong>{execution.toolId}</strong><span>{timestamp(execution.createdAt)} · {execution.status}</span></div>
                  {#if execution.errorCode}<code>{execution.errorCode}</code>{/if}
                </article>
              {/each}
            </div>
          {:else}<p class="empty">No tools have run in this workspace yet.</p>{/if}
        </section>

        <section class="panel workspace-panel">
          <div class="panel-heading"><div><p class="kicker">Collaboration</p><h2>New team workspace</h2></div></div>
          <form class="inline-form" onsubmit={(event) => { event.preventDefault(); void createTeam(); }}>
            <label for="team-name">Workspace name</label>
            <input id="team-name" bind:value={teamName} maxlength="120" required placeholder="Agent Builders" />
            <button class="secondary" type="submit" disabled={Boolean(busy)}>{busy === "team" ? "Creating…" : "Create team"}</button>
          </form>
        </section>
      </div>
    {/if}
  </main>
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; color: #eeeee7; background: #0e0f0d; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  :global(button), :global(input), :global(select) { font: inherit; }
  .shell { min-height: 100vh; background: radial-gradient(circle at 70% -10%, rgba(183, 215, 106, 0.1), transparent 28rem); }
  header { display: flex; align-items: center; justify-content: space-between; min-height: 4.8rem; padding: 0 clamp(1rem, 4vw, 3.5rem); border-bottom: 1px solid #292c27; }
  .brand { display: flex; align-items: center; gap: 0.8rem; color: inherit; text-decoration: none; }
  .brand span { padding: 0.5rem 0.6rem; border-radius: 0.55rem; color: #10110f; background: #b7d76a; font-size: 0.78rem; font-weight: 900; letter-spacing: 0.06em; }
  .account { display: flex; align-items: center; gap: 1rem; color: #8f9589; font-size: 0.86rem; }
  main { width: min(100% - 2rem, 92rem); margin: 0 auto; padding: clamp(2rem, 5vw, 4rem) 0 5rem; }
  .hero { display: flex; align-items: end; justify-content: space-between; gap: 2rem; margin-bottom: 2.5rem; }
  .eyebrow, .kicker { margin: 0 0 0.45rem; color: #b7d76a; font-size: 0.72rem; font-weight: 850; letter-spacing: 0.15em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(3rem, 6vw, 6.2rem); letter-spacing: -0.065em; line-height: 0.9; }
  .hero p:last-child { max-width: 42rem; color: #9fa598; line-height: 1.55; }
  .workspace-picker { display: grid; min-width: min(100%, 20rem); gap: 0.5rem; }
  label { display: grid; gap: 0.45rem; color: #c7cabf; font-size: 0.8rem; font-weight: 750; }
  input, select { min-width: 0; border: 1px solid #393d35; border-radius: 0.65rem; padding: 0.75rem 0.8rem; color: #f2f2eb; background: #191b17; }
  button { border-radius: 0.65rem; padding: 0.72rem 0.9rem; cursor: pointer; }
  button:disabled { cursor: wait; opacity: 0.55; }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid #d9efa4; outline-offset: 2px; }
  .quiet { border: 1px solid #393d35; color: #d5d8ce; background: transparent; }
  a.quiet { border-radius: 0.65rem; padding: 0.72rem 0.9rem; text-decoration: none; }
  .primary { border: 1px solid #b7d76a; color: #10110f; background: #b7d76a; font-weight: 850; }
  .secondary { border: 1px solid #626858; color: #f2f2eb; background: #2b2e28; font-weight: 750; }
  .danger { border: 1px solid #713d38; color: #ffb1a7; background: #2c1b18; }
  .compact { padding: 0.48rem 0.65rem; font-size: 0.76rem; }
  .banner { padding: 0.85rem 1rem; border-radius: 0.7rem; }
  .banner.error { color: #ffb1a7; background: #321c18; }
  .banner.notice { color: #d9efa4; background: #1d2a17; }
  .loading { display: grid; min-height: 20rem; place-items: center; color: #9fa598; }
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-bottom: 1rem; overflow: hidden; border: 1px solid #292c27; border-radius: 0.85rem; background: #292c27; }
  .metrics article { display: flex; align-items: baseline; gap: 0.7rem; padding: 1.1rem 1.2rem; background: #141512; }
  .metrics strong { font-size: 1.7rem; }
  .metrics span { color: #858b7f; font-size: 0.78rem; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(20rem, 0.75fr); gap: 1rem; }
  .panel { min-width: 0; padding: 1.25rem; border: 1px solid #292c27; border-radius: 0.85rem; background: rgba(20, 21, 18, 0.92); }
  .connections { grid-row: span 2; }
  .panel-heading { display: flex; align-items: start; justify-content: space-between; gap: 1rem; margin-bottom: 1.2rem; }
  .panel-heading h2 { margin: 0; font-size: 1.35rem; letter-spacing: -0.025em; }
  .panel-heading > span { color: #73796e; font-size: 0.76rem; }
  .rows { display: grid; gap: 0.55rem; }
  .row { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border: 1px solid #30332d; border-radius: 0.7rem; background: #181a16; }
  .provider-mark { display: grid; flex: 0 0 2.2rem; height: 2.2rem; place-items: center; border-radius: 0.55rem; color: #b7d76a; background: #25291f; font-size: 0.7rem; font-weight: 900; }
  .grow { display: grid; flex: 1; min-width: 0; gap: 0.2rem; }
  .grow span, .approval-top span, .timeline span { color: #858b7f; font-size: 0.73rem; }
  .status { padding: 0.25rem 0.45rem; border-radius: 999px; color: #c8a59e; background: #2d201c; font-size: 0.68rem; }
  .status.ready { color: #cfe99a; background: #202918; }
  .catalog-version { color: #858b7f; font-size: 0.73rem; overflow-wrap: anywhere; }
  .inset { display: grid; gap: 1rem; margin-top: 1rem; padding: 1rem; border-radius: 0.75rem; background: #0f100e; }
  .form-heading { display: flex; justify-content: space-between; gap: 1rem; }
  .form-heading span { color: #73796e; font-size: 0.72rem; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; }
  .approval-card { padding: 0.9rem; border: 1px solid #3a402f; border-radius: 0.75rem; background: #191c15; }
  .approval-card + .approval-card { margin-top: 0.7rem; }
  .approval-top { display: grid; gap: 0.25rem; }
  pre { max-height: 12rem; overflow: auto; padding: 0.7rem; border-radius: 0.55rem; color: #cdd1c5; background: #0e0f0d; font: 0.72rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
  .actions { display: flex; gap: 0.55rem; }
  .timeline { display: grid; gap: 0.85rem; }
  .timeline article { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.75rem; }
  .timeline article > div { display: grid; gap: 0.2rem; }
  .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #aa8b58; }
  .dot.ready { background: #b7d76a; }
  .dot.error-dot { background: #ea7567; }
  code { color: #ff9c8f; font-size: 0.7rem; }
  .inline-form { display: grid; grid-template-columns: 1fr auto; gap: 0.65rem; }
  .inline-form label { grid-column: 1 / -1; }
  .empty { margin: 1rem 0; color: #858b7f; line-height: 1.5; }
  @media (max-width: 850px) {
    .hero { align-items: stretch; flex-direction: column; }
    .grid { grid-template-columns: 1fr; }
    .connections { grid-row: auto; }
    .metrics { grid-template-columns: 1fr; }
  }
  @media (max-width: 620px) {
    .account > span { display: none; }
    .form-grid { grid-template-columns: 1fr; }
    .row { align-items: flex-start; flex-wrap: wrap; }
    .grow { min-width: 10rem; }
    .inline-form { grid-template-columns: 1fr; }
    .inline-form label { grid-column: auto; }
  }
</style>
