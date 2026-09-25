import { MemoryAdapter, plugFn } from "plugfn";
import { githubProvider, linearProvider, notionProvider, slackProvider } from "@plugfn/providers";
import { createPlugFnToolCatalog, v1ProviderCatalog } from "@oh-my-router/tools";

// Credential-free reference response: registered adapters, no OAuth configuration or bindings.
const runtime = plugFn({
  database: new MemoryAdapter(),
  auth: {},
  baseUrl: "https://omr.local",
  encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  integrations: {},
});
for (const provider of [githubProvider, linearProvider, slackProvider, notionProvider]) {
  runtime.use(provider);
}
await runtime.ready;
const providers = v1ProviderCatalog({
  get: (provider) => runtime.providers.get(provider),
  configured: () => false,
});
const catalog = await createPlugFnToolCatalog(runtime, new Set());
console.log(JSON.stringify({ ...catalog.discover(), providers }, null, 2));
