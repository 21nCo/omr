<script lang="ts">
  import { onMount } from "svelte";
  import { beginGithubReconnect, createOAuthReviewController } from "$lib/oauth-review.js";
  import { connectionActions, connectionStatusLabel, providerRevocationGuidance } from "$lib/connection-ui.js";
  import { createWorkspaceCatalogLoader, expiredAutomaticApprovalLookup, effectAbsentAvailable, effectPresentAvailable, providerDisplayState, recoverProviderReconciliation, recoverWorkspaceOverview, sameSlackPostParams, sameSlackReadSelection, selectedLinearAccountId, selectedReadyLinearConnection, selectedReadyNotionConnection, selectedReadySlackConnection, selectedSlackAccountId, slackChannelSelectionLocked, visibleApprovalCard } from "$lib/workspace-catalog.js";
  import { renderApprovalPreview } from "$lib/approval-preview.js";
  import { createLinearActionKeys, linearApprovalNotice } from "$lib/linear-action-keys.js";
  import { slackApprovalNotice } from "$lib/slack-approval-notice.js";
  import { V1_PROVIDERS } from "@oh-my-router/tools";
  import type { LinearAccess, SlackAccess } from "@oh-my-router/connections";

  type WorkspaceAccess = {
    workspace: { id: string; name: string; kind: "personal" | "team" };
    membership: { role: "owner" | "admin" | "member" };
  };
  type Connection = {
    id: string;
    workspaceId: string;
    provider: string;
    label: string;
    ownership: "personal" | "workspace";
    ownerUserId: string | null;
    status: string;
    readiness: string;
    selected: boolean;
    healthReason: string | null;
    lastCheckedAt: number | null;
    updatedAt: number;
    cleanupOnly?: boolean;
  };
  type Approval = {
    id: string;
    toolId: string;
    action: string;
    status: string;
    params: unknown;
    effect: string;
    resources: { kind: string; parameter?: string }[];
    manifestCurrent: boolean;
    previewReady: boolean;
    browserActionable: boolean;
    previewMode: "opaque" | "redacted" | "unavailable";
    connectionId: string;
    executionReceiptId?: string | null;
    reconciledAs?: "effect_present" | "effect_absent" | null;
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
    reconciliationReceipts: Execution[];
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
  let clockNow = Date.now();
  let error = "";
  let notice = "";
  let recoveryInput = "";
  let recoveryError = "";
  let overviewRequestGeneration = 0;
  let recoveredApprovalId = "";
  let automaticApprovalLookup: { id: string; expiresAt: number } | null = null;
  let teamName = "";
  let oauthProvider = "github";
  let oauthLabel = "";
  let oauthOwnership: "personal" | "workspace" = "personal";
  let githubAccess: "profile" | "public_write" | "private_repositories" = "profile";
  let linearAccess: LinearAccess = "read";
  let slackAccess: SlackAccess = "discover";
  type SlackChannel = { id: string; name: string };
  type SlackMessage = { ts: string; text: string; user?: string };
  let slackWorkspace: { id: string; name: string; sender: { type: "bot"; id: string; botId: string } } | null = null;
  let slackChannels: SlackChannel[] = [];
  let slackChannelsCursor: string | null = null;
  let slackChannelId = "";
  let slackMessages: SlackMessage[] = [];
  let slackMessagesCursor: string | null = null;
  let slackFilteredCount = 0;
  let slackText = "";
  let slackBusy = "";
  let slackGeneration = 0;
  let slackReadOwner: { generation: number; workspaceId: string; accountId: string } | null = null;
  const slackActionKeys = createLinearActionKeys(() => crypto.randomUUID(), () => sessionStorage, "Slack");
  type NotionItem = { type: "page" | "database"; id: string; title: string; url: string };
  type NotionPage = { id: string; title: string; url: string; parent: { type: string; page_id?: string; database_id?: string } };
  let notionItems: NotionItem[] = [];
  let notionCursor: string | null = null;
  let notionQuery = "";
  let notionPageId = "";
  let notionPage: NotionPage | null = null;
  let notionCreateTitle = "";
  let notionUpdateTitle = "";
  let notionBusy = "";
  let notionGeneration = 0;
  const notionActionKeys = createLinearActionKeys(() => crypto.randomUUID(), () => sessionStorage, "Notion");
  type LinearTeam = { id: string; name: string; key: string };
  type LinearIssue = { id: string; identifier: string; title: string; description: string | null;
    url: string; team: { id: string; name: string }; state: { id: string; name: string } | null };
  let linearWorkspace: { id: string; name: string } | null = null;
  let linearTeams: LinearTeam[] = [];
  let linearTeamsCursor: string | null = null;
  let linearTeamId = "";
  let linearIssues: LinearIssue[] = [];
  let linearIssuesCursor: string | null = null;
  let linearIssueId = "";
  let linearIssue: LinearIssue | null = null;
  let linearCreateTitle = "";
  let linearCreateDescription = "";
  let linearUpdateTitle = "";
  let linearUpdateDescription = "";
  let linearBusy = "";
  let linearGeneration = 0;
  const linearActionKeys = createLinearActionKeys(() => crypto.randomUUID(), () => sessionStorage);
  let credentialProvider = "";
  let credentialLabel = "";
  let credentialOwnership: "personal" | "workspace" = "personal";
  let apiKey = "";
  let authorizationDestination = "";
  let authorizationOwnership: "personal" | "workspace" = "personal";
  let requestedScopes: string[] = [];
  const oauthReview = createOAuthReviewController({
    storage: () => sessionStorage,
    readiness: (provider, workspaceId) => request(
      `/api/connections/providers/readiness?provider=${encodeURIComponent(provider)}&workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
    start: async ({ workspaceId, provider, ownership, label, redirectUri, githubAccess, linearAccess, slackAccess }) => request("/api/connections/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, provider, ownership, label, redirectUri,
        ...(provider === "github" ? { githubAccess } : {}),
        ...(provider === "linear" ? { linearAccess } : {}),
        ...(provider === "slack" ? { slackAccess } : {}) }),
    }),
    update: (review, pending) => {
      authorizationDestination = review?.destination ?? "";
      authorizationOwnership = review?.ownership ?? "personal";
      requestedScopes = review?.scopes ?? [];
      busy = pending ? "oauth" : busy === "oauth" ? "" : busy;
    },
  });

  function selectedAccess(): WorkspaceAccess | undefined {
    return overview?.workspaces.find(({ workspace }) => workspace.id === selectedWorkspaceId);
  }

  function canInstallShared(): boolean {
    const role = selectedAccess()?.membership.role;
    return role === "owner" || role === "admin";
  }

  function actions(connection: Connection, now: number) {
    return connectionActions(connection, overview?.actor.id ?? "", selectedAccess()?.membership.role ?? "member", providerState(connection.provider), now);
  }

  function revocationGuidance(connection: Connection): string | null {
    return providerRevocationGuidance(connection.healthReason,
      catalog?.providers.find((entry) => entry.provider === connection.provider)?.authMode ?? null,
      connection.healthReason === "provider_cleanup_requires_owner" &&
        connection.ownerUserId === overview?.actor.id && actions(connection, clockNow).canRetryRevoke);
  }


  function timestamp(value: number | null): string {
    return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value) : "—";
  }

  function providerState(provider: string): Provider["state"] | "unknown" {
    return providerDisplayState(catalog, provider);
  }

  class OMRResponseError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    if (response.status === 401 && body.error !== "SLACK_RECONNECT_REQUIRED" &&
      body.error !== "LINEAR_RECONNECT_REQUIRED" &&
      body.error !== "GITHUB_RECONNECT_REQUIRED") {
      location.assign(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error("Authentication required");
    }
    if (!response.ok) throw new OMRResponseError(body.error ?? "HTTP_ERROR",
      body.message ?? body.error ?? `Request failed (${response.status})`);
    return body as T;
  }

  const loadWorkspace = createWorkspaceCatalogLoader<Overview, Catalog>(
    async (workspaceId) => {
      const generation = ++overviewRequestGeneration;
      if (expiredAutomaticApprovalLookup(automaticApprovalLookup, recoveredApprovalId, Date.now())) {
        recoveredApprovalId = "";
        recoveryInput = "";
        automaticApprovalLookup = null;
      }
      const lookup = recoveredApprovalId;
      const result = await recoverWorkspaceOverview(lookup, (approvalId) => {
        const params = new URLSearchParams();
        if (workspaceId) params.set("workspaceId", workspaceId);
        if (approvalId) params.set("approvalId", approvalId);
        return request<Overview>(`/api/control-plane${params.size ? `?${params}` : ""}`);
      }, (error) => error instanceof OMRResponseError && error.code === "APPROVAL_UNAVAILABLE",
      () => {
        if (generation === overviewRequestGeneration && recoveredApprovalId === lookup) {
          recoveredApprovalId = "";
          automaticApprovalLookup = null;
          recoveryError = "That approval is unavailable in this workspace.";
        }
      });
      if (generation === overviewRequestGeneration) {
        const recovered = lookup && result.overview.approvals.some((approval) =>
          approval.id === lookup && visibleApprovalCard(approval, lookup, Date.now(), true));
        if (lookup && !recovered && recoveredApprovalId === lookup) {
          recoveredApprovalId = "";
          automaticApprovalLookup = null;
          recoveryError = "That approval is unavailable in this workspace.";
        } else if (!result.lookupUnavailable) {
          recoveryError = "";
        }
      }
      return result.overview;
    },
    (workspaceId) => request<Catalog>(`/api/tools?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`),
    (state) => {
      const previousLinearAccountId = selectedLinearAccountId(overview, selectedWorkspaceId);
      const previousSlackAccountId = selectedSlackAccountId(overview, selectedWorkspaceId);
      const previousNotionAccountId = selectedReadyNotionConnection({ overview, selectedWorkspaceId, loading: false, busy: "" })?.id;
      overview = state.overview;
      catalog = state.catalog;
      selectedWorkspaceId = state.selectedWorkspaceId;
      loading = state.loading;
      error = state.error;
      if (previousLinearAccountId !== selectedLinearAccountId(overview, selectedWorkspaceId)) clearLinear();
      if (previousSlackAccountId !== selectedSlackAccountId(overview, selectedWorkspaceId)) clearSlack();
      if (previousNotionAccountId !== selectedReadyNotionConnection({ overview, selectedWorkspaceId, loading: false, busy: "" })?.id) clearNotion();
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
    oauthReview.cancel();
  }

  async function switchWorkspace() {
    cancelAuthorization();
    recoveredApprovalId = "";
    recoveryInput = "";
    recoveryError = "";
    automaticApprovalLookup = null;
    clearLinear();
    clearSlack();
    clearNotion();
    apiKey = "";
    await load();
  }

  function clearLinear() {
    linearGeneration++;
    linearBusy = "";
    linearWorkspace = null;
    linearTeams = [];
    linearTeamsCursor = null;
    linearTeamId = "";
    linearIssues = [];
    linearIssuesCursor = null;
    linearIssueId = "";
    linearIssue = null;
    linearCreateTitle = "";
    linearCreateDescription = "";
    linearUpdateTitle = "";
    linearUpdateDescription = "";
  }

  /** Hide a selected account while overview and catalog are changing. */
  function linearAccount(): Connection | undefined {
    return selectedReadyLinearConnection({ overview, selectedWorkspaceId, loading, busy });
  }

  /** Use the effective catalog grant to decide whether a Linear control is usable. */
  function linearToolAvailable(toolId: string): boolean {
    return Boolean(linearAccount() && catalog?.tools.some((tool) => tool.id === toolId));
  }

  /** Publish only a read that still belongs to the selected account generation. */
  async function linearRead<T>(name: string, toolId: string, params: object,
    publish: (value: T) => void) {
    const account = linearAccount();
    if (!account || linearBusy || !linearToolAvailable(toolId)) {
      error = "Select a ready Linear account and available action first."; return;
    }
    const generation = linearGeneration;
    const workspaceId = selectedWorkspaceId;
    linearBusy = name;
    error = "";
    try {
      const receipt = await request<{ result: T }>("/api/tools/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, connectionId: account.id, toolId, params }),
      });
      if (generation === linearGeneration && workspaceId === selectedWorkspaceId &&
        account.id === linearAccount()?.id) publish(receipt.result);
    } catch (caught) {
      if (generation === linearGeneration) error = caught instanceof Error ? caught.message : "Linear read failed";
    } finally { if (generation === linearGeneration) linearBusy = ""; }
  }

  /** Ask for consent only while the selected account has this write action. */
  async function linearApproval(toolId: "linear.issues.create" | "linear.issues.update", params: object) {
    const account = linearAccount();
    if (!account || linearBusy || !linearToolAvailable(toolId)) {
      error = "Issue write access is unavailable for the selected Linear account."; return;
    }
    const generation = linearGeneration;
    const workspaceId = selectedWorkspaceId;
    linearBusy = "approval";
    error = "";
    try {
      const idempotencyKey = await linearActionKeys.key(toolId, workspaceId, account.id, params);
      const approval = await request<{ id: string; status: string; expiresAt: number }>("/api/approvals", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, connectionId: account.id,
          toolId, params, idempotencyKey }),
      });
      if (generation !== linearGeneration || workspaceId !== selectedWorkspaceId ||
        account.id !== linearAccount()?.id) return;
      recoveredApprovalId = ["pending", "approved", "uncertain"].includes(approval.status)
        ? approval.id : "";
      automaticApprovalLookup = ["pending", "approved"].includes(approval.status)
        ? { id: approval.id, expiresAt: approval.expiresAt } : null;
      recoveryInput = recoveredApprovalId;
      notice = linearApprovalNotice(approval.status);
      await load();
    } catch (caught) {
      if (generation === linearGeneration) {
        error = caught instanceof Error ? caught.message : "Could not request Linear approval";
      }
    } finally { if (generation === linearGeneration) linearBusy = ""; }
  }

  /** A deliberate identical write gets a new key after the old action settles. */
  async function resetLinearAction(toolId: "linear.issues.create" | "linear.issues.update", params: object) {
    const account = linearAccount();
    if (!account || linearBusy) return;
    const generation = linearGeneration;
    const workspaceId = selectedWorkspaceId;
    linearBusy = "reset";
    error = "";
    notice = "";
    try {
      // Replaying the same key recovers state after a lost response without
      // dispatching a provider mutation.
      await linearActionKeys.resetAfterSettlement(toolId, workspaceId, account.id, params,
        (idempotencyKey) => request<{ status: string }>("/api/approvals", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, connectionId: account.id, toolId, params, idempotencyKey }),
      }), () => generation === linearGeneration && workspaceId === selectedWorkspaceId &&
        account.id === linearAccount()?.id);
      if (generation !== linearGeneration || workspaceId !== selectedWorkspaceId ||
          account.id !== linearAccount()?.id) return;
      recoveredApprovalId = "";
      recoveryInput = "";
      automaticApprovalLookup = null;
      notice = "New Linear action started. Review the account and target before requesting approval.";
    } catch (caught) {
      if (generation === linearGeneration) error = caught instanceof Error ? caught.message : "Could not start another Linear action";
    } finally { if (generation === linearGeneration) linearBusy = ""; }
  }

  function linearUpdateChanges(): { title?: string; description?: string } {
    if (!linearIssue) return {};
    return {
      ...(linearUpdateTitle !== linearIssue.title ? { title: linearUpdateTitle } : {}),
      ...(linearUpdateDescription !== (linearIssue.description ?? "")
        ? { description: linearUpdateDescription } : {}),
    };
  }

  function clearNotion() {
    notionGeneration++;
    notionBusy = "";
    notionItems = [];
    notionCursor = null;
    notionPageId = "";
    notionPage = null;
    notionCreateTitle = "";
    notionUpdateTitle = "";
  }

  function notionAccount(): Connection | undefined {
    return selectedReadyNotionConnection({ overview, selectedWorkspaceId, loading, busy });
  }

  function notionToolAvailable(toolId: string): boolean {
    return Boolean(notionAccount() && catalog?.tools.some((tool) => tool.id === toolId));
  }

  async function notionRead<T>(toolId: string, params: object, publish: (value: T) => void) {
    const account = notionAccount();
    if (!account || notionBusy || !notionToolAvailable(toolId)) {
      error = "Select a ready Notion integration and available action first."; return;
    }
    const generation = notionGeneration;
    const workspaceId = selectedWorkspaceId;
    notionBusy = toolId;
    error = "";
    try {
      const receipt = await request<{ result: T }>("/api/tools/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, connectionId: account.id, toolId, params }),
      });
      if (generation === notionGeneration && workspaceId === selectedWorkspaceId &&
          account.id === notionAccount()?.id) publish(receipt.result);
    } catch (caught) {
      if (generation === notionGeneration && workspaceId === selectedWorkspaceId) {
        error = caught instanceof Error ? caught.message : "Notion read failed";
      }
    } finally { if (generation === notionGeneration) notionBusy = ""; }
  }

  function notionParams(toolId: "notion.pages.create" | "notion.pages.update") {
    return toolId === "notion.pages.create"
      ? { parentPageId: notionPageId, title: notionCreateTitle }
      : { pageId: notionPageId, title: notionUpdateTitle };
  }

  async function notionApproval(toolId: "notion.pages.create" | "notion.pages.update") {
    const account = notionAccount();
    if (!account || notionBusy || !notionPage || notionPage.id !== notionPageId ||
        !notionToolAvailable(toolId)) {
      error = "Choose and read a shared Notion page before requesting a change."; return;
    }
    const generation = notionGeneration;
    const workspaceId = selectedWorkspaceId;
    const params = notionParams(toolId);
    notionBusy = "approval";
    error = "";
    try {
      const idempotencyKey = await notionActionKeys.key(toolId, workspaceId, account.id, params);
      const approval = await request<{ id: string; status: string; expiresAt: number }>("/api/approvals", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, connectionId: account.id, toolId, params, idempotencyKey }),
      });
      if (generation !== notionGeneration || workspaceId !== selectedWorkspaceId ||
          account.id !== notionAccount()?.id) return;
      if (JSON.stringify(params) !== JSON.stringify(notionParams(toolId))) {
        await load();
        notice = "The Notion destination or title changed. Review the created approval before requesting another.";
        return;
      }
      recoveredApprovalId = ["pending", "approved", "uncertain"].includes(approval.status) ? approval.id : "";
      automaticApprovalLookup = ["pending", "approved"].includes(approval.status)
        ? { id: approval.id, expiresAt: approval.expiresAt } : null;
      recoveryInput = recoveredApprovalId;
      notice = linearApprovalNotice(approval.status);
      await load();
    } catch (caught) {
      if (generation === notionGeneration) error = caught instanceof Error ? caught.message : "Could not request Notion approval";
    } finally { if (generation === notionGeneration) notionBusy = ""; }
  }

  async function resetNotionAction(toolId: "notion.pages.create" | "notion.pages.update") {
    const account = notionAccount();
    if (!account || notionBusy || !notionPage || notionPage.id !== notionPageId) return;
    const generation = notionGeneration;
    const workspaceId = selectedWorkspaceId;
    const params = notionParams(toolId);
    notionBusy = "reset";
    error = "";
    try {
      await notionActionKeys.resetAfterSettlement(toolId, workspaceId, account.id, params,
        (idempotencyKey) => request<{ status: string }>("/api/approvals", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, connectionId: account.id, toolId, params, idempotencyKey }),
        }), () => generation === notionGeneration && workspaceId === selectedWorkspaceId &&
          account.id === notionAccount()?.id);
      if (generation !== notionGeneration || workspaceId !== selectedWorkspaceId ||
          account.id !== notionAccount()?.id) return;
      recoveredApprovalId = "";
      recoveryInput = "";
      automaticApprovalLookup = null;
      notice = "New Notion action started. Review its page and title before requesting approval.";
    } catch (caught) {
      if (generation === notionGeneration) error = caught instanceof Error ? caught.message : "Could not start another Notion action";
    } finally { if (generation === notionGeneration) notionBusy = ""; }
  }

  /** Invalidate pending reads whenever the visible Slack journey is reset. */
  function clearSlack() {
    slackGeneration++;
    slackBusy = "";
    slackReadOwner = null;
    slackWorkspace = null;
    slackChannels = [];
    slackChannelsCursor = null;
    slackChannelId = "";
    slackMessages = [];
    slackMessagesCursor = null;
    slackFilteredCount = 0;
    slackText = "";
  }

  /** Resolve only the ready Slack binding in the current workspace. */
  function slackAccount(): Connection | undefined {
    return selectedReadySlackConnection({ overview, selectedWorkspaceId, loading, busy });
  }

  /** Check the selected binding and the current scoped catalog together. */
  function slackToolAvailable(toolId: string): boolean {
    return Boolean(slackAccount() && catalog?.tools.some((tool) => tool.id === toolId));
  }

  /** Publish a read only if its workspace, account, and channel generation still match. */
  async function slackRead<T>(toolId: string, params: object, publish: (value: T) => void) {
    const account = slackAccount();
    if (!account || slackBusy || !slackToolAvailable(toolId)) {
      error = "Select a ready Slack bot and available action first."; return;
    }
    const selection = { generation: slackGeneration, workspaceId: selectedWorkspaceId, accountId: account.id };
    const currentSelection = () => ({ generation: slackGeneration, workspaceId: selectedWorkspaceId,
      accountId: slackAccount()?.id });
    slackReadOwner = selection;
    slackBusy = toolId;
    error = "";
    try {
      const receipt = await request<{ result: T }>("/api/tools/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: selection.workspaceId, connectionId: account.id, toolId, params }),
      });
      if (sameSlackReadSelection(selection, currentSelection())) publish(receipt.result);
    } catch (caught) {
      if (sameSlackReadSelection(selection, currentSelection())) {
        error = caught instanceof Error ? caught.message : "Slack read failed";
      }
    } finally {
      // A global mutation or overview refresh may hide the same bot temporarily.
      // Release only this read's lock; publication still requires a visible binding.
      if (slackReadOwner === selection && selection.generation === slackGeneration &&
          selection.workspaceId === selectedWorkspaceId && slackBusy === toolId) {
        slackBusy = "";
        slackReadOwner = null;
      }
    }
  }

  /** Snapshot the visible bot, channel, and message for one approval intent. */
  function slackPostParams() {
    return { workspaceId: slackWorkspace?.id, channelId: slackChannelId,
      senderId: slackWorkspace?.sender.id, text: slackText };
  }

  /** Publish an approval only while its exact form and selected binding remain current. */
  async function slackApproval() {
    const account = slackAccount();
    if (!account || !slackWorkspace || !slackChannelId || slackBusy ||
        !slackToolAvailable("slack.messages.post")) {
      error = "Slack posting is unavailable for the selected bot and channel."; return;
    }
    const generation = slackGeneration;
    const workspaceId = selectedWorkspaceId;
    const params = slackPostParams();
    slackBusy = "approval";
    error = "";
    try {
      const idempotencyKey = await slackActionKeys.key("slack.messages.post", workspaceId, account.id, params);
      const approval = await request<{ id: string; status: string; expiresAt: number }>("/api/approvals", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, connectionId: account.id,
          toolId: "slack.messages.post", params, idempotencyKey }),
      });
      if (generation !== slackGeneration || workspaceId !== selectedWorkspaceId ||
          account.id !== slackAccount()?.id) return;
      if (!sameSlackPostParams(params, slackPostParams())) {
        await load();
        if (generation === slackGeneration) {
          notice = "The Slack post changed while approval was requested. Review the created approval before requesting another.";
        }
        return;
      }
      recoveredApprovalId = ["pending", "approved", "uncertain"].includes(approval.status) ? approval.id : "";
      automaticApprovalLookup = ["pending", "approved"].includes(approval.status)
        ? { id: approval.id, expiresAt: approval.expiresAt } : null;
      recoveryInput = recoveredApprovalId;
      notice = slackApprovalNotice(approval.status);
      await load();
    } catch (caught) {
      if (generation === slackGeneration) error = caught instanceof Error ? caught.message : "Could not request Slack approval";
    } finally { if (generation === slackGeneration) slackBusy = ""; }
  }

  async function resetSlackAction() {
    const account = slackAccount();
    if (!account || slackBusy) return;
    const generation = slackGeneration;
    const workspaceId = selectedWorkspaceId;
    const params = slackPostParams();
    slackBusy = "reset";
    error = "";
    try {
      await slackActionKeys.resetAfterSettlement("slack.messages.post", workspaceId, account.id, params,
        (idempotencyKey) => request<{ status: string }>("/api/approvals", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, connectionId: account.id,
            toolId: "slack.messages.post", params, idempotencyKey }),
        }), () => generation === slackGeneration && workspaceId === selectedWorkspaceId &&
          account.id === slackAccount()?.id);
      if (generation !== slackGeneration || workspaceId !== selectedWorkspaceId ||
          account.id !== slackAccount()?.id) return;
      recoveredApprovalId = "";
      recoveryInput = "";
      automaticApprovalLookup = null;
      notice = "New Slack post started. Review its channel and sender before requesting approval.";
    } catch (caught) {
      if (generation === slackGeneration) error = caught instanceof Error ? caught.message : "Could not start another Slack post";
    } finally { if (generation === slackGeneration) slackBusy = ""; }
  }

  async function mutate(name: string, path: string, body: unknown, success: string) {
    if (name.startsWith("select:") || name.startsWith("refresh:") || name.startsWith("health:") ||
        name.startsWith("reconcile:")) { clearLinear(); clearSlack(); clearNotion(); }
    if (name.startsWith("execute:") && overview?.approvals.some((approval) =>
      name === `execute:${approval.id}` && approval.toolId.startsWith("linear."))) clearLinear();
    if (name.startsWith("execute:") && overview?.approvals.some((approval) =>
      name === `execute:${approval.id}` && approval.toolId.startsWith("slack."))) clearSlack();
    if (name.startsWith("execute:") && overview?.approvals.some((approval) =>
      name === `execute:${approval.id}` && approval.toolId.startsWith("notion."))) clearNotion();
    busy = name;
    error = "";
    notice = "";
    try {
      await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (["reconcile:", "reject:", "execute:"].some((prefix) =>
        name === `${prefix}${recoveredApprovalId}`)) {
        recoveredApprovalId = "";
        recoveryInput = "";
        automaticApprovalLookup = null;
      }
      notice = success;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "The operation failed";
    } finally {
      busy = "";
    }
  }

  /** Record a verified outcome against the exact uncertain provider receipt. */
  async function reconcileProvider(approvalId: string, decision: "effect_present" | "effect_absent") {
    const workspaceId = selectedWorkspaceId;
    busy = `reconcile:${approvalId}`;
    clearLinear();
    clearSlack();
    clearNotion();
    error = "";
    notice = "";
    const success = decision === "effect_present"
      ? "Recorded that the action happened." : "Recorded that the action did not happen.";
    try {
      await recoverProviderReconciliation(approvalId, decision,
        () => request<Approval>("/api/approvals/reconcile", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ approvalId, decision, workspaceId }),
        }),
        () => request<Approval>(`/api/approvals/status?${new URLSearchParams({ approvalId, workspaceId })}`));
    } catch (caught) {
      if (workspaceId === selectedWorkspaceId) error = caught instanceof Error ? caught.message : "Reconciliation is unconfirmed";
      return;
    } finally {
      busy = "";
    }
    if (workspaceId !== selectedWorkspaceId) return;
    recoveredApprovalId = approvalId;
    recoveryInput = approvalId;
    automaticApprovalLookup = null;
    notice = success;
    await load();
  }

  async function createTeam() {
    const name = teamName;
    await mutate("team", "/api/workspaces/team", { name }, `Created ${name}.`);
    teamName = "";
  }

  /** Review the chosen GitHub grant before leaving OMR for provider consent. */
  async function connectOAuth(connection?: Connection) {
    error = "";
    notice = "";
    try {
      const provider = connection?.provider ?? oauthProvider;
      const ownership = connection?.ownership ?? oauthOwnership;
      const label = connection?.label ?? (oauthLabel.trim() || catalog?.providers.find((item) => item.provider === provider)?.displayName || provider);
      await oauthReview.start({ workspaceId: selectedWorkspaceId, provider, ownership, label,
        origin: location.origin, ...(provider === "github" ? { githubAccess } : {}),
        ...(provider === "linear" ? { linearAccess } : {}),
        ...(provider === "slack" ? { slackAccess } : {}) });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Could not start provider authorization";
    }
  }

  /** GitHub reconnect requires a fresh access-tier choice before starting consent. */
  function reconnectOAuth(connection: Connection) {
    if (connection.provider === "github") {
      const choice = beginGithubReconnect(oauthReview, connection);
      oauthProvider = choice.provider;
      oauthOwnership = choice.ownership;
      oauthLabel = choice.label;
      githubAccess = choice.access;
      error = "";
      notice = "Choose the GitHub access tier below, then continue to reconnect. A new OAuth grant is required.";
      return;
    }
    if (connection.provider === "linear") {
      oauthReview.cancel();
      oauthProvider = "linear";
      oauthOwnership = connection.ownership;
      oauthLabel = connection.label;
      linearAccess = "read";
      notice = "Choose Linear read or issue-write access below, then reconnect with fresh consent.";
      return;
    }
    if (connection.provider === "slack") {
      oauthReview.cancel();
      oauthProvider = "slack";
      oauthOwnership = connection.ownership;
      oauthLabel = connection.label;
      slackAccess = "discover";
      notice = "Choose Slack bot access below, then reconnect with fresh consent.";
      return;
    }
    void connectOAuth(connection);
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
    if (connection.provider === "linear") clearLinear();
    if (connection.provider === "slack") clearSlack();
    if (connection.provider === "notion") clearNotion();
    busy = `disconnect:${connection.id}`;
    error = "";
    notice = "";
    try {
      const result = await request<{ connection: Connection; provider: { disconnected: boolean; remoteRevokeSucceeded: boolean; remoteRevokeAttempted: boolean } }>(
        "/api/connections/disconnect", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: connection.id }),
        },
      );
      notice = revocationGuidance(result.connection)
        ?? (result.connection.healthReason === "provider_cleanup_pending" || result.connection.healthReason?.startsWith("provider_cleanup_pending:")
          ? "OMR access was removed. Provider cleanup is in progress; retry if it does not finish."
          : result.connection.healthReason === "remote_revoke_failed" || result.connection.healthReason === "provider_cleanup_failed"
            ? "OMR access was removed. Provider cleanup failed; retry or revoke the grant at the provider."
            : `Disconnected ${connection.label}.`);
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
    const clock = setInterval(() => { clockNow = Date.now(); }, 1_000);
    const connected = new URLSearchParams(location.search).get("connected");
    if (connected && (V1_PROVIDERS as readonly string[]).includes(connected)) {
      notice = `Connected ${connected}.`;
    }
    void load("");
    return () => clearInterval(clock);
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
            <span>{overview.connections.filter((item) => item.status !== "revoked" && !item.cleanupOnly).length} connected accounts</span>
          </div>

          <p>Personal accounts are visible only to you. Team accounts are available to workspace members; only owners and admins can connect, refresh, or disconnect them. Owners and admins can remove a former member's orphaned personal account.</p>

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
                    <span>{connection.provider} · {connection.cleanupOnly ? "Former member’s personal account · cleanup only" : connection.ownership === "personal" ? "Personal · only you" : "Team · shared with members"}
                      {#if connection.selected} · Selected for your actions{/if}
                    </span>
                    <span>Last checked {timestamp(connection.lastCheckedAt)}{connection.healthReason ? ` · ${connection.healthReason.split(":")[0]?.replaceAll("_", " ")}` : ""}</span>
                    {#if revocationGuidance(connection)}
                      <span>{revocationGuidance(connection)}</span>
                    {/if}
                  </div>
                  <span class:ready={actions(connection, clockNow).canSelect} class="status">{connectionStatusLabel(connection, providerState(connection.provider))}</span>
                  {#if actions(connection, clockNow).canSelect}
                    <button
                      class="quiet compact"
                      disabled={Boolean(busy) || connection.selected}
                      onclick={() => void mutate(`select:${connection.id}`, "/api/connections/select", {
                        workspaceId: selectedWorkspaceId, provider: connection.provider, connectionId: connection.id,
                      }, `Selected ${connection.label} for ${connection.provider}.`)}
                    >{connection.selected ? "Selected" : "Select account"}</button>
                  {/if}
                  {#if actions(connection, clockNow).canCheck}<button
                    class="quiet compact"
                    disabled={Boolean(busy)}
                    onclick={() => void mutate(`health:${connection.id}`, "/api/connections/health", { connectionId: connection.id }, `Checked ${connection.label}.`)}
                  >Check health</button>{/if}
                  {#if actions(connection, clockNow).canRefresh}<button class="quiet compact" disabled={Boolean(busy)}
                    onclick={() => void mutate(`refresh:${connection.id}`, "/api/connections/refresh", { connectionId: connection.id }, `Refreshed ${connection.label}.`)}>Refresh</button>{/if}
                  {#if actions(connection, clockNow).canReconnect}<button class="quiet compact" disabled={Boolean(busy)}
                    onclick={() => connection.provider && catalog?.providers.find((entry) => entry.provider === connection.provider)?.authMode === "oauth"
                      ? reconnectOAuth(connection)
                      : (credentialProvider = connection.provider, credentialOwnership = connection.ownership, credentialLabel = connection.label, notice = "Enter a new API key below to reconnect.")}>Reconnect</button>{/if}
                  {#if actions(connection, clockNow).canDisconnect || actions(connection, clockNow).canRetryRevoke}<button
                    class="danger compact"
                    disabled={Boolean(busy)}
                    onclick={() => void disconnect(connection)}
                  >{connection.status === "revoked" ? "Retry provider revocation" : connection.cleanupOnly ? "Remove orphaned account" : "Disconnect"}</button>{/if}
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
              {#if oauthProvider === "github"}
                <label>GitHub access
                  <select bind:value={githubAccess}>
                    <option value="profile">Account and public repository reads · read:user</option>
                    <option value="public_write">Public issue comments · read:user, public_repo</option>
                    <option value="private_repositories">Private repository reads · read:user, repo</option>
                  </select>
                </label>
              {/if}
              {#if oauthProvider === "linear"}
                <label>Linear access
                  <select bind:value={linearAccess}>
                    <option value="read">Workspace, teams, and issue reads · read</option>
                    <option value="issue_write">Create and update issues · read, write</option>
                  </select>
                </label>
              {/if}
              {#if oauthProvider === "slack"}
                <label>Slack bot access
                  <select bind:value={slackAccess}>
                    <option value="discover">Joined public channels · channels:read</option>
                    <option value="read">Channel messages · channels:read, channels:history</option>
                    <option value="post">Approved message posts · channels:read, chat:write</option>
                    <option value="read_post">Read and approved posts · channels:read, channels:history, chat:write</option>
                  </select>
                </label>
              {/if}
              {#if oauthProvider === "notion"}
                <p>Notion's consent page chooses which pages and databases are shared with this integration. OMR can read shared pages and request approval to create or rename a page.</p>
              {/if}
            </div>
            <p>OMR shows the requested scopes before provider consent. Linear, Slack, and Notion changes require OMR approval. Review the provider consent screen before granting access.</p>
            <button class="primary" type="submit" disabled={Boolean(busy) || !selectedWorkspaceId || !oauthProvider}>
              {busy === "oauth" ? "Opening provider…" : "Continue to provider"}
            </button>
          </form>
          {#if authorizationDestination}
            <div class="inset" role="region" aria-label="Review provider access">
              <strong>Review requested access</strong>
              <p>{new URL(authorizationDestination).hostname} will receive a {authorizationOwnership === "personal" ? "personal" : "team"} connection.</p>
              {#if requestedScopes.length}<p>Requested scopes: {requestedScopes.join(", ")}</p>
              {:else}<p>No named scopes appear in this authorization URL. Confirm the permissions and shared pages on the provider consent screen.</p>{/if}
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

        {#if catalog?.providers.find((entry) => entry.provider === "linear")?.state === "ready"}
          <section class="panel" aria-label="Linear issue journey">
            <div class="panel-heading"><div><p class="kicker">Linear</p><h2>Issues</h2></div></div>
            <p>Selected account: {linearAccount()?.label ?? "Select a Linear account above"}. Choose the Linear workspace and team before reading or changing an issue. Changes wait for approval.</p>
            {#if linearAccount() && !linearToolAvailable("linear.workspace.get")}
              <p class="approval-context">Linear reads are unavailable for this grant. Reconnect with read access or select another account.</p>
            {/if}
            <button class="quiet compact" disabled={Boolean(linearBusy) || !linearToolAvailable("linear.workspace.get")}
              onclick={() => void linearRead<{ id: string; name: string }>("workspace", "linear.workspace.get", {},
                (value) => { clearLinear(); linearWorkspace = value; })}>Find Linear workspace</button>
            {#if linearWorkspace}
              <p>{linearWorkspace.name} · {linearWorkspace.id}</p>
              <button class="quiet compact" disabled={Boolean(linearBusy)}
                onclick={() => void linearRead<{ nodes: LinearTeam[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>("teams", "linear.teams.list",
                  { linearWorkspaceId: linearWorkspace?.id },
                  (value) => { linearTeams = value.nodes; linearTeamsCursor = value.pageInfo.hasNextPage ? value.pageInfo.endCursor : null;
                    linearTeamId = ""; linearIssues = []; linearIssue = null; })}>Find teams</button>
              {#if linearTeamsCursor}
                <button class="quiet compact" disabled={Boolean(linearBusy)}
                  onclick={() => void linearRead<{ nodes: LinearTeam[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>("teams", "linear.teams.list",
                    { linearWorkspaceId: linearWorkspace?.id, after: linearTeamsCursor },
                    (value) => { linearTeams = [...linearTeams, ...value.nodes];
                      linearTeamsCursor = value.pageInfo.hasNextPage ? value.pageInfo.endCursor : null; })}>More teams</button>
              {/if}
              {#if linearTeams.length}
                <label>Team
                  <select bind:value={linearTeamId} onchange={() => { linearGeneration++; linearBusy = "";
                    linearIssues = []; linearIssuesCursor = null; linearIssueId = ""; linearIssue = null;
                    linearCreateTitle = ""; linearCreateDescription = ""; }}>
                    <option value="">Choose a team</option>
                    {#each linearTeams as team}<option value={team.id}>{team.name} ({team.key})</option>{/each}
                  </select>
                </label>
                {#if linearTeamId}
                  <button class="quiet compact" disabled={Boolean(linearBusy)}
                    onclick={() => void linearRead<{ nodes: LinearIssue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>("issues", "linear.issues.list",
                      { linearWorkspaceId: linearWorkspace?.id, teamId: linearTeamId },
                      (value) => { linearIssues = value.nodes;
                        linearIssuesCursor = value.pageInfo.hasNextPage ? value.pageInfo.endCursor : null;
                        linearIssueId = ""; linearIssue = null; })}>Find issues</button>
                  {#if linearIssuesCursor}
                    <button class="quiet compact" disabled={Boolean(linearBusy)}
                      onclick={() => void linearRead<{ nodes: LinearIssue[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>("issues", "linear.issues.list",
                        { linearWorkspaceId: linearWorkspace?.id, teamId: linearTeamId, after: linearIssuesCursor },
                        (value) => { linearIssues = [...linearIssues, ...value.nodes];
                          linearIssuesCursor = value.pageInfo.hasNextPage ? value.pageInfo.endCursor : null; })}>More issues</button>
                  {/if}
                  {#if linearToolAvailable("linear.issues.create")}
                  <form class="inset" onsubmit={(event) => { event.preventDefault(); void linearApproval("linear.issues.create",
                    { linearWorkspaceId: linearWorkspace?.id, teamId: linearTeamId,
                      title: linearCreateTitle, description: linearCreateDescription }); }}>
                    <strong>Create issue in {linearTeams.find((team) => team.id === linearTeamId)?.name}</strong>
                    <label>Title<input bind:value={linearCreateTitle} maxlength="255" required /></label>
                    <label>Description<textarea bind:value={linearCreateDescription} maxlength="20000"></textarea></label>
                    <button class="primary compact" type="submit" disabled={Boolean(linearBusy) || !linearCreateTitle.trim()}>Request creation approval</button>
                    <button class="quiet compact" type="button" disabled={Boolean(linearBusy)}
                      onclick={() => void resetLinearAction("linear.issues.create",
                        { linearWorkspaceId: linearWorkspace?.id, teamId: linearTeamId,
                          title: linearCreateTitle, description: linearCreateDescription })}>Start a new creation action</button>
                  </form>
                  {/if}
                {/if}
              {/if}
              {#if linearIssues.length}
                <label>Issue
                  <select bind:value={linearIssueId} onchange={() => { linearGeneration++; linearBusy = ""; linearIssue = null; }}>
                    <option value="">Choose an issue</option>
                    {#each linearIssues as entry}<option value={entry.id}>{entry.identifier} · {entry.title}</option>{/each}
                  </select>
                </label>
                <button class="quiet compact" disabled={Boolean(linearBusy) || !linearIssueId}
                  onclick={() => void linearRead<LinearIssue>("issue", "linear.issues.get",
                    { linearWorkspaceId: linearWorkspace?.id, issueId: linearIssueId },
                    (value) => { linearIssue = value; linearUpdateTitle = value.title;
                      linearUpdateDescription = value.description ?? ""; })}>Read issue</button>
              {/if}
              {#if linearIssue}
                <p><a href={linearIssue.url} target="_blank" rel="noopener noreferrer">{linearIssue.identifier}</a> · {linearIssue.state?.name ?? "No state"}</p>
                {#if linearToolAvailable("linear.issues.update")}
                <form class="inset" onsubmit={(event) => { event.preventDefault(); void linearApproval("linear.issues.update",
                  { linearWorkspaceId: linearWorkspace?.id, issueId: linearIssue?.id,
                    ...linearUpdateChanges() }); }}>
                  <strong>Update {linearIssue.identifier}</strong>
                  <label>Title<input bind:value={linearUpdateTitle} maxlength="255" required /></label>
                  <label>Description<textarea bind:value={linearUpdateDescription} maxlength="20000"></textarea></label>
                  <button class="primary compact" type="submit" disabled={Boolean(linearBusy) || !linearUpdateTitle.trim() || !Object.keys(linearUpdateChanges()).length}>Request update approval</button>
                  <button class="quiet compact" type="button" disabled={Boolean(linearBusy)}
                    onclick={() => void resetLinearAction("linear.issues.update",
                      { linearWorkspaceId: linearWorkspace?.id, issueId: linearIssue?.id,
                        ...linearUpdateChanges() })}>Start a new update action</button>
                </form>
                {/if}
              {/if}
            {/if}
          </section>
        {/if}

        {#if catalog?.providers.find((entry) => entry.provider === "notion")?.state === "ready"}
          <section class="panel" aria-label="Notion page journey">
            <div class="panel-heading"><div><p class="kicker">Notion</p><h2>Shared pages</h2></div></div>
            <p>Selected integration: {notionAccount()?.label ?? "Select a Notion account above"}. Search shows content shared with that integration. Choose and read a page before creating a child or renaming it. Every change waits for separate approval.</p>
            <form class="inset" onsubmit={(event) => { event.preventDefault(); notionGeneration++; notionBusy = "";
              notionItems = []; notionCursor = null; notionPageId = ""; notionPage = null;
              void notionRead<{ items: NotionItem[]; nextCursor: string | null }>("notion.content.search",
                { query: notionQuery }, (value) => { notionItems = value.items; notionCursor = value.nextCursor; }); }}>
              <label>Search shared content<input bind:value={notionQuery} maxlength="100" placeholder="Optional title" /></label>
              <button class="quiet compact" type="submit" disabled={Boolean(notionBusy) || !notionToolAvailable("notion.content.search")}>Find pages and databases</button>
            </form>
            {#if notionCursor}
              <button class="quiet compact" disabled={Boolean(notionBusy)} onclick={() => void notionRead<{ items: NotionItem[]; nextCursor: string | null }>(
                "notion.content.search", { query: notionQuery, cursor: notionCursor },
                (value) => { notionItems = [...notionItems, ...value.items]; notionCursor = value.nextCursor; })}>More shared content</button>
            {/if}
            {#each notionItems.filter((entry) => entry.type === "database") as database}
              <p>Database: <a href={database.url} target="_blank" rel="noopener noreferrer">{database.title}</a> · browse in Notion</p>
            {/each}
            {#if notionItems.some((entry) => entry.type === "page")}
              <label>Destination or page to rename
                <select bind:value={notionPageId} disabled={Boolean(notionBusy)} onchange={() => {
                  notionGeneration++; notionBusy = ""; notionPage = null; notionCreateTitle = ""; notionUpdateTitle = "";
                }}>
                  <option value="">Choose a shared page</option>
                  {#each notionItems.filter((entry) => entry.type === "page") as entry}
                    <option value={entry.id}>{entry.title}</option>
                  {/each}
                </select>
              </label>
              <button class="quiet compact" disabled={Boolean(notionBusy) || !notionPageId || !notionToolAvailable("notion.pages.get")}
                onclick={() => void notionRead<NotionPage>("notion.pages.get", { pageId: notionPageId },
                  (value) => { notionPage = value; notionUpdateTitle = value.title; })}>Read selected page</button>
            {/if}
            {#if notionPage && notionPage.id === notionPageId}
              <p><a href={notionPage.url} target="_blank" rel="noopener noreferrer">{notionPage.title}</a> · {notionPage.id}</p>
              {#if notionToolAvailable("notion.pages.create")}
                <form class="inset" onsubmit={(event) => { event.preventDefault(); void notionApproval("notion.pages.create"); }}>
                  <strong>Create a child beneath {notionPage.title}</strong>
                  <label>New page title<input bind:value={notionCreateTitle} maxlength="200" required disabled={Boolean(notionBusy)} /></label>
                  <button class="primary compact" type="submit" disabled={Boolean(notionBusy) || !notionCreateTitle.trim()}>Request creation approval</button>
                  <button class="quiet compact" type="button" disabled={Boolean(notionBusy)} onclick={() => void resetNotionAction("notion.pages.create")}>Start a new identical creation</button>
                </form>
              {/if}
              {#if notionToolAvailable("notion.pages.update")}
                <form class="inset" onsubmit={(event) => { event.preventDefault(); void notionApproval("notion.pages.update"); }}>
                  <strong>Rename {notionPage.title}</strong>
                  <label>Page title<input bind:value={notionUpdateTitle} maxlength="200" required disabled={Boolean(notionBusy)} /></label>
                  <button class="primary compact" type="submit" disabled={Boolean(notionBusy) || !notionUpdateTitle.trim() || notionUpdateTitle === notionPage.title}>Request rename approval</button>
                  <button class="quiet compact" type="button" disabled={Boolean(notionBusy)} onclick={() => void resetNotionAction("notion.pages.update")}>Start a new identical rename</button>
                </form>
              {/if}
            {/if}
          </section>
        {/if}

        {#if catalog?.providers.find((entry) => entry.provider === "slack")?.state === "ready"}
          <section class="panel" aria-label="Slack channel journey">
            <div class="panel-heading"><div><p class="kicker">Slack</p><h2>Channels</h2></div></div>
            <p>Selected bot: {slackAccount()?.label ?? "Select a Slack account above"}. OMR v1 uses joined, local public channels. Posts use the bot identity shown below and wait for separate approval.</p>
            <button class="quiet compact" disabled={Boolean(slackBusy) || !slackToolAvailable("slack.workspace.get")}
              onclick={() => void slackRead<{ id: string; name: string; sender: { type: "bot"; id: string; botId: string } }>(
                "slack.workspace.get", {}, (value) => { clearSlack(); slackWorkspace = value; })}>
              Find Slack workspace and sender</button>
            {#if slackWorkspace}
              <p>{slackWorkspace.name} · {slackWorkspace.id} · bot sender {slackWorkspace.sender.id}</p>
              <button class="quiet compact" disabled={Boolean(slackBusy) || !slackToolAvailable("slack.channels.list")}
                onclick={() => void slackRead<{ channels: SlackChannel[]; nextCursor: string | null }>(
                  "slack.channels.list", { workspaceId: slackWorkspace?.id },
                  (value) => { slackChannels = value.channels; slackChannelsCursor = value.nextCursor;
                    slackChannelId = ""; slackMessages = []; slackFilteredCount = 0; })}>Find joined public channels</button>
              {#if slackChannelsCursor}
                <button class="quiet compact" disabled={Boolean(slackBusy)}
                  onclick={() => void slackRead<{ channels: SlackChannel[]; nextCursor: string | null }>(
                    "slack.channels.list", { workspaceId: slackWorkspace?.id, cursor: slackChannelsCursor },
                    (value) => { slackChannels = [...slackChannels, ...value.channels];
                      slackChannelsCursor = value.nextCursor; })}>More channels</button>
              {/if}
              {#if slackChannels.length}
                <label>Channel
                  <select bind:value={slackChannelId} disabled={slackChannelSelectionLocked(slackBusy)} onchange={() => { slackGeneration++; slackBusy = ""; slackReadOwner = null;
                    slackMessages = []; slackMessagesCursor = null; slackFilteredCount = 0; slackText = ""; }}>
                    <option value="">Choose a channel</option>
                    {#each slackChannels as entry}<option value={entry.id}>#{entry.name}</option>{/each}
                  </select>
                </label>
                {#if slackChannelId}
                  {#if slackToolAvailable("slack.messages.list")}
                    <button class="quiet compact" disabled={Boolean(slackBusy)}
                      onclick={() => void slackRead<{ messages: SlackMessage[]; filteredCount: number; nextCursor: string | null }>(
                        "slack.messages.list", { workspaceId: slackWorkspace?.id, channelId: slackChannelId },
                        (value) => { slackMessages = value.messages; slackFilteredCount = value.filteredCount;
                          slackMessagesCursor = value.nextCursor; })}>
                      Read messages</button>
                    {#if slackMessagesCursor}
                      <button class="quiet compact" disabled={Boolean(slackBusy)}
                        onclick={() => void slackRead<{ messages: SlackMessage[]; filteredCount: number; nextCursor: string | null }>(
                          "slack.messages.list", { workspaceId: slackWorkspace?.id,
                            channelId: slackChannelId, cursor: slackMessagesCursor },
                          (value) => { slackMessages = [...slackMessages, ...value.messages];
                            slackFilteredCount += value.filteredCount;
                            slackMessagesCursor = value.nextCursor; })}>More messages</button>
                    {/if}
                    {#if slackFilteredCount > 0}
                      <p>Some Slack history entries cannot be displayed as text messages. Continue reading if another page is available.</p>
                    {/if}
                    {#each slackMessages as message}
                      <p><strong>{message.user ?? "Slack"}</strong> · {message.text}</p>
                    {/each}
                  {/if}
                  {#if slackToolAvailable("slack.messages.post")}
                    <form class="inset" onsubmit={(event) => { event.preventDefault(); void slackApproval(); }}>
                      <strong>Post as bot {slackWorkspace.sender.id} to #{slackChannels.find((entry) => entry.id === slackChannelId)?.name}</strong>
                      <label>Message<textarea bind:value={slackText} maxlength="4000" required disabled={Boolean(slackBusy)}></textarea></label>
                      <button class="primary compact" type="submit" disabled={Boolean(slackBusy) || !slackText.trim()}>
                        Request post approval</button>
                      <button class="quiet compact" type="button" disabled={Boolean(slackBusy)}
                        onclick={() => void resetSlackAction()}>Start a new identical post</button>
                    </form>
                  {/if}
                {/if}
              {/if}
            {/if}
          </section>
        {/if}

        <section class="panel approvals">
          <div class="panel-heading"><div><p class="kicker">Human in the loop</p><h2>Approvals</h2></div></div>
          <form class="inline-form" onsubmit={(event) => { event.preventDefault(); recoveredApprovalId = recoveryInput.trim(); recoveryError = ""; automaticApprovalLookup = null; void load(); }}>
            <label for="recover-approval">Find an older Linear, Slack, or Notion approval by ID</label>
            <input id="recover-approval" bind:value={recoveryInput} maxlength="128" placeholder="Approval ID" />
            <button class="quiet compact" type="submit" disabled={Boolean(busy) || !recoveryInput.trim()}>Find approval</button>
            {#if recoveredApprovalId}<button class="quiet compact" type="button" disabled={Boolean(busy)}
              onclick={() => { recoveredApprovalId = ""; recoveryInput = ""; recoveryError = ""; automaticApprovalLookup = null; void load(); }}>Clear lookup</button>{/if}
          </form>
          {#if recoveryError}<p class="approval-context" role="status">{recoveryError}</p>{/if}
          {#each overview.approvals.filter((item) =>
            visibleApprovalCard(item, recoveredApprovalId, clockNow, !loading && !error)) as approval}
            <article class="approval-card">
              <div class="approval-top"><strong>{approval.action} ({approval.toolId})</strong><span>Expires {timestamp(approval.expiresAt)}</span></div>
              <p class="approval-context">Effect: {approval.effect} · Account: {overview.connections.find((connection) => connection.id === approval.connectionId)?.label ?? "Unavailable"}</p>
              {#if approval.resources.length}<p class="approval-context">Resources: {approval.resources.map((resource) => resource.parameter ? `${resource.kind} (${resource.parameter})` : resource.kind).join(", ")}</p>{/if}
              {#if !approval.manifestCurrent}<p class="approval-context">This tool changed. Request a new approval.</p>{/if}
              {#if !approval.previewReady}<p class="approval-context">A complete, safely redacted preview is unavailable. Request a new approval after this tool has review metadata.</p>{/if}
              {#if approval.previewMode === "opaque"}<p class="approval-context">This action has no field review metadata. All arguments are hidden; review the action and account before approving.</p>{/if}
              <pre>{renderApprovalPreview(approval.params)}</pre>
              <div class="actions">
                {#if approval.status === "pending"}
                  <button class="primary compact" disabled={Boolean(busy) || Boolean(error) || loading || !approval.previewReady} onclick={() => void mutate(`approve:${approval.id}`, "/api/approvals/approve", { approvalId: approval.id }, `Approved ${approval.toolId}.`)}>Approve</button>
                  <button class="danger compact" disabled={Boolean(busy) || Boolean(error) || loading} onclick={() => void mutate(`reject:${approval.id}`, "/api/approvals/reject", { approvalId: approval.id }, `Rejected ${approval.toolId}.`)}>Reject</button>
                  {#if !approval.browserActionable}<p class="approval-context">After approval, execute this action from the originating CLI or MCP client.</p>{/if}
                {:else if approval.status === "uncertain"}
                  <p class="approval-context">The outcome is unknown. Check receipt {approval.executionReceiptId ?? "pending"} against the selected {approval.toolId.startsWith("slack.") ? "Slack workspace and channel" : approval.toolId.startsWith("notion.") ? "Notion page and title" : "Linear workspace and issue"} before recording a decision.</p>
                  {#if !approval.browserActionable}
                    <p class="approval-context">Record the verified outcome from the originating CLI or MCP client. This browser session cannot reconcile its grant.</p>
                  {:else}
                    <button class="quiet compact" disabled={Boolean(busy) || Boolean(error) || loading || !effectPresentAvailable(approval, overview.reconciliationReceipts)}
                        onclick={() => void reconcileProvider(approval.id, "effect_present")}>I verified the action happened</button>
                    {#if effectAbsentAvailable(approval, overview.reconciliationReceipts)}
                      <button class="danger compact" disabled={Boolean(busy) || Boolean(error) || loading}
                        onclick={() => void reconcileProvider(approval.id, "effect_absent")}>I verified the action did not happen</button>
                    {:else}
                      <p class="approval-context">The request may still be running. OMR cannot safely record no change or allow a retry for this receipt.</p>
                    {/if}
                  {/if}
                {:else if approval.reconciledAs}
                  <p class="approval-context">Recorded decision for receipt {approval.executionReceiptId}: {approval.reconciledAs === "effect_present" ? "action happened" : "action did not happen"}. No provider write was repeated.</p>
                {:else if approval.status === "approved"}
                  {#if approval.browserActionable}
                    <button class="primary compact" disabled={Boolean(busy) || Boolean(error) || loading || !approval.previewReady} onclick={() => void mutate(`execute:${approval.id}`, "/api/approvals/execute", { approvalId: approval.id }, `Executed ${approval.toolId}.`)}>Execute approved change</button>
                  {:else}
                    <p class="approval-context">Execute this approved action from the originating CLI or MCP client. This browser session cannot use its grant.</p>
                  {/if}
                {:else if approval.status === "executing"}
                  <p class="approval-context">Execution is in progress. Check this approval and its receipt before taking another action.</p>
                {:else}
                  <p class="approval-context">This approval is {approval.status} and cannot be executed again.</p>
                {/if}
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
                  <span class:ready={execution.status === "succeeded"} class:error-dot={execution.status === "failed" || execution.status === "uncertain"} class="dot"></span>
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
  .approval-card pre { max-height: none; overflow-wrap: anywhere; }
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
