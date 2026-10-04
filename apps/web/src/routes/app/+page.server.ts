import { directPlaygroundEnabled } from "$lib/server/direct-playground-rollout.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ platform }) => ({
  directPlaygroundEnabled: directPlaygroundEnabled(platform?.env),
});
