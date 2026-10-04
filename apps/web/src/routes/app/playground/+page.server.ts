import { error } from "@sveltejs/kit";
import { directPlaygroundEnabled } from "$lib/server/direct-playground-rollout.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ platform }) => {
  if (!directPlaygroundEnabled(platform?.env)) error(404, "Direct tool testing is unavailable");
  return {};
};
