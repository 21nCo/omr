import type { Client } from "pg";
import { ConnectionAccessDeniedError, ConnectionUnavailableError } from "@oh-my-router/connections";

import {
  ExecutionCapabilityDeniedError,
  EXECUTION_INVOCATION_DEADLINE_MS,
  type ExecutionInvocationGuard,
} from "./execution.js";

function expirationTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return NaN;
}

function isStatementTimeout(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "57014" &&
    /statement timeout/i.test(error.message);
}

export class ExecutionInvocationDeadlineError extends Error {
  readonly code = "EXECUTION_INVOCATION_TIMEOUT";
  constructor() {
    super("The invocation deadline expired");
    this.name = "ExecutionInvocationDeadlineError";
  }
}

/** Serialize an invocation with membership, client/grant, and binding revocation. */
export class PostgresExecutionInvocationGuard implements ExecutionInvocationGuard {
  constructor(private readonly client: Client, private readonly deadlineMs = EXECUTION_INVOCATION_DEADLINE_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("Invalid invocation deadline");
  }

  async run<T>(input: Parameters<ExecutionInvocationGuard["run"]>[0],
    invoke: (assertCanDispatch: () => void) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.deadlineMs;
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
      const binding = await queryWithinDeadline<{
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
      if (!current || current.workspace_id !== input.principal.workspaceId ||
          current.provider_connection_id !== input.connection.providerConnectionId ||
          (current.ownership === "personal" && current.owner_user_id !== input.principal.userId)) {
        throw new ConnectionAccessDeniedError();
      }
      if (current.status !== "active" || current.readiness !== "ready") {
        throw new ConnectionUnavailableError();
      }

      const membership = await queryWithinDeadline(
        `SELECT id FROM omr_control.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
        [input.principal.workspaceId, input.principal.userId],
      );
      if (!membership.rows[0]) throw new ConnectionAccessDeniedError();

      if (input.principal.kind === "web") {
        const { sessionId } = input.principal;
        if (!sessionId) throw new ConnectionAccessDeniedError();
        const session = await queryWithinDeadline<{ expires_at: Date | string }>(
          `SELECT id, expires_at FROM omr_identity.sessions
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
             AND expires_at > clock_timestamp() FOR SHARE`,
          [sessionId, input.principal.userId],
        );
        if (!session.rows[0]) throw new ConnectionAccessDeniedError();
        credentialExpiresAt = expirationTime(session.rows[0].expires_at);
        if (!Number.isFinite(credentialExpiresAt)) throw new ConnectionAccessDeniedError();
      } else {
        const { clientId, grantId } = input.principal;
        const client = await queryWithinDeadline<{ workspace_id: string; revoked_at: string | null }>(
          `SELECT workspace_id, revoked_at FROM omr_control.clients WHERE id = $1 FOR SHARE`,
          [clientId],
        );
        if (!client.rows[0] || client.rows[0].workspace_id !== input.principal.workspaceId ||
            client.rows[0].revoked_at !== null) throw new ConnectionAccessDeniedError();
        const grant = await queryWithinDeadline<{
          client_id: string;
          workspace_id: string;
          user_id: string;
          capabilities: string[];
          revoked_at: string | null;
          expires_at: Date | string;
        }>(
          `SELECT client_id, workspace_id, user_id, capabilities, revoked_at, expires_at
           FROM omr_control.client_grants WHERE id = $1 FOR SHARE`,
          [grantId],
        );
        const currentGrant = grant.rows[0];
        if (!currentGrant || currentGrant.client_id !== input.principal.clientId ||
            currentGrant.workspace_id !== input.principal.workspaceId ||
            currentGrant.user_id !== input.principal.userId || currentGrant.revoked_at !== null ||
            expirationTime(currentGrant.expires_at) <= Date.now()) throw new ConnectionAccessDeniedError();
        credentialExpiresAt = expirationTime(currentGrant.expires_at);
        if (!Number.isFinite(credentialExpiresAt)) throw new ConnectionAccessDeniedError();
        if (!currentGrant.capabilities.includes(input.capability)) {
          throw new ExecutionCapabilityDeniedError(input.capability);
        }
      }
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
