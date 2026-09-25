<svelte:head>
  <title>OMR</title>
  <meta
    name="description"
    content="A portable tool integration layer for people, teams, and their agents."
  />
</svelte:head>

<main>
  <p class="eyebrow">Oh My Router</p>
  <h1>One connection layer.<br />Every trusted client.</h1>
  <p class="lede">
    Connect accounts once, then use their authorized tools from the terminal or any MCP-compatible
    agent. Test connections in the web control plane.
  </p>
  <nav>
    <a class="primary" href="/app">Open control plane</a>
    <a class="secondary" href="/login">Sign in</a>
    <a class="health" href="/api/health">Runtime health</a>
  </nav>
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    color: #f5f5f0;
    background: #10110f;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }

  main {
    display: grid;
    align-content: center;
    min-height: 100vh;
    max-width: 72rem;
    padding: clamp(2rem, 8vw, 8rem);
  }

  .eyebrow {
    color: #b7d76a;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h1 {
    max-width: 14ch;
    margin: 0.5rem 0 1.5rem;
    font-size: clamp(3rem, 8vw, 7rem);
    font-weight: 520;
    letter-spacing: -0.06em;
    line-height: 0.92;
  }

  .lede {
    max-width: 42rem;
    color: #b9bcb2;
    font-size: clamp(1.1rem, 2vw, 1.4rem);
    line-height: 1.5;
  }

  nav { display: flex; flex-wrap: wrap; gap: 0.7rem; margin-top: 1.5rem; }
  a {
    width: fit-content;
    border-radius: 999px;
    padding: 0.8rem 1.1rem;
    font-weight: 700;
    text-decoration: none;
  }
  .primary { color: #10110f; background: #b7d76a; }
  .secondary { color: #f5f5f0; border: 1px solid #4a4e44; }
  .health { color: #b9bcb2; }

  a:focus-visible {
    outline: 3px solid #fff;
    outline-offset: 3px;
  }
</style>
