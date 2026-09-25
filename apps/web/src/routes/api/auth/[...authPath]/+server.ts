import { handleCloudflareAuth } from "$lib/server/auth-router.js";

export const GET = handleCloudflareAuth;
export const POST = handleCloudflareAuth;
export const PUT = handleCloudflareAuth;
export const PATCH = handleCloudflareAuth;
export const DELETE = handleCloudflareAuth;
