import type { RequestEvent } from "@sveltejs/kit";
import { Cabidela } from "@cloudflare/cabidela";
import type { McpFnSchemaCompiler } from "@mcpfn/core";
import {
  ClientCapabilityDeniedError,
  InvalidClientCredentialError,
} from "@oh-my-router/client-access";
import { connectPostgresClientAccess } from "@oh-my-router/client-access/postgres";
import { createOMRMcpServer } from "@oh-my-router/mcp";

import { createCloudflareRouteServices, databaseConnectionString } from "./cloudflare-runtime.js";
import { createOMRRouter } from "./router.js";

const MAX_MCP_BODY_BYTES = 64 * 1024;

const compileWorkerSchema: McpFnSchemaCompiler = (schema) => {
  const validator = new Cabidela(schema);
  const validate = ((data: unknown) => {
    try {
      validator.validate(data);
      validate.errors = null;
      return true;
    } catch (error) {
      validate.errors = [{
        keyword: "validation",
        message: error instanceof Error ? error.message : "Schema validation failed",
      }];
      return false;
    }
  }) as ReturnType<McpFnSchemaCompiler>;
  return validate;
};

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unauthorized(): Response {
  return Response.json({ error: "MCP_CREDENTIAL_INVALID" }, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="OMR MCP"',
    },
  });
}

async function boundedRequest(request: Request): Promise<Request | null> {
  if (request.method !== "POST") return request;
  if (Number(request.headers.get("content-length")) > MAX_MCP_BODY_BYTES) return null;
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MCP_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

export async function handleRemoteMcp(event: RequestEvent): Promise<Response> {
  const request = event.request;
  const origin = new URL(request.url).origin;
  if (request.headers.has("origin") && request.headers.get("origin") !== origin) {
    return Response.json({ error: "MCP_ORIGIN_DENIED" }, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  const credential = /^Bearer (omr_[a-f0-9]{64})$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!credential) return unauthorized();

  try {
    const access = await connectPostgresClientAccess({
      connectionString: databaseConnectionString(event),
    });
    let workspaceId: string;
    try {
      const principal = await access.clients.authenticate(credential, "tools:discover");
      if (principal.kind !== "mcp_remote") {
        return Response.json({ error: "MCP_CLIENT_KIND_DENIED" }, {
          status: 403,
          headers: { "cache-control": "no-store" },
        });
      }
      workspaceId = principal.workspaceId;
    } finally {
      await access.close();
    }

    const bounded = await boundedRequest(request);
    if (!bounded) {
      return Response.json({ error: "MCP_BODY_TOO_LARGE" }, {
        status: 413,
        headers: { "cache-control": "no-store" },
      });
    }
    const services = createCloudflareRouteServices(event);
    const router = createOMRRouter(
      services.device,
      services.connections,
      services.tools,
      services.execution,
      services.controlPlane,
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const internalRequest = new Request(input, init);
      const url = new URL(internalRequest.url);
      if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
        throw new Error("MCP internal API request escaped the OMR router");
      }
      return router.handle(internalRequest);
    };
    const server = await createOMRMcpServer({
      baseUrl: origin,
      credential,
      workspaceId,
      fetchImpl,
      schemaCompiler: compileWorkerSchema,
    });
    const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
    return noStore(await handler(bounded));
  } catch (error) {
    if (error instanceof InvalidClientCredentialError) return unauthorized();
    if (error instanceof ClientCapabilityDeniedError) {
      return Response.json({ error: error.code, capability: error.capability }, {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
    console.error(JSON.stringify({
      service: "omr-mcp",
      event: "request_failed",
      error: error instanceof Error ? error.name : "UnknownError",
    }));
    return Response.json({ error: "MCP_UNAVAILABLE" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
