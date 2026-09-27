import type { Client } from "pg";
import { ConnectionAccessDeniedError, ConnectionUnavailableError } from "@oh-my-router/connections";

import {
  ExecutionCapabilityDeniedError,
  EXECUTION_INVOCATION_DEADLINE_MS,
  ExecutionInvocationDeadlineError,
  type ExecutionInvocationGuard,
} from "./execution.js";

function expirationTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.NaN;
}

function isStatementTimeout(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "57014" &&
    /statement timeout/i.test(error.message);
}

type GuardInput = Parameters<ExecutionInvocationGuard["run"]>[0];
type IdentityInput = Pick<GuardInput, "principal" | "capability" | "deadlineAt">;
type GuardQuery = <R extends Record<string, unknown>>(
  sql: string, values?: unknown[],
) => Promise<{ rows: R[] }>;

async function authorizeBinding(input: GuardInput, query: GuardQuery): Promise<void> {
  const binding = await query<{
    workspace_id: string;
    provider_connection_id: string;
    ownership: "personal" | "workspace";
    owner_user_id: string | null;
    status: string;
    readiness: string;
  }>(
    `SELECT workspace_id, provider_connection_id, ownership, owner_user_id, status, readiness
     FROM omr_control.connection_bindings WHERE id = $1 FOR SHARE`,
    [input.connection.id],
  );
  const current = binding.rows[0];
  if (current?.workspace_id !== input.principal.workspaceId ||
      current.provider_connection_id !== input.connection.providerConnectionId ||
      (current.ownership === "personal" && current.owner_user_id !== input.principal.userId)) {
    throw new ConnectionAccessDeniedError();
  }
  if (current.status !== "active" || current.readiness !== "ready") {
    throw new ConnectionUnavailableError();
  }
}

async function authorizeWeb(input: Extract<GuardInput["principal"], { kind: "web" }>,
  query: GuardQuery): Promise<number> {
  if (!input.sessionId) throw new ConnectionAccessDeniedError();
  const session = await query<{ expires_at: Date | string }>(
    `SELECT id, expires_at FROM omr_identity.sessions
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       AND expires_at > clock_timestamp() FOR SHARE`,
    [input.sessionId, input.userId],
  );
  const expiresAt = expirationTime(session.rows[0]?.expires_at);
  if (!Number.isFinite(expiresAt)) throw new ConnectionAccessDeniedError();
  return expiresAt;
}

async function authorizeClient(input: Extract<GuardInput["principal"], { kind: "client" }>,
  capability: GuardInput["capability"], query: GuardQuery): Promise<number> {
  const client = await query<{ workspace_id: string; revoked_at: string | null }>(
    `SELECT workspace_id, revoked_at FROM omr_control.clients WHERE id = $1 FOR SHARE`,
    [input.clientId],
  );
  if (client.rows[0]?.workspace_id !== input.workspaceId || client.rows[0].revoked_at !== null) {
    throw new ConnectionAccessDeniedError();
  }
  const grant = await query<{
    client_id: string;
    workspace_id: string;
    user_id: string;
    capabilities: string[];
    revoked_at: string | null;
    expires_at: Date | string;
  }>(
    `SELECT client_id, workspace_id, user_id, capabilities, revoked_at, expires_at
     FROM omr_control.client_grants WHERE id = $1 FOR SHARE`,
    [input.grantId],
  );
  const current = grant.rows[0];
  const expiresAt = expirationTime(current?.expires_at);
  if (current?.client_id !== input.clientId || current.workspace_id !== input.workspaceId ||
      current.user_id !== input.userId || current.revoked_at !== null || expiresAt <= Date.now()) {
    throw new ConnectionAccessDeniedError();
  }
  if (!Number.isFinite(expiresAt)) throw new ConnectionAccessDeniedError();
  if (!current.capabilities.includes(capability)) throw new ExecutionCapabilityDeniedError(capability);
  return expiresAt;
}

