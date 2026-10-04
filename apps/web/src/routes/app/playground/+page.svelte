<script lang="ts">
  import { onMount } from "svelte";
  import { createLinearActionKeys } from "$lib/linear-action-keys.js";
  import { createPlaygroundRequest, parsePlaygroundArguments, playgroundConnectionReady,
    playgroundError, resumablePlaygroundApproval, schemaHints, type PlaygroundApproval, type PlaygroundCatalog,
    type PlaygroundConnection, type PlaygroundOverview, type PlaygroundReceipt } from "$lib/direct-playground.js";
  import type { ToolManifest } from "@oh-my-router/tools";

  const request = createPlaygroundRequest(fetch, () =>
    location.assign(`/login?returnTo=${encodeURIComponent(location.pathname)}`));
  const actionKeys = createLinearActionKeys(() => crypto.randomUUID(), () => sessionStorage, "connected tool");
  let overview: PlaygroundOverview | null = null;
  let catalog: PlaygroundCatalog | null = null;
  let workspaceId = "";
  let connectionId = "";
  let toolId = "";
  let manifest: ToolManifest | null = null;
  let argumentsText = "{}";
  let approval: PlaygroundApproval | null = null;
  let receipt: PlaygroundReceipt | null = null;
  let error = "";
  let notice = "";
  let loading = true;
  let busy = "";
  let generation = 0;

  function currentConnection(): PlaygroundConnection | undefined {
    return overview?.connections.find((item) => item.id === connectionId &&
      playgroundConnectionReady(item, workspaceId));
  }

  function resetAction() {
    toolId = "";
    manifest = null;
    argumentsText = "{}";
    approval = null;
    receipt = null;
    error = "";
    notice = "";
  }

  function showApproval(value: PlaygroundApproval) {
    approval = value;
    if (overview?.approvals) overview = { ...overview,
      approvals: overview.approvals.map((item) => item.id === value.id
        ? { ...value, browserActionable: item.browserActionable } : item) };
  }

  async function discover(selectedWorkspaceId: string): Promise<PlaygroundCatalog> {
    const tools: ToolManifest[] = [];
    let cursor = "";
    let providers: PlaygroundCatalog["providers"] = [];
    do {
      const params = new URLSearchParams({ workspaceId: selectedWorkspaceId, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const page = await request<PlaygroundCatalog>(`/api/tools?${params}`);
      tools.push(...page.tools);
      providers = page.providers;
      cursor = page.nextCursor ?? "";
    } while (cursor);
    return { tools, providers };
  }

  async function load(selectedWorkspaceId = "") {
    const turn = ++generation;
    loading = true;
    busy = "";
    resetAction();
    connectionId = "";
    catalog = null;
    overview = null;
    workspaceId = selectedWorkspaceId;
    try {
      const params = selectedWorkspaceId ? `?workspaceId=${encodeURIComponent(selectedWorkspaceId)}` : "";
      const fresh = await request<PlaygroundOverview>(`/api/control-plane${params}`);
      if (turn !== generation) return;
      overview = fresh;
      workspaceId = fresh.selectedWorkspaceId ?? "";
      connectionId = fresh.connections.find((item) => item.selected &&
        playgroundConnectionReady(item, workspaceId))?.id ?? "";
      if (workspaceId) catalog = await discover(workspaceId);
      if (turn !== generation) return;
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) loading = false;
    }
  }

  async function selectConnection(id: string) {
    const turn = ++generation;
    connectionId = id;
    resetAction();
    catalog = null;
    const connection = currentConnection();
    if (!connection) return;
    busy = "Selecting account…";
    try {
      await request("/api/connections/select", { workspaceId, provider: connection.provider,
        connectionId: connection.id });
      if (turn !== generation) return;
      const fresh = await request<PlaygroundOverview>(
        `/api/control-plane?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (turn !== generation) return;
      overview = fresh;
      catalog = await discover(workspaceId);
      if (turn !== generation) return;
      if (!fresh.connections.some((item) => item.id === id && item.selected &&
        playgroundConnectionReady(item, workspaceId))) {
        connectionId = "";
        throw new Error("That account is no longer ready. Select another account.");
      }
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) busy = "";
    }
  }

  async function selectTool(id: string) {
    const turn = ++generation;
    resetAction();
    toolId = id;
    if (!id || !currentConnection()) return;
    busy = "Loading tool…";
    try {
      const selected = await request<ToolManifest>(`/api/tools/manifest?${new URLSearchParams({
        id, workspaceId,
      })}`);
      if (turn !== generation) return;
      if (selected.provider !== currentConnection()?.provider) throw new Error("Tool account changed. Select it again.");
      manifest = selected;
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) busy = "";
    }
  }

  async function submit() {
    if (busy || loading || !manifest || !currentConnection()) return;
    const turn = generation;
    const selected = { workspaceId, connectionId, toolId, manifest };
    error = "";
    notice = "";
    receipt = null;
    let params: Record<string, unknown>;
    try { params = parsePlaygroundArguments(argumentsText); }
    catch (caught) { error = playgroundError(caught); return; }
    busy = selected.manifest.contract.effect === "read" ? "Running read…" : "Requesting approval…";
    try {
      if (selected.manifest.contract.effect === "read") {
        const value = await request<PlaygroundReceipt>("/api/tools/execute", {
          workspaceId: selected.workspaceId, connectionId: selected.connectionId,
          toolId: selected.toolId, params, idempotencyKey: crypto.randomUUID(),
        });
        if (turn === generation) receipt = value;
      } else {
        const idempotencyKey = await actionKeys.key(selected.toolId, selected.workspaceId,
          selected.connectionId, params);
        const value = await request<PlaygroundApproval>("/api/approvals", {
          workspaceId: selected.workspaceId, connectionId: selected.connectionId,
          toolId: selected.toolId, params, idempotencyKey,
        });
        if (turn === generation) {
          showApproval(value);
          notice = "Review the redacted arguments and account, then approve or reject. No provider change has run.";
        }
      }
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) busy = "";
    }
  }

  async function approvalAction(operation: "approve" | "reject" | "execute" | "status") {
    if (!approval || busy || loading) return;
    const turn = generation;
    const approvalId = approval.id;
    busy = operation === "status" ? "Checking status…" : `${operation}…`;
    error = "";
    try {
      if (operation === "execute") {
        const value = await request<PlaygroundReceipt>("/api/approvals/execute", { approvalId });
        if (turn === generation) receipt = value;
      } else {
        const value = await request<PlaygroundApproval>(operation === "status"
          ? `/api/approvals/status?${new URLSearchParams({ approvalId, workspaceId })}`
          : `/api/approvals/${operation}`, operation === "status" ? undefined : { approvalId });
        if (turn === generation) showApproval(value);
      }
      if (turn === generation && operation !== "status") {
        await refreshApproval(approvalId, turn);
      }
    } catch (caught) {
      if (turn === generation) {
        error = playgroundError(caught);
        if (operation === "execute") await refreshApproval(approvalId, turn);
      }
    } finally {
      if (turn === generation) busy = "";
    }
  }

  async function resumeApproval(id: string) {
    if (busy || loading) return;
    const turn = generation;
    busy = "Loading approval…";
    error = "";
    try {
      const value = await request<PlaygroundApproval>(
        `/api/approvals/status?${new URLSearchParams({ approvalId: id, workspaceId })}`);
      if (turn === generation) { showApproval(value); receipt = null; }
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) busy = "";
    }
  }

  async function refreshApproval(approvalId: string, turn: number) {
    try {
      const value = await request<PlaygroundApproval>(
        `/api/approvals/status?${new URLSearchParams({ approvalId, workspaceId })}`);
      if (turn === generation) showApproval(value);
    } catch {
      if (turn === generation) notice = "Could not confirm approval status. Check again before retrying.";
    }
  }

  async function newAction() {
    if (!approval || !manifest || busy) return;
    const turn = generation;
    busy = "Checking settlement…";
    error = "";
    try {
      const params = parsePlaygroundArguments(argumentsText);
      await actionKeys.resetAfterSettlement(toolId, workspaceId, connectionId, params,
        (idempotencyKey) => request<PlaygroundApproval>("/api/approvals", {
          workspaceId, connectionId, toolId, params, idempotencyKey,
        }), () => turn === generation);
      if (turn === generation) { approval = null; receipt = null; notice = "Ready for a new action."; }
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) busy = "";
    }
  }

  onMount(() => { void load(); });
</script>

<svelte:head><title>Test a connected tool · OMR</title></svelte:head>

<main>
  <a href="/app">← Control plane</a>
  <h1>Test a connected tool</h1>
  <p>Run one tool with your connected account. Writes wait for your approval. No model key is needed.</p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if loading}<p role="status">Loading workspace and tools…</p>{/if}

  <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label for="playground-workspace">Workspace</label>
    <select id="playground-workspace" value={workspaceId} disabled={loading || !!busy}
      onchange={(event) => void load(event.currentTarget.value)}>
      {#each overview?.workspaces ?? [] as access}
        <option value={access.workspace.id}>{access.workspace.name}</option>
      {/each}
    </select>

    <label for="playground-connection">Provider account</label>
    <select id="playground-connection" value={connectionId} disabled={loading || !!busy || !workspaceId}
      onchange={(event) => void selectConnection(event.currentTarget.value)}>
      <option value="">Choose an account</option>
      {#each overview?.connections ?? [] as connection}
        {#if connection.workspaceId === workspaceId && !connection.cleanupOnly}
          <option value={connection.id} disabled={!playgroundConnectionReady(connection, workspaceId)}>
            {connection.provider} · {connection.label} · {connection.readiness}
          </option>
        {/if}
      {/each}
    </select>
    {#if currentConnection()}
      <p role="status">{currentConnection()?.label} is ready · Provider catalog:
        {catalog?.providers.find((item) => item.provider === currentConnection()?.provider)?.state ?? "loading"}</p>
    {/if}
    {#if overview && !overview.connections.some((item) => playgroundConnectionReady(item, workspaceId))}
      <p>No ready account in this workspace. <a href="/app">Connect or check an account</a>.</p>
    {/if}

    <label for="playground-tool">Tool</label>
    <select id="playground-tool" value={toolId} disabled={loading || !!busy || !currentConnection()}
      onchange={(event) => void selectTool(event.currentTarget.value)}>
      <option value="">Choose a tool</option>
      {#each catalog?.tools.filter((item) => item.provider === currentConnection()?.provider) ?? [] as tool}
        <option value={tool.id}>{tool.displayName} · {tool.contract.effect}</option>
      {/each}
    </select>
    {#if currentConnection() && catalog && !catalog.tools.some((item) => item.provider === currentConnection()?.provider)}
      <p>No tools are ready for this account. Check its scopes and health in the <a href="/app">control plane</a>.</p>
    {/if}

    {#if manifest}
      <p>{manifest.description}</p>
      <p>Effect: <strong>{manifest.contract.effect}</strong> · Tool version: {manifest.contract.version}</p>
      {#if schemaHints(manifest).length}
        <ul aria-label="Argument schema">
          {#each schemaHints(manifest) as field}
            <li><code>{field.name}</code> · {field.type}{field.required ? " · required" : " · optional"}
              {field.description ? ` — ${field.description}` : ""}</li>
          {/each}
        </ul>
      {/if}
      <details><summary>Full input schema</summary><pre>{JSON.stringify(manifest.inputSchema, null, 2)}</pre></details>
      <label for="playground-arguments">Arguments (JSON object)</label>
      <textarea id="playground-arguments" bind:value={argumentsText} rows="9" spellcheck="false"
        disabled={!!busy || !!approval}></textarea>
      <button type="submit" disabled={!!busy || loading || !!approval}>
        {manifest.contract.effect === "read" ? "Run read" : "Request approval"}
      </button>
    {/if}
  </form>
  {#if busy}<p role="status">{busy}</p>{/if}

  {#if overview?.approvals?.some((item) => resumablePlaygroundApproval(item, workspaceId))}
    <section aria-label="Open approvals">
      <h2>Open approvals</h2>
      {#each overview.approvals.filter((item) => resumablePlaygroundApproval(item, workspaceId)) as item}
        <p>{item.toolId} · {item.status} · {overview.connections.find((connection) =>
          connection.id === item.connectionId)?.label ?? "Unavailable account"}
          <button type="button" disabled={!!busy || loading} onclick={() => void resumeApproval(item.id)}>
            Review approval</button></p>
      {/each}
    </section>
  {/if}

  {#if approval}
    <section aria-label="Approval">
      <h2>Approval · {approval.status}</h2>
      <p>Account: {overview?.connections.find((item) => item.id === approval?.connectionId)?.label ?? "Unavailable"}
        · Expires {new Date(approval.expiresAt).toLocaleString()}</p>
      {#if !approval.manifestCurrent || !approval.previewReady}
        <p role="alert">This approval cannot be safely reviewed. Request a new approval after the tool is updated.</p>
      {:else}
        <p>Server-redacted argument preview:</p><pre>{JSON.stringify(approval.params, null, 2)}</pre>
      {/if}
      {#if approval.status === "pending"}
        <button type="button" disabled={!!busy || !approval.previewReady || !approval.manifestCurrent}
          onclick={() => void approvalAction("approve")}>Approve</button>
        <button type="button" disabled={!!busy} onclick={() => void approvalAction("reject")}>Reject</button>
      {:else if approval.status === "approved"}
        <button type="button" disabled={!!busy || !approval.previewReady || !approval.manifestCurrent}
          onclick={() => void approvalAction("execute")}>Execute approved change</button>
      {:else if approval.status === "executing" || approval.status === "uncertain"}
        <p>Check the provider and receipt before another action. Do not repeat this write.
          If the outcome is uncertain, use the <a href="/app">control plane</a> to record a verified outcome.</p>
      {/if}
      {#if approval.executionReceiptId}<p>Execution receipt: <code>{approval.executionReceiptId}</code></p>{/if}
      <button type="button" disabled={!!busy} onclick={() => void approvalAction("status")}>Check status</button>
      {#if manifest && ["consumed", "rejected", "failed", "expired"].includes(approval.status)}
        <button type="button" disabled={!!busy} onclick={() => void newAction()}>Start a new action</button>
      {/if}
    </section>
  {/if}

  {#if receipt}
    <section aria-label="Execution result">
      <h2>Result · {receipt.status}</h2>
      <p>Receipt: <code>{receipt.id}</code></p>
      {#if receipt.errorCode}<p role="alert">{receipt.errorCode}</p>{/if}
      {#if receipt.result !== null}<pre>{JSON.stringify(receipt.result, null, 2)}</pre>{/if}
    </section>
  {/if}
</main>

<style>
  :global(body) { margin: 0; background: #0e0f0d; color: #eeeee7; font: 1rem/1.5 system-ui, sans-serif; }
  main { max-width: 52rem; padding: 2rem 1rem 5rem; margin: auto; }
  a { color: #b7d76a; }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.1; }
  form, section { display: grid; gap: .7rem; margin-top: 1.5rem; padding: 1.25rem; border: 1px solid #353a30; border-radius: .8rem; background: #191b17; }
  label { font-weight: 700; }
  select, textarea { width: 100%; box-sizing: border-box; padding: .7rem; color: #eeeee7; background: #10110f; border: 1px solid #575f4d; border-radius: .5rem; font: inherit; }
  textarea, pre, code { font-family: ui-monospace, monospace; }
  pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: .8rem; background: #10110f; }
  button { width: fit-content; padding: .65rem 1rem; color: #10110f; background: #b7d76a; border: 0; border-radius: .5rem; font: inherit; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  :is(a, button, select, textarea, summary):focus-visible { outline: 3px solid #d9efa4; outline-offset: 2px; }
  .error, [role="alert"] { color: #ffb1a7; }
  details { min-width: 0; }
</style>
