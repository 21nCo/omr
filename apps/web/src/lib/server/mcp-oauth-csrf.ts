const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function createOAuthCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function oauthCsrfCookie(name: string, token: string, maxAge = 600): string {
  return `${name}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function validOAuthCsrf(request: Request, name: string, submitted: string | null): boolean {
  if (!submitted || !TOKEN_PATTERN.test(submitted)) return false;
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1 || !TOKEN_PATTERN.test(values[0]!)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= values[0]!.charCodeAt(index) ^ submitted.charCodeAt(index);
  }
  return difference === 0;
}
