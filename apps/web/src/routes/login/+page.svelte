<script lang="ts">
  import { onMount } from "svelte";

  type AuthEnvelope = {
    ok: boolean;
    error?: { code?: string; message?: string };
  };

  let mode: "sign-in" | "sign-up" = "sign-in";
  let email = "";
  let password = "";
  let submitting = false;
  let message = "";

  function destination(): string {
    const candidate = new URLSearchParams(location.search).get("returnTo");
    return candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : "/app";
  }

  onMount(async () => {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!response.ok) return;
    const body = await response.json() as { data?: { session?: unknown } };
    if (body.data?.session) location.replace(destination());
  });

  async function submit() {
    submitting = true;
    message = "";
    try {
      const path = mode === "sign-in" ? "sign-in" : "sign-up";
      const response = await fetch(`/api/auth/${path}/password`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json() as AuthEnvelope;
      if (!response.ok || !body.ok) {
        throw new Error(body.error?.message ?? body.error?.code ?? "Authentication failed");
      }
      location.assign(destination());
    } catch (error) {
      message = error instanceof Error ? error.message : "Authentication failed";
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>{mode === "sign-in" ? "Sign in" : "Create account"} · OMR</title>
  <meta name="description" content="Sign in to your OMR control plane." />
</svelte:head>

<main>
  <a class="brand" href="/" aria-label="Oh My Router home">
    <span>OMR</span>
    <small>Oh My Router</small>
  </a>

  <section aria-labelledby="auth-title">
    <p class="eyebrow">Secure control plane</p>
    <h1 id="auth-title">{mode === "sign-in" ? "Welcome back." : "Create your account."}</h1>
    <p class="lede">
      {mode === "sign-in"
        ? "Manage connections, approve agent actions, and review execution history."
        : "Your personal workspace is created automatically."}
    </p>

    <div class="tabs" aria-label="Authentication mode">
      <button class:active={mode === "sign-in"} onclick={() => { mode = "sign-in"; message = ""; }}>
        Sign in
      </button>
      <button class:active={mode === "sign-up"} onclick={() => { mode = "sign-up"; message = ""; }}>
        Create account
      </button>
    </div>

    <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label for="email">Email</label>
      <input id="email" type="email" bind:value={email} autocomplete="email" required />

      <label for="password">Password</label>
      <input
        id="password"
        type="password"
        bind:value={password}
        autocomplete={mode === "sign-in" ? "current-password" : "new-password"}
        minlength="12"
        required
      />
      {#if mode === "sign-up"}<small class="hint">Use at least 12 characters.</small>{/if}

      <button class="primary" type="submit" disabled={submitting}>
        {submitting ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
    </form>

    {#if message}<p class="error" role="alert">{message}</p>{/if}
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    color: #f6f5ee;
    background:
      radial-gradient(circle at 15% 15%, rgba(183, 215, 106, 0.12), transparent 30rem),
      #10110f;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  main { min-height: 100vh; padding: clamp(1.5rem, 4vw, 3rem); }
  .brand { display: inline-flex; align-items: center; gap: 0.8rem; color: inherit; text-decoration: none; }
  .brand span { display: grid; width: 2.8rem; height: 2.8rem; place-items: center; border-radius: 0.8rem; color: #10110f; background: #b7d76a; font-weight: 900; }
  .brand small { color: #aeb2a6; font-weight: 700; letter-spacing: 0.03em; }
  section { width: min(100%, 32rem); margin: clamp(4rem, 10vh, 8rem) auto 0; }
  .eyebrow { color: #b7d76a; font-size: 0.78rem; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; }
  h1 { margin: 0.5rem 0 0.8rem; font-size: clamp(2.7rem, 7vw, 4.5rem); letter-spacing: -0.055em; line-height: 0.95; }
  .lede { color: #aeb2a6; line-height: 1.55; }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; margin: 2rem 0 1.25rem; padding: 0.3rem; border: 1px solid #30332d; border-radius: 0.9rem; background: #171815; }
  .tabs button { border: 0; border-radius: 0.65rem; padding: 0.7rem; color: #aeb2a6; background: transparent; font: inherit; font-weight: 700; cursor: pointer; }
  .tabs button.active { color: #f6f5ee; background: #292c26; }
  form { display: grid; gap: 0.6rem; }
  label { margin-top: 0.7rem; font-size: 0.86rem; font-weight: 750; }
  input { width: 100%; border: 1px solid #3b3f37; border-radius: 0.75rem; padding: 0.9rem 1rem; color: inherit; background: #191a17; font: inherit; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid #d9efa4; outline-offset: 2px; }
  .hint { color: #777d70; }
  .primary { margin-top: 1rem; border: 0; border-radius: 0.75rem; padding: 0.95rem 1rem; color: #10110f; background: #b7d76a; font: inherit; font-weight: 850; cursor: pointer; }
  .primary:disabled { cursor: wait; opacity: 0.65; }
  .error { color: #ff9c8f; line-height: 1.5; }
</style>
