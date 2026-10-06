import { error } from "@sveltejs/kit";
import { assistedPlaygroundEnabled, directPlaygroundEnabled } from "$lib/server/direct-playground-rollout.js";
import type { PageServerLoad } from "./$types";

/** Keep the user-facing playground unavailable until staged acceptance. */
export const load: PageServerLoad = ({ platform }) => {
  if (!directPlaygroundEnabled(platform?.env)) error(404, "Direct tool testing is unavailable");
  return { assistedEnabled: assistedPlaygroundEnabled(platform?.env) };
};
