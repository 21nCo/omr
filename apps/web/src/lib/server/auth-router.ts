import type { RequestEvent } from "@superfunctions/http-sveltekit";
import { connectPostgresIdentityRuntime } from "@oh-my-router/identity/postgres";

import { databaseConnectionString } from "./cloudflare-runtime.js";

export function toAuthFnRequest(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return request;
  url.pathname = url.pathname.slice(4);
  return new Request(url, request);
}

export async function handleCloudflareAuth(event: RequestEvent): Promise<Response> {
  const origin = new URL(event.request.url).origin;
  if (!["GET", "HEAD", "OPTIONS"].includes(event.request.method) &&
      event.request.headers.get("origin") !== origin) {
    return Response.json({ error: "AUTH_ORIGIN_DENIED" }, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  const runtime = await connectPostgresIdentityRuntime({
    connectionString: databaseConnectionString(event),
    environment: {
      resolve: () => ({ issuer: origin, baseUrl: origin }),
    },
  });
  try {
    return await runtime.auth.router.handle(toAuthFnRequest(event.request));
  } finally {
    await runtime.close();
  }
}
