import {
  NotFoundError,
  type Adapter,
  type AdapterCapabilities,
  type CountParams,
  type CreateManyParams,
  type CreateParams,
  type DeleteManyParams,
  type DeleteParams,
  type FindManyParams,
  type FindOneParams,
  type HealthStatus,
  type InternalCrud,
  type OrderBy,
  type TableSchema,
  type TransactionAdapter,
  type TransactionIsolation,
  type UpdateManyParams,
  type UpdateParams,
  type UpsertParams,
  type ValidationResult,
  type WhereClause,
} from "@superfunctions/db";
import type { Client } from "pg";

interface InternalWhereClause {
  field: string;
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in";
  value: unknown;
}

const capabilities: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: true, uuid: true, enum: false },
  operations: {
    batch: true,
    upsert: true,
    streaming: false,
    fulltext: false,
    returning: true,
    strictUpdateNotFound: true,
  },
  transactions: {
    supported: true,
    nested: false,
    isolation: ["read_committed", "repeatable_read", "serializable"],
    configurableIsolation: true,
  },
  performance: {
    maxBatchSize: 1_000,
    supportsJoins: false,
    supportsPreparedStatements: true,
  },
  schema: { migrations: true, constraints: false, indexes: true },
  advanced: {
    customIdGeneration: true,
    numericIds: false,
    schemaNamespaces: true,
    customTypes: false,
  },
};

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

function namespace(value?: string): string {
  return value ?? "plugfn";
}

function selected<T>(record: Record<string, unknown>, select?: string[]): T {
  if (!select) return structuredClone(record) as T;
  return Object.fromEntries(select.map((field) => [field, record[field]])) as T;
}

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\!%_]/g, "!$&");
}

function whereSql(
  clauses: readonly (WhereClause | InternalWhereClause)[] | undefined,
  values: unknown[],
): string {
  if (!clauses?.length) return "TRUE";
  let expression = "";
  clauses.forEach((clause, index) => {
    const fieldIndex = values.push(clause.field);
    const operator = "operator" in clause ? clause.operator : clause.op;
    let part: string;
    if ((operator === "eq" || operator === "ne") && clause.value === null) {
      const equality = `(NOT (data ? $${fieldIndex}::text) OR data -> $${fieldIndex}::text = 'null'::jsonb)`;
      part = operator === "eq" ? equality : `NOT ${equality}`;
    } else if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
      const source = escapeLike(String(clause.value));
      const pattern = operator === "contains" ? `%${source}%` : operator === "starts_with" ? `${source}%` : `%${source}`;
      const valueIndex = values.push(pattern);
      part = `data ->> $${fieldIndex}::text LIKE $${valueIndex}::text ESCAPE '!'`;
    } else if (operator === "in" || operator === "not_in") {
      const candidates: unknown[] = Array.isArray(clause.value) ? clause.value : [clause.value];
      if (candidates.length === 0) {
        part = operator === "in" ? "FALSE" : "TRUE";
      } else {
        const comparisons = candidates.map((candidate) => {
          const valueIndex = values.push(json(candidate));
          return `data -> $${fieldIndex}::text = $${valueIndex}::jsonb`;
        });
        part = `${operator === "not_in" ? "NOT " : ""}(${comparisons.join(" OR ")})`;
      }
    } else {
      const valueIndex = values.push(json(clause.value));
      const sqlOperators: Record<string, string> = {
        eq: "=",
        ne: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      const sqlOperator = sqlOperators[operator];
      if (!sqlOperator) throw new Error(`Unsupported database operator: ${operator}`);
      part = `data -> $${fieldIndex}::text ${sqlOperator} $${valueIndex}::jsonb`;
    }
    if (index === 0) expression = `(${part})`;
    else {
      const connector = "connector" in clause ? clause.connector ?? "AND" : "AND";
      expression = `(${expression} ${connector} (${part}))`;
    }
  });
  return expression;
}

function orderSql(orderBy: readonly OrderBy[] | undefined, values: unknown[]): string {
  if (!orderBy?.length) return "";
  return ` ORDER BY ${orderBy.map((order) => {
    const fieldIndex = values.push(order.field);
    return `data -> $${fieldIndex}::text ${order.direction.toUpperCase()}`;
  }).join(", ")}`;
}

function assertWhere(where: readonly unknown[], operation: string): void {
  if (where.length === 0) throw new Error(`${operation} requires a non-empty where clause`);
}

function physicalId(data: Record<string, unknown>): string {
  return typeof data.id === "string" && data.id.length > 0 ? data.id : crypto.randomUUID();
}

function isolationSql(value: TransactionIsolation): string {
  if (value === "read_uncommitted") return "READ COMMITTED";
  return value.replaceAll("_", " ").toUpperCase();
}

class PostgresJsonAdapter implements Adapter {
  readonly id = "omr-postgres-json";
  readonly name = "OMR PostgreSQL JSON adapter";
  readonly version = "1.0.0";
  readonly capabilities = capabilities;
  readonly internal: InternalCrud;
  private readonly startedAt = Date.now();

