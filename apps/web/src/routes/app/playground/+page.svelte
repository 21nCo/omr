<script lang="ts">
  import { onMount } from "svelte";
  import type { PageData } from "./$types";
  import { createLinearActionKeys } from "$lib/linear-action-keys.js";
  import { recoverProviderReconciliation } from "$lib/workspace-catalog.js";
  import { createPlaygroundRequest, parsePlaygroundArguments, playgroundConnectionReady,
    playgroundError, PlaygroundRequestError, resumablePlaygroundApproval, schemaHints, type AssistedPlaygroundResult,
    type PlaygroundApproval, type PlaygroundCatalog,
    type PlaygroundConnection, type PlaygroundOverview, type PlaygroundReceipt } from "$lib/direct-playground.js";
  import type { ToolManifest } from "@oh-my-router/tools";

  export let data: PageData = { assistedEnabled: false };

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
  let approvalNeedsRefresh = false;
  let receipt: PlaygroundReceipt | null = null;
  let error = "";
  let notice = "";
  let loading = true;
  let busy = "";
  let generation = 0;
  let assistedPrompt = "";
  let assistedModel = "";
  let assistedResult: AssistedPlaygroundResult | null = null;
  let assistedController: AbortController | null = null;
  let selectedAccount: PlaygroundConnection | undefined;
  $: selectedAccount = overview?.connections.find((item) => item.id === connectionId &&
    item.selected && playgroundConnectionReady(item, workspaceId));

  /** Return only the server-confirmed, selectable account. */
  function currentConnection(): PlaygroundConnection | undefined {
    return selectedAccount;
  }

  /** Clear the visible action while retaining session-backed write identity. */
  function resetAction() {
    toolId = "";
    manifest = null;
    argumentsText = "{}";
    approval = null;
    approvalNeedsRefresh = false;
    receipt = null;
    error = "";
    notice = "";
    assistedController?.abort();
    assistedController = null;
    assistedResult = null;
  }

  /** Keep the model request bound to the currently selected workspace and account. */
  async function askAssistant() {
    const account = currentConnection();
    if (!account || busy || loading || approval || !assistedPrompt.trim() || !assistedModel.trim()) return;
    const turn = generation;
    const controller = new AbortController();
    assistedController = controller;
    assistedResult = null;
    receipt = null;
    error = "";
    notice = "";
    busy = "Asking model…";
    try {
      const model = assistedModel.trim();
      const prompt = assistedPrompt.trim();
      const requestId = await actionKeys.key("assisted", workspaceId, account.id, { model, prompt });
      if (turn !== generation || controller.signal.aborted) return;
      const result = await request<AssistedPlaygroundResult>("/api/playground/assisted", {
        workspaceId, connectionId: account.id, model, prompt, requestId,
      }, controller.signal);
      if (turn !== generation || controller.signal.aborted) return;
      assistedResult = result;
      if (result.receipt) receipt = result.receipt;
      if (result.approval) {
        showApproval(result.approval);
        await actionKeys.bindApproval(result.approval.id, "assisted", workspaceId, account.id,
          { model, prompt });
      }
      if (result.status === "answered" || result.status === "model_error") {
        await actionKeys.reset("assisted", workspaceId, account.id, { model, prompt });
      }
      if (result.status === "action_pending") await refreshAssistedApprovals(turn);
    } catch (caught) {
      if (turn === generation && !controller.signal.aborted) {
        error = playgroundError(caught);
        if (caught instanceof PlaygroundRequestError && caught.usage) {
          assistedResult = { status: "model_error", answer: error, errorCode: caught.code,
            model: assistedModel.trim(), servedModels: caught.model ? [caught.model] : [],
            usage: caught.usage };
          error = "";
        }
        await refreshAssistedApprovals(turn);
      }
    } finally {
      if (turn === generation && assistedController === controller) {
        busy = "";
        assistedController = null;
      }
    }
  }

  function cancelAssistant() {
    assistedController?.abort();
    assistedController = null;
    busy = "";
    notice = "Request cancelled. If a tool already started, check its receipt or approval before retrying.";
    void refreshAssistedApprovals(generation);
  }

  /** Reconcile approvals after a lost or cancelled response without clearing retry identity. */
  async function refreshAssistedApprovals(turn: number) {
    try {
      const account = currentConnection();
      const requestId = account ? await actionKeys.existingKey("assisted", workspaceId, account.id,
        { model: assistedModel.trim(), prompt: assistedPrompt.trim() }) : undefined;
      if (requestId && turn === generation) {
        const status = await request<{ approval: { id: string; status: string } | null;
          receipt: { id: string; status: string } | null }>(
          `/api/playground/assisted/status?${new URLSearchParams({ workspaceId, requestId })}`);
        if (turn !== generation) return;
        if (status.approval) {
          const recovered = await request<PlaygroundApproval>(
            `/api/approvals/status?${new URLSearchParams({ approvalId: status.approval.id, workspaceId })}`);
          if (turn === generation) showApproval(recovered);
        }
        if (status.receipt && turn === generation) {
          notice = `Read receipt ${status.receipt.id} is ${status.receipt.status}. Retry the same request to recover its saved action and usage.`;
        }
      }
      const fresh = await request<PlaygroundOverview>(
        `/api/control-plane?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (turn === generation && overview) overview = { ...overview, approvals: fresh.approvals };
    } catch { /* The retained request identity still fences a retry. */ }
  }

  /** Keep the current approval and resumable list in sync. */
  function showApproval(value: PlaygroundApproval) {
    approval = value;
    approvalNeedsRefresh = false;
    if (overview?.approvals) overview = { ...overview,
      approvals: overview.approvals.some((item) => item.id === value.id)
        ? overview.approvals.map((item) => item.id === value.id
          ? { ...value, browserActionable: item.browserActionable } : item)
        : [...overview.approvals, { ...value, browserActionable: true }] };
  }

  /** Read every catalog page for the selected workspace. */
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

  /** Reload workspace authority, selected bindings, and tool catalog. */
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

  /** Show account readiness only after selection and control-plane confirmation. */
  async function selectConnection(id: string) {
    const turn = ++generation;
    connectionId = "";
    resetAction();
    catalog = null;
    if (!id) return;
    const connection = overview?.connections.find((item) => item.id === id &&
      playgroundConnectionReady(item, workspaceId));
    if (!connection) {
      error = "That account is no longer ready. Refresh the workspace and select an available account.";
      return;
    }
    busy = "Selecting account…";
    try {
      await request("/api/connections/select", { workspaceId, provider: connection.provider,
        connectionId: connection.id });
      if (turn !== generation) return;
      const fresh = await request<PlaygroundOverview>(
        `/api/control-plane?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (turn !== generation) return;
      overview = fresh;
      if (!fresh.connections.some((item) => item.id === id && item.selected &&
        playgroundConnectionReady(item, workspaceId))) {
        throw new Error("That account is no longer ready. Select another account.");
      }
      catalog = await discover(workspaceId);
      if (turn !== generation) return;
      connectionId = id;
    } catch (caught) {
      if (turn === generation) {
        connectionId = "";
        error = `${playgroundError(caught)} Check the account in the control plane, then select it again.`;
      }
    } finally {
      if (turn === generation) busy = "";
    }
  }

  /** Resolve the current manifest before accepting arguments. */
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

  /** Execute a read or request one approval for the exact write fingerprint. */
  async function submit() {
    if (busy || loading || approval || !manifest || !currentConnection()) return;
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
        await actionKeys.bindApproval(value.id, selected.toolId, selected.workspaceId,
          selected.connectionId, params);
        if (turn === generation) {
          showApproval(value);
          notice = value.status === "pending"
            ? "Review the redacted arguments and account, then approve or reject. No provider change has run."
            : value.status === "consumed"
              ? "This action already completed. Start a new action to repeat the change."
              : value.status === "uncertain" || value.status === "executing"
                ? "Check the provider and receipt before another write. Do not repeat this action yet."
                : "Check this approval's status before another action.";
        }
        if (turn === generation && value.status === "uncertain") await refreshApproval(value.id, turn);
      }
    } catch (caught) {
      if (turn === generation) error = playgroundError(caught);
    } finally {
      if (turn === generation) busy = "";
    }
  }

  /** Refresh status after every decision so retries follow persisted state. */
  async function approvalAction(operation: "approve" | "reject" | "execute" | "status") {
    if (!approval || busy || loading || (approvalNeedsRefresh && operation !== "status")) return;
    const turn = generation;
    const approvalId = approval.id;
    busy = operation === "status" ? "Checking status…" : `${operation}…`;
    error = "";
    try {
      if (operation === "execute") {
        const value = await request<PlaygroundReceipt>("/api/approvals/execute", { approvalId });
        if (turn === generation) {
          receipt = value;
          if (assistedResult?.approval?.id === approvalId) assistedResult = { ...assistedResult,
            answer: value.status === "succeeded" ? "Approved change completed. Review the receipt."
              : "The approved action is not confirmed. Check the receipt before retrying." };
        }
      } else {
        const value = await request<PlaygroundApproval>(operation === "status"
          ? `/api/approvals/status?${new URLSearchParams({ approvalId, workspaceId })}`
          : `/api/approvals/${operation}`, operation === "status" ? undefined : { approvalId });
        if (turn === generation) {
          showApproval(value);
          if (operation === "reject" && value.status === "rejected" &&
              assistedResult?.approval?.id === approvalId) assistedResult = { ...assistedResult,
                answer: "Change rejected. No provider change ran." };
        }
      }
      if (turn === generation && operation !== "status") {
        await refreshApproval(approvalId, turn);
      }
    } catch (caught) {
      if (turn === generation) {
        error = playgroundError(caught);
        approvalNeedsRefresh = true;
        if (operation !== "status") await refreshApproval(approvalId, turn);
      }
    } finally {
      if (turn === generation) busy = "";
    }
  }

  /** Settle only the exact uncertain receipt after the actor verifies provider state. */
  async function reconcileAction(decision: "effect_present" | "effect_absent") {
    if (!approval || approval.status !== "uncertain" || busy || loading || approvalNeedsRefresh ||
        !(decision === "effect_present" ? approval.canConfirmPresent : approval.canConfirmAbsent)) return;
    const turn = generation;
    const approvalId = approval.id;
    busy = "Recording verified outcome…";
    error = "";
    try {
      const settled = await recoverProviderReconciliation(approvalId, decision,
        () => request<PlaygroundApproval>("/api/approvals/reconcile",
          { approvalId, decision, workspaceId }),
        () => request<PlaygroundApproval>(
          `/api/approvals/status?${new URLSearchParams({ approvalId, workspaceId })}`));
      if (turn === generation) {
        showApproval(settled);
        receipt = null;
        notice = decision === "effect_present"
          ? "Recorded that the action happened. No provider write was repeated."
          : "Recorded that the action did not happen. No provider write was repeated.";
      }
    } catch (caught) {
      if (turn === generation) {
        error = playgroundError(caught);
        approvalNeedsRefresh = true;
        await refreshApproval(approvalId, turn);
      }
    } finally {
      if (turn === generation) busy = "";
    }
  }

  /** Recover an open approval without trusting the selected tool or draft arguments. */
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
      if (turn === generation) {
        error = playgroundError(caught);
        if (approval?.id === id) approvalNeedsRefresh = true;
      }
    } finally {
      if (turn === generation) busy = "";
    }
  }

  /** Mark an action unconfirmed when its status request fails. */
  async function refreshApproval(approvalId: string, turn: number) {
    try {
      const value = await request<PlaygroundApproval>(
        `/api/approvals/status?${new URLSearchParams({ approvalId, workspaceId })}`);
      if (turn === generation) showApproval(value);
    } catch {
      if (turn === generation) {
        approvalNeedsRefresh = true;
        notice = "Could not confirm approval status. Check again before retrying.";
      }
    }
  }

  /** Release the prior fingerprint only after server-confirmed settlement. */
  async function newAction() {
    if (!approval || busy || loading || !["consumed", "rejected", "failed", "expired"].includes(approval.status)) return;
    const turn = generation;
    const settled = approval;
    busy = "Checking settlement…";
    error = "";
    try {
      const recovered = await actionKeys.resetApprovalAfterSettlement(settled.id,
        () => request<PlaygroundApproval>(`/api/approvals/status?${new URLSearchParams({
          approvalId: settled.id, workspaceId: settled.workspaceId,
        })}`), () => turn === generation && approval?.id === settled.id);
      if (turn === generation && approval?.id === settled.id) {
        resetAction();
        notice = recovered ? "Ready for a new action. Choose a tool and enter its arguments."
          : "Ready to choose another action. If the previous action reappears as completed, start a new action again.";
      }
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
            {connection.provider} · {connection.label} · {connection.providerState === "ready"
              ? connection.readiness : connection.providerState ?? connection.readiness}
          </option>
        {/if}
      {/each}
    </select>
    {#if selectedAccount}
      <p role="status">{selectedAccount.label} is ready · Provider catalog:
        {catalog?.providers.find((item) => item.provider === selectedAccount?.provider)?.state ?? "loading"}</p>
    {/if}
    {#if overview && !overview.connections.some((item) => playgroundConnectionReady(item, workspaceId))}
      <p>No ready account in this workspace. <a href="/app">Connect or check an account</a>.</p>
    {/if}

    <label for="playground-tool">Tool</label>
    <select id="playground-tool" value={toolId} disabled={loading || !!busy || !selectedAccount}
      onchange={(event) => void selectTool(event.currentTarget.value)}>
      <option value="">Choose a tool</option>
      {#each catalog?.tools.filter((item) => item.provider === selectedAccount?.provider) ?? [] as tool}
        <option value={tool.id}>{tool.displayName} · {tool.contract.effect}</option>
      {/each}
    </select>
    {#if selectedAccount && catalog && !catalog.tools.some((item) => item.provider === selectedAccount?.provider)}
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

  {#if data?.assistedEnabled}
    <section aria-label="Assisted tool test">
      <h2>Ask for one tool action</h2>
      <p>Uses your personal OpenRouter key. Choose a model that supports tool calls. One request can choose one tool; writes still wait for your approval.</p>
      <form onsubmit={(event) => { event.preventDefault(); void askAssistant(); }}>
        <label for="assisted-model">OpenRouter model</label>
        <input id="assisted-model" bind:value={assistedModel} maxlength="100" placeholder="provider/model" disabled={!!busy || loading || !!approval} />
        <label for="assisted-prompt">Request</label>
        <textarea id="assisted-prompt" bind:value={assistedPrompt} maxlength="2000" rows="4"
          disabled={!!busy || loading || !!approval}></textarea>
        <button type="submit" disabled={!!busy || loading || !!approval || !selectedAccount || !assistedPrompt.trim() || !assistedModel.trim()}>Ask model</button>
      </form>
      {#if assistedController}
        <button type="button" onclick={cancelAssistant}>Cancel request</button>
      {/if}
      {#if assistedResult}
        <p role="status">{assistedResult.answer}</p>
        <p>Selected model: {assistedResult.model} · Served by: {assistedResult.servedModels.join(", ")}</p>
        <p>Tokens{assistedResult.usageIncomplete ? " reported so far" : ""}: {assistedResult.usage.totalTokens ?? "unavailable"}
          (input {assistedResult.usage.promptTokens ?? "unavailable"},
          output {assistedResult.usage.completionTokens ?? "unavailable"})
          · Cost{assistedResult.usageIncomplete ? " reported so far" : ""}: {assistedResult.usage.costUsd === null ? "unavailable" : `$${assistedResult.usage.costUsd.toFixed(6)}`}</p>
        {#if assistedResult.toolId}<p>Selected tool: <code>{assistedResult.toolId}</code></p>{/if}
        {#if assistedResult.errorCode}<p role="alert">Tool error: <code>{assistedResult.errorCode}</code>
          {#if assistedResult.receiptId} · Receipt: <code>{assistedResult.receiptId}</code>{/if}</p>{/if}
      {/if}
    </section>
  {/if}

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
      <p>Approved action: <strong>{approval.action}</strong> · Tool: <code>{approval.toolId}</code>
        · Effect: <strong>{approval.effect}</strong></p>
      <p>Account: {overview?.connections.find((item) => item.id === approval?.connectionId)?.label ?? "Unavailable"}
        · Expires {new Date(approval.expiresAt).toLocaleString()}</p>
      <p>Declared resources:</p>
      {#if approval.resources.length}
        <ul aria-label="Approval resources">
          {#each approval.resources as resource}
            <li>{resource.kind}{resource.parameter ? ` · argument ${resource.parameter}` : " · target unspecified"}</li>
          {/each}
        </ul>
      {:else}
        <p>No specific resource is declared for this action.</p>
      {/if}
      {#if !approval.manifestCurrent || !approval.previewReady}
        <p role="alert">This approval cannot be safely reviewed. Request a new approval after the tool is updated.</p>
      {:else}
        {#if approval.previewMode === "opaque"}
          <p role="alert">The server cannot show this action's arguments or target. It may change or delete provider data. Verify the tool and account before approving or executing.</p>
        {/if}
        <p>Server-redacted argument preview:</p><pre>{JSON.stringify(approval.params, null, 2)}</pre>
      {/if}
      {#if approvalNeedsRefresh}
        <p role="alert">Approval status is unconfirmed. Check status before another decision. If the account is unavailable, check it in the <a href="/app">control plane</a>.</p>
      {/if}
      {#if approval.status === "pending"}
        <button type="button" disabled={!!busy || approvalNeedsRefresh || !approval.previewReady || !approval.manifestCurrent}
          onclick={() => void approvalAction("approve")}>Approve</button>
        <button type="button" disabled={!!busy || approvalNeedsRefresh} onclick={() => void approvalAction("reject")}>Reject</button>
      {:else if approval.status === "approved"}
        <button type="button" disabled={!!busy || approvalNeedsRefresh || !approval.previewReady || !approval.manifestCurrent}
          onclick={() => void approvalAction("execute")}>Execute approved change</button>
      {:else if approval.status === "executing"}
        <p>Execution is in progress. Check status and the provider before another action. Do not repeat this write.</p>
        <button type="button" disabled={!!busy || approvalNeedsRefresh}
          onclick={() => void approvalAction("execute")}>Recover execution from receipt</button>
      {:else if approval.status === "uncertain"}
        <p>The outcome is uncertain. Check the provider and receipt before recording an outcome. Do not repeat this write.</p>
        <button type="button" disabled={!!busy || approvalNeedsRefresh}
          onclick={() => void approvalAction("execute")}>Recover execution from receipt</button>
        {#if approval.canConfirmPresent}
          <button type="button" disabled={!!busy || approvalNeedsRefresh}
            onclick={() => void reconcileAction("effect_present")}>I verified the action happened</button>
        {/if}
        {#if approval.canConfirmAbsent}
          <button type="button" disabled={!!busy || approvalNeedsRefresh}
            onclick={() => void reconcileAction("effect_absent")}>I verified the action did not happen</button>
        {:else}
          <p>The request may still be running, or its receipt cannot prove absence. OMR cannot safely record no change or allow a retry for this receipt.</p>
        {/if}
      {/if}
      {#if approval.executionReceiptId}<p>Execution receipt: <code>{approval.executionReceiptId}</code></p>{/if}
      <button type="button" disabled={!!busy} onclick={() => void approvalAction("status")}>Check status</button>
      {#if ["consumed", "rejected", "failed", "expired"].includes(approval.status)}
        <button type="button" disabled={!!busy} onclick={() => void newAction()}>Start a new action</button>
      {/if}
    </section>
  {/if}

  {#if receipt}
    <section aria-label="Execution result">
      <h2>Result · {receipt.status}</h2>
      <p>Receipt: <code>{receipt.id}</code></p>
      {#if receipt.errorCode}<p>Error code: <code>{receipt.errorCode}</code></p>{/if}
      {#if receipt.status === "failed" || receipt.status === "uncertain" || receipt.errorCode}
        <p role="alert">Check this receipt and account health in the <a href="/app">control plane</a>. Verify the provider outcome before retrying a write.</p>
      {/if}
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
  select, textarea, input { width: 100%; box-sizing: border-box; padding: .7rem; color: #eeeee7; background: #10110f; border: 1px solid #575f4d; border-radius: .5rem; font: inherit; }
  textarea, pre, code { font-family: ui-monospace, monospace; }
  pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: .8rem; background: #10110f; }
  button { width: fit-content; padding: .65rem 1rem; color: #10110f; background: #b7d76a; border: 0; border-radius: .5rem; font: inherit; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  :is(a, button, select, textarea, summary):focus-visible { outline: 3px solid #d9efa4; outline-offset: 2px; }
  .error, [role="alert"] { color: #ffb1a7; }
  details { min-width: 0; }
</style>
