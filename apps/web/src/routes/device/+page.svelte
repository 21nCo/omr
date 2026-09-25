<script lang="ts">
  import { onMount } from "svelte";

  type WorkspaceAccess = {
    workspace: { id: string; name: string; kind: "personal" | "team" };
    membership: { role: string };
  };

  let userCode = "";
  let workspaceId = "";
  let workspaces: WorkspaceAccess[] = [];
  let authenticated = true;
  let loading = true;
  let returnTo = "/device";
  let submitting = false;
  let message = "";
  let failed = false;

  onMount(async () => {
    returnTo = `${location.pathname}${location.search}`;
    userCode = new URLSearchParams(location.search).get("user_code") ?? "";
    try {
      const response = await fetch("/api/control-plane", { credentials: "same-origin" });
      if (response.status === 401) {
        authenticated = false;
        return;
      }
      const body = await response.json() as {
        workspaces?: WorkspaceAccess[];
        selectedWorkspaceId?: string | null;
      };
      if (!response.ok) throw new Error("Could not load your workspaces");
      workspaces = body.workspaces ?? [];
      workspaceId = body.selectedWorkspaceId ?? workspaces[0]?.workspace.id ?? "";
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : "Could not load your workspaces";
    } finally {
      loading = false;
    }
  });

  async function approve() {
    submitting = true;
    failed = false;
    message = "";
    try {
      const response = await fetch("/api/device/approve", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode, workspaceId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Approval failed");
      message = "Client approved. You can return to the terminal.";
      userCode = "";
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : "Approval failed";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Approve device · OMR</title>
  <meta name="description" content="Approve a trusted OMR CLI or MCP client." />
</svelte:head>

<main>
  <section aria-labelledby="device-title">
    <p class="eyebrow">Oh My Router</p>
    <h1 id="device-title">Approve a device</h1>
    <p class="lede">Confirm the code shown by your OMR client, then choose exactly which workspace it may access.</p>

    {#if !authenticated}
      <div class="auth-callout">
        <strong>Sign in before approving this client.</strong>
        <a href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Continue to sign in</a>
      </div>
    {:else if loading}
      <p class="loading">Loading your workspaces…</p>
    {:else}
    <form onsubmit={(event) => { event.preventDefault(); void approve(); }}>
      <label for="user-code">Device code</label>
      <input
        id="user-code"
        bind:value={userCode}
        autocomplete="one-time-code"
        placeholder="ABCD-EFGH"
        required
      />

      <label for="workspace-id">Workspace</label>
      <select id="workspace-id" bind:value={workspaceId} required>
        {#each workspaces as access}
          <option value={access.workspace.id}>{access.workspace.name} · {access.membership.role}</option>
        {/each}
      </select>

      <button type="submit" disabled={submitting}>
        {submitting ? "Approving…" : "Approve client"}
      </button>
    </form>
    {/if}

    {#if message}
      <p class:error={failed} role={failed ? "alert" : "status"}>{message}</p>
    {/if}
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    color: #f5f5f0;
    background: #10110f;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  main {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 2rem;
  }
  section { width: min(100%, 32rem); }
  .eyebrow {
    color: #b7d76a;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  h1 { margin: 0.4rem 0 0.8rem; font-size: clamp(2.4rem, 8vw, 4.5rem); letter-spacing: -0.05em; }
  .lede { color: #b9bcb2; line-height: 1.5; }
  form { display: grid; gap: 0.65rem; margin-top: 2rem; }
  label { margin-top: 0.7rem; font-size: 0.9rem; font-weight: 700; }
  input, select, button {
    border: 1px solid #41443d;
    border-radius: 0.7rem;
    padding: 0.9rem 1rem;
    font: inherit;
  }
  input, select { color: inherit; background: #191a17; }
  button {
    margin-top: 1rem;
    border-color: #b7d76a;
    color: #10110f;
    background: #b7d76a;
    font-weight: 750;
    cursor: pointer;
  }
  button:disabled { cursor: wait; opacity: 0.65; }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
  .error { color: #ff9c8f; }
  .loading { color: #b9bcb2; }
  .auth-callout { display: grid; gap: 1rem; margin-top: 2rem; padding: 1rem; border: 1px solid #41443d; border-radius: 0.75rem; background: #191a17; }
  .auth-callout a { width: fit-content; color: #10110f; background: #b7d76a; border-radius: 0.6rem; padding: 0.7rem 0.9rem; font-weight: 800; text-decoration: none; }
</style>