  constructor(
    private readonly database: Queryable,
    private readonly closeDatabase: (() => Promise<void>) | undefined,
    private readonly inTransaction = false,
  ) {
    this.internal = this.createInternalCrud();
  }

  async create<T = unknown>(params: CreateParams): Promise<T> {
    const recordId = physicalId(params.data);
    const result = await this.database.query<{ data: Record<string, unknown> }>(
      `INSERT INTO omr_plugfn.records (namespace, model, record_id, data)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING data`,
      [namespace(params.namespace), params.model, recordId, json(params.data)],
    );
    return selected<T>(result.rows[0]!.data, params.select);
  }

  async findOne<T = unknown>(params: FindOneParams): Promise<T | null> {
    const rows = await this.findRows(params, 1);
    return rows[0] ? selected<T>(rows[0], params.select) : null;
  }

  async findMany<T = unknown>(params: FindManyParams): Promise<T[]> {
    const rows = await this.findRows(params, params.limit, params.offset, params.orderBy);
    return rows.map((row) => selected<T>(row, params.select));
  }

  async update<T = unknown>(params: UpdateParams): Promise<T> {
    assertWhere(params.where, "update");
    const values: unknown[] = [namespace(params.namespace), params.model, json(params.data)];
    const condition = whereSql(params.where, values);
    const result = await this.database.query<{ data: Record<string, unknown> }>(
      `UPDATE omr_plugfn.records
       SET data = data || $3::jsonb
       WHERE ctid IN (
         SELECT ctid FROM omr_plugfn.records
         WHERE namespace = $1 AND model = $2 AND ${condition}
         LIMIT 1
       )
       RETURNING data`,
      values,
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError(params.model, params.where);
    return selected<T>(row.data, params.select);
  }

  async delete(params: DeleteParams): Promise<void> {
    assertWhere(params.where, "delete");
    const values: unknown[] = [namespace(params.namespace), params.model];
    const condition = whereSql(params.where, values);
    await this.database.query(
      `DELETE FROM omr_plugfn.records
       WHERE ctid IN (
         SELECT ctid FROM omr_plugfn.records
         WHERE namespace = $1 AND model = $2 AND ${condition}
         LIMIT 1
       )`,
      values,
    );
  }

  async createMany<T = unknown>(params: CreateManyParams): Promise<T[]> {
    if (params.data.length > 1_000) throw new Error("createMany supports at most 1000 records");
    return this.transaction(async (transaction) => {
      const rows: T[] = [];
      for (const data of params.data) {
        rows.push(await transaction.create<T>({ ...params, data }));
      }
      return rows;
    });
  }

  async updateMany(params: UpdateManyParams): Promise<number> {
    const values: unknown[] = [namespace(params.namespace), params.model, json(params.data)];
    const condition = whereSql(params.where, values);
    const result = await this.database.query(
      `UPDATE omr_plugfn.records SET data = data || $3::jsonb
       WHERE namespace = $1 AND model = $2 AND ${condition}`,
      values,
    );
    return result.rowCount ?? 0;
  }

  async deleteMany(params: DeleteManyParams): Promise<number> {
    const values: unknown[] = [namespace(params.namespace), params.model];
    const condition = whereSql(params.where, values);
    const result = await this.database.query(
      `DELETE FROM omr_plugfn.records
       WHERE namespace = $1 AND model = $2 AND ${condition}`,
      values,
    );
    return result.rowCount ?? 0;
  }

  async upsert<T = unknown>(params: UpsertParams): Promise<T> {
    const run = async (database: Adapter | TransactionAdapter): Promise<T> => {
      const lockKey = JSON.stringify([namespace(params.namespace), params.model, params.where]);
      await this.database.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );
      const existing = await database.findOne<Record<string, unknown>>({
        model: params.model,
        where: params.where,
        namespace: params.namespace,
      });
      return existing
        ? database.update<T>({
            model: params.model,
            where: params.where,
            data: params.update,
            select: params.select,
            namespace: params.namespace,
          })
        : database.create<T>({
            model: params.model,
            data: params.create,
            select: params.select,
            namespace: params.namespace,
          });
    };
    return this.inTransaction ? run(this) : this.transaction(run);
  }

