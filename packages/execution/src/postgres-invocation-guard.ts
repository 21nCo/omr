import type { Client } from "pg";
import { ConnectionAccessDeniedError, ConnectionUnavailableError } from "@oh-my-router/connections";

import {
  ExecutionCapabilityDeniedError,
  type ExecutionInvocationGuard,
} from "./execution.js";

const DEFAULT_INVOCATION_DEADLINE_MS = 60_000;

export class ExecutionInvocationDeadlineError extends Error {
  readonly code = "EXECUTION_INVOCATION_TIMEOUT";
  constructor() {
    super("The invocation deadline expired");
    this.name = "ExecutionInvocationDeadlineError";
  }
}

/** Serialize an invocation with membership, client/grant, and binding revocation. */
export class PostgresExecutionInvocationGuard implements ExecutionInvocationGuard {
  constructor(private readonly client: Client, private readonly deadlineMs = DEFAULT_INVOCATION_DEADLINE_MS) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("Invalid invocation deadline");
  }

  async run<T>(input: Parameters<ExecutionInvocationGuard["run"]>[0], invoke: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.deadlineMs;
    const withinDeadline = async <R>(operation: Promise<R>): Promise<R> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ExecutionInvocationDeadlineError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ExecutionInvocationDeadlineError()), remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      await withinDeadline(this.client.query("BEGIN"));
      // PostgreSQL releases row locks even if the worker stops while awaiting a provider.
      await withinDeadline(this.client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [`${this.deadlineMs}ms`, `${this.deadlineMs + 5_000}ms`],
      ));
      const binding = await withinDeadline(this.client.query<{
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
      ));
      const current = binding.rows[0];
      if (!current || current.workspace_id !== input.principal.workspaceId ||
          current.provider_connection_id !== input.connection.providerConnectionId ||
          (current.ownership === "personal" && current.owner_user_id !== input.principal.userId)) {
        throw new ConnectionAccessDeniedError();
      }
      if (current.status !== "active" || current.readiness !== "ready") {
        throw new ConnectionUnavailableError();
      }

      const membership = await withinDeadline(this.client.query(
        `SELECT id FROM omr_control.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 FOR SHARE`,
        [input.principal.workspaceId, input.principal.userId],
      ));
      if (!membership.rows[0]) throw new ConnectionAccessDeniedError();

      if (input.principal.kind === "web") {
        if (!input.principal.sessionId) throw new ConnectionAccessDeniedError();
        const session = await withinDeadline(this.client.query(
          `SELECT id FROM omr_identity.sessions
           WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
             AND expires_at > clock_timestamp() FOR SHARE`,
          [input.principal.sessionId, input.principal.userId],
        ));
        if (!session.rows[0]) throw new ConnectionAccessDeniedError();
      } else {
        const client = await withinDeadline(this.client.query<{ workspace_id: string; revoked_at: string | null }>(
          `SELECT workspace_id, revoked_at FROM omr_control.clients WHERE id = $1 FOR SHARE`,
          [input.principal.clientId],
        ));
        if (!client.rows[0] || client.rows[0].workspace_id !== input.principal.workspaceId ||
            client.rows[0].revoked_at !== null) throw new ConnectionAccessDeniedError();
        const grant = await withinDeadline(this.client.query<{
          client_id: string;
          workspace_id: string;
          user_id: string;
          capabilities: string[];
          revoked_at: string | null;
          expires_at: string;
        }>(
          `SELECT client_id, workspace_id, user_id, capabilities, revoked_at, expires_at
           FROM omr_control.client_grants WHERE id = $1 FOR SHARE`,
          [input.principal.grantId],
        ));
        const currentGrant = grant.rows[0];
        if (!currentGrant || currentGrant.client_id !== input.principal.clientId ||
            currentGrant.workspace_id !== input.principal.workspaceId ||
            currentGrant.user_id !== input.principal.userId || currentGrant.revoked_at !== null ||
            Number(currentGrant.expires_at) <= Date.now()) throw new ConnectionAccessDeniedError();
        if (!currentGrant.capabilities.includes(input.capability)) {
          throw new ExecutionCapabilityDeniedError(input.capability);
        }
      }
      if (Date.now() >= deadline) throw new ExecutionInvocationDeadlineError();
      const result = await withinDeadline(invoke());
      await withinDeadline(this.client.query("COMMIT"));
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