async function authorizeInvocation(input: GuardInput | IdentityInput, query: GuardQuery): Promise<number> {
  if ("connection" in input) await authorizeBinding(input, query);
  const membership = await query(
    `SELECT id FROM omr_control.workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
    [input.principal.workspaceId, input.principal.userId],
  );
  if (!membership.rows[0]) throw new ConnectionAccessDeniedError();
  return input.principal.kind === "web"
    ? authorizeWeb(input.principal, query)
    : authorizeClient(input.principal, input.capability, query);
}

export { ExecutionInvocationDeadlineError } from "./execution.js";

/** Serialize an invocation with membership, client/grant, and binding revocation. */
export class PostgresExecutionInvocationGuard implements ExecutionInvocationGuard {
  constructor(private readonly client: Client, private readonly deadlineMs = EXECUTION_INVOCATION_DEADLINE_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("Invalid invocation deadline");
  }

  async run<T>(input: Parameters<ExecutionInvocationGuard["run"]>[0],
    invoke: (assertCanDispatch: () => void) => Promise<T>): Promise<T> {
    return this.runAuthorized(input, invoke);
  }

  async runIdentity<T>(input: IdentityInput, invoke: () => Promise<T>): Promise<T> {
    return this.runAuthorized(input, invoke);
  }

  private async runAuthorized<T>(input: GuardInput | IdentityInput,
    invoke: (assertCanDispatch: () => void) => Promise<T>): Promise<T> {
    const deadline = Math.min(input.deadlineAt ?? Infinity, Date.now() + this.deadlineMs);
    const controller = new AbortController();
    let clientClosed = false;
    const closeClient = () => {
      if (clientClosed) return;
      clientClosed = true;
      // pg.end() destroys an active non-pipelined query's socket. PostgreSQL then
      // rolls back this request's transaction; a queued ROLLBACK cannot do that.
      void this.client.end().catch(() => undefined);
    };
    let credentialExpiresAt = Infinity;
    const assertCanDispatch = () => {
      if (controller.signal.aborted || Date.now() >= deadline) throw new ExecutionInvocationDeadlineError();
      if (Date.now() >= credentialExpiresAt) throw new ConnectionAccessDeniedError();
    };
    const withinDeadline = async <R>(operation: () => Promise<R>): Promise<R> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || controller.signal.aborted) throw new ExecutionInvocationDeadlineError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              closeClient();
              reject(new ExecutionInvocationDeadlineError());
            }, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const queryWithinDeadline = async <R extends Record<string, unknown>>(
      sql: string, values?: unknown[],
    ) => {
      // A statement begun near the invocation deadline must not inherit a new
      // 60-second server timeout. Refresh it before each authorization query.
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ExecutionInvocationDeadlineError();
      await withinDeadline(() => this.client.query(
        "SELECT set_config('statement_timeout', $1, true)", [`${remaining}ms`],
      ));
      return withinDeadline(() => this.client.query<R>(sql, values));
    };
    try {
      await withinDeadline(() => this.client.query("BEGIN"));
      // PostgreSQL releases row locks even if the worker stops while awaiting a provider.
      await withinDeadline(() => this.client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [`${Math.max(1, deadline - Date.now())}ms`, `${this.deadlineMs + 5_000}ms`],
      ));
      credentialExpiresAt = await authorizeInvocation(input, queryWithinDeadline);
      assertCanDispatch();
      const result = await withinDeadline(() => invoke(assertCanDispatch));
      await queryWithinDeadline("COMMIT");
      return result;
    } catch (error) {
      controller.abort();
      if (!clientClosed) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          closeClient();
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.client.query("ROLLBACK").catch(() => undefined),
              new Promise<void>((resolve) => { timer = setTimeout(() => { closeClient(); resolve(); }, remaining); }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      throw isStatementTimeout(error) ? new ExecutionInvocationDeadlineError() : error;
    }
  }
}
