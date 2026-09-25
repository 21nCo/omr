import { authFnPasswordPlugin } from "@authfn/password";
import type { Adapter } from "@superfunctions/db";
import {
  AuthFnUnauthenticatedError,
  authfn,
  authFnPlugins,
  type AuthFnEnvironmentResolver,
  type AuthFnPlugin,
  type AuthFnServer,
  type AuthFnSession,
} from "authfn";

import { WorkspaceAuthority } from "./workspaces.js";

export interface CreateOMRIdentityRuntimeOptions {
  database: Adapter;
  workspaces: WorkspaceAuthority;
  environment?: AuthFnEnvironmentResolver;
}

export interface OMRIdentityRuntime {
  auth: AuthFnServer;
  workspaces: WorkspaceAuthority;
  requireSession(request: Request): Promise<AuthFnSession>;
}

function workspaceProvisioningPlugin(
  workspaces: WorkspaceAuthority,
): AuthFnPlugin<"omr-workspace-provisioning"> {
  return {
    name: "omr-workspace-provisioning",
    hooks: {
      async afterUserCreate(_context, user) {
        await workspaces.provisionPersonalWorkspace({
          userId: String(user.id),
          email: typeof user.primaryEmail === "string" ? user.primaryEmail : undefined,
        });
      },
      async afterSessionIssue(_context, session) {
        if (session.actorType !== "user") return;
        await workspaces.provisionPersonalWorkspace({
          userId: session.actorId,
          email: session.primaryEmail,
        });
      },
    },
    hookFailurePolicy: {
      afterUserCreate: "fail",
      afterSessionIssue: "fail",
    },
  };
}

export function createOMRIdentityRuntime(
  options: CreateOMRIdentityRuntimeOptions,
): OMRIdentityRuntime {
  const app = authfn({
    namespace: "authfn",
    basePath: "/auth",
    cookie: {
      prefix: "omr",
      path: "/",
      sameSite: "lax",
      sessionMaxAgeSeconds: 60 * 60 * 24 * 30,
      csrfMaxAgeSeconds: 60 * 60 * 24 * 30,
    },
    plugins: authFnPlugins(
      authFnPasswordPlugin(),
      workspaceProvisioningPlugin(options.workspaces),
    ),
  });
  const auth = app.createServer({
    database: options.database,
    environment: options.environment,
  });

  return {
    auth,
    workspaces: options.workspaces,
    async requireSession(request) {
      const session = await auth.provider.authenticate(request);
      if (!session || session.actorType !== "user") {
        throw new AuthFnUnauthenticatedError();
      }
      return session;
    },
  };
}
