import { afterEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";

import { controlDrizzleSchema, publicDrizzleSchema } from "./postgres-schema.js";
import { createOMRDataRuntime, type WorkspacePrincipal } from "./runtime.js";

const openServers: Array<Awaited<ReturnType<typeof createOMRDataRuntime>>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function createTestRuntime(
  authorize: (principal: WorkspacePrincipal) => boolean = () => true,
) {
  const server = await createOMRDataRuntime({
    database: memoryAdapter(),
    resolvePrincipal: (request) => ({
      workspaceId: request.headers.get("x-test-workspace") ?? "",
      actorId: request.headers.get("x-test-actor") ?? "",
    }),
    authorize,
  });
  openServers.push(server);
  return server;
}

function request(
  path: string,
  workspaceId: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`https://omr.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-workspace": workspaceId,
      "x-test-actor": `actor:${workspaceId}`,
    },
    body: JSON.stringify(body),
  });
}

async function insertProfile(
  server: Awaited<ReturnType<typeof createOMRDataRuntime>>,
  workspaceId: string,
  id: string,
  displayName: string,
) {
  return server.router.handle(
    request("/datafn/push", workspaceId, {
      clientId: `client:${workspaceId}`,
      mutations: [
        {
          resource: "workspace_profiles",
          version: 1,
          operation: "insert",
          id,
          clientId: `client:${workspaceId}`,
          mutationId: `mutation:${workspaceId}:${id}`,
          record: { displayName },
        },
      ],
    }),
  );
}

describe("OMR DataFn isolation", () => {
  it("keeps workspace records isolated through the DataFn namespace", async () => {
    const server = await createTestRuntime();

    expect((await insertProfile(server, "alpha", "profile:alpha", "Alpha")).status).toBe(200);
    expect((await insertProfile(server, "beta", "profile:beta", "Beta")).status).toBe(200);

    const alphaResponse = await server.router.handle(
      request("/datafn/query", "alpha", {
        resource: "workspace_profiles",
        version: 1,
        select: ["id", "displayName"],
      }),
    );
    expect(alphaResponse.status).toBe(200);
    const alphaBody = (await alphaResponse.json()) as {
      result: { data: Array<{ id: string; displayName: string }> };
    };
    expect(alphaBody.result.data).toEqual([
      { id: "profile:alpha", displayName: "Alpha" },
    ]);
  });

  it("fails closed when product authorization denies an action", async () => {
    const server = await createTestRuntime(() => false);
    const response = await insertProfile(server, "alpha", "profile:alpha", "Alpha");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("does not expose privileged control tables through the DataFn schema", async () => {
    const server = await createTestRuntime();
    const response = await server.router.handle(
      request("/datafn/query", "alpha", {
        resource: "workspace_memberships",
        version: 1,
        select: ["id"],
      }),
    );

    expect(response.status).not.toBe(200);
    expect(Object.keys(publicDrizzleSchema)).toEqual(["workspace_profiles", "kv"]);
    expect(Object.keys(controlDrizzleSchema)).toContain("workspace_memberships");
  });

  it("rejects missing workspace identity before database access", async () => {
    const server = await createTestRuntime();
    const response = await server.router.handle(
      new Request("https://omr.invalid/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "workspace_profiles",
          version: 1,
          select: ["id"],
        }),
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