  async count(params: CountParams): Promise<number> {
    const values: unknown[] = [namespace(params.namespace), params.model];
    const condition = whereSql(params.where, values);
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM omr_plugfn.records
       WHERE namespace = $1 AND model = $2 AND ${condition}`,
      values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async transaction<R>(
    callback: (transaction: TransactionAdapter) => Promise<R>,
    options?: { isolationLevel: TransactionIsolation },
  ): Promise<R> {
    if (this.inTransaction) throw new Error("Nested transactions are not supported");
    await this.database.query("BEGIN");
    try {
      if (options?.isolationLevel) {
        await this.database.query(`SET TRANSACTION ISOLATION LEVEL ${isolationSql(options.isolationLevel)}`);
      }
      const child = new PostgresJsonAdapter(this.database, undefined, true);
      const transaction = Object.assign(child, {
        commit: async () => {},
        rollback: async () => {},
      }) as TransactionAdapter;
      const result = await callback(transaction);
      await this.database.query("COMMIT");
      return result;
    } catch (error) {
      await this.database.query("ROLLBACK");
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await this.database.query("SELECT 1 FROM omr_plugfn.records LIMIT 0");
  }

  async isHealthy(): Promise<HealthStatus> {
    try {
      await this.database.query("SELECT 1");
      return { healthy: true, uptime: Date.now() - this.startedAt };
    } catch (error) {
      return {
        healthy: false,
        lastError: error instanceof Error ? error : new Error(String(error)),
        uptime: Date.now() - this.startedAt,
      };
    }
  }

  async close(): Promise<void> {
    await this.closeDatabase?.();
  }

  async getSchemaVersion(schemaNamespace: string): Promise<number> {
    const result = await this.database.query<{ version: number }>(
      "SELECT version FROM omr_plugfn.schema_versions WHERE namespace = $1",
      [schemaNamespace],
    );
    return result.rows[0]?.version ?? 0;
  }

  async setSchemaVersion(schemaNamespace: string, version: number): Promise<void> {
    await this.database.query(
      `INSERT INTO omr_plugfn.schema_versions (namespace, version) VALUES ($1, $2)
       ON CONFLICT (namespace) DO UPDATE SET version = EXCLUDED.version`,
      [schemaNamespace, version],
    );
  }

  async validateSchema(_schema: TableSchema): Promise<ValidationResult> {
    const health = await this.isHealthy();
    return health.healthy ? { valid: true } : { valid: false, errors: ["PlugFn storage is unavailable"] };
  }

  private async findRows(
    params: FindOneParams,
    limit?: number,
    offset?: number,
    orderBy?: OrderBy[],
  ): Promise<Record<string, unknown>[]> {
    const values: unknown[] = [namespace(params.namespace), params.model];
    const condition = whereSql(params.where, values);
    const order = orderSql(orderBy, values);
    let pagination = "";
    if (limit !== undefined) pagination += ` LIMIT $${values.push(limit)}::integer`;
    if (offset !== undefined) pagination += ` OFFSET $${values.push(offset)}::integer`;
    const result = await this.database.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM omr_plugfn.records
       WHERE namespace = $1 AND model = $2 AND ${condition}${order}${pagination}`,
      values,
    );
    return result.rows.map(({ data }) => data);
  }

  private createInternalCrud(): InternalCrud {
    const database = this.database;
    const find = async (
      table: string,
      where: InternalWhereClause[],
      limit?: number,
      orderBy?: string,
    ): Promise<Record<string, unknown>[]> => {
      const values: unknown[] = [table];
      const condition = whereSql(where, values);
      let order = "";
      if (orderBy) order = ` ORDER BY data -> $${values.push(orderBy)}::text`;
      const pagination = limit === undefined ? "" : ` LIMIT $${values.push(limit)}::integer`;
      const result = await database.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM omr_plugfn.internal_records
         WHERE table_name = $1 AND ${condition}${order}${pagination}`,
        values,
      );
      return result.rows.map(({ data }) => data);
    };
    return {
      async ensureTable() {
        await database.query("SELECT 1 FROM omr_plugfn.internal_records LIMIT 0");
      },
      async create(table, data) {
        const record = { ...data, id: typeof data.id === "string" ? data.id : crypto.randomUUID() };
        await database.query(
          `INSERT INTO omr_plugfn.internal_records (table_name, record_id, data)
           VALUES ($1, $2, $3::jsonb)`,
          [table, record.id, json(record)],
        );
        return record;
      },
      async findOne(table, where) {
        return (await find(table, where, 1))[0] ?? null;
      },
      async findMany(table, where, options) {
        return find(table, where, options?.limit, options?.orderBy);
      },
      async update(table, where, data) {
        const values: unknown[] = [table, json(data)];
        const condition = whereSql(where, values);
        const result = await database.query(
          `UPDATE omr_plugfn.internal_records SET data = data || $2::jsonb
           WHERE table_name = $1 AND ${condition}`,
          values,
        );
        return result.rowCount ?? 0;
      },
      async delete(table, where) {
        const values: unknown[] = [table];
        const condition = whereSql(where, values);
        const result = await database.query(
          `DELETE FROM omr_plugfn.internal_records WHERE table_name = $1 AND ${condition}`,
          values,
        );
        return result.rowCount ?? 0;
      },
      async createMany(table, data) {
        const rows: Record<string, unknown>[] = [];
        for (const record of data) rows.push(await this.create(table, record));
        return rows;
      },
    };
  }
}

export function createPostgresPlugFnAdapter(
  client: Client,
  closeClient?: () => Promise<void>,
): Adapter {
  return new PostgresJsonAdapter(client, closeClient);
}
