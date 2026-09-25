import { defineSchema } from "@datafn/core";

/**
 * Records intentionally exposed through OMR's generic DataFn surface.
 * Workspace authority, membership, grants, credentials, and secrets are absent
 * by design and live behind purpose-built control-plane services.
 */
export const publicDatafnSchema = defineSchema({
  version: 1,
  namespaced: true,
  capabilities: ["timestamps", "audit"],
  resources: [
    {
      name: "workspace_profiles",
      version: 1,
      idPrefix: "profile",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        {
          name: "displayName",
          type: "string",
          required: true,
          minLength: 1,
          maxLength: 120,
        },
      ],
      indices: { base: ["displayName"] },
      permissions: {
        read: { fields: ["id", "displayName"] },
        write: { fields: ["displayName"] },
      },
    },
  ],
});
