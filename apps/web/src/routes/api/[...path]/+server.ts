import { toSvelteKitHandlers } from "@superfunctions/http-sveltekit";
import { createCloudflareRouteServices } from "$lib/server/cloudflare-runtime.js";
import { createOMRRouter } from "$lib/server/router.js";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = toSvelteKitHandlers(
  (event) => {
    const services = createCloudflareRouteServices(event);
    return createOMRRouter(
      services.device,
      services.connections,
      services.tools,
      services.execution,
      services.controlPlane,
    );
  },
);
