import { index, jsonb, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const identity = pgSchema("omr_identity");

export const users = identity.table(
  "users",
  {
    id: text("id").primaryKey(),
    primaryEmail: text("primary_email"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("authfn_users_primary_email_idx").on(table.primaryEmail)],
);

export const sessions = identity.table(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfHash: text("csrf_hash"),
    methods: jsonb("methods").notNull(),
    metadata: jsonb("metadata"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("authfn_sessions_expires_at_idx").on(table.expiresAt),
    uniqueIndex("authfn_sessions_token_hash_idx").on(table.tokenHash),
    index("authfn_sessions_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const passwordCredentials = identity.table(
  "password_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("authfn_password_credentials_user_idx").on(table.userId)],
);

export const authDrizzleSchema = {
  users,
  sessions,
  password_credentials: passwordCredentials,
};
