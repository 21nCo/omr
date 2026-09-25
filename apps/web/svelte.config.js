import adapter from "@sveltejs/adapter-cloudflare";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    adapter: adapter(),
    // OAuth token and registration requests are form-encoded machine-to-machine
    // POSTs and need not carry Origin. Browser-session mutations check it in
    // their own handlers instead.
    csrf: { checkOrigin: false },
  },
};

export default config;
