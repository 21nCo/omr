import { bigint, index, jsonb, pgSchema, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

const application = pgSchema("omr_app");
const control = pgSchema("omr_control");

export const workspaceProfiles = application.table(
  "workspace_profiles",
  {
    __ns: text("__ns").notNull(),
    id: text("id").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({ columns: [table.__ns, table.id] }),
    index("workspace_profiles_namespace_idx").on(table.__ns),
    index("workspace_profiles_display_name_idx").on(table.displayName),
  ],
);

export const datafnKv = application.table(
  "kv",
  {
    __ns: text("__ns").notNull(),
    id: text("id").notNull(),
    value: jsonb("value"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({ columns: [table.__ns, table.id] }),
    index("kv_namespace_idx").on(table.__ns),
  ],
);

/** Only this object is passed to DataFn's Drizzle adapter. */
export const publicDrizzleSchema = {
  workspace_profiles: workspaceProfiles,
  kv: datafnKv,
};

export const workspaces = control.table("workspaces", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["personal", "team"] }).notNull(),
  name: text("name").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const workspaceMemberships = control.table(
  "workspace_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
    index("workspace_memberships_user_idx").on(table.userId),
  ],
);

/** Privileged tables are exported separately and never passed to DataFn. */
export const controlDrizzleSchema = {
  workspaces,
  workspace_memberships: workspaceMemberships,
};
