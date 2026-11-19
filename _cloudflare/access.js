export const DASHBOARD_ORIGIN = "https://full-backup.eisenfeld.workers.dev";
const ISSUER = "https://eisenfeld.cloudflareaccess.com";
const AUDIENCE = "fd5ac4c45d304ef414fe95b0fe9c066679dd25d2d1c30af7f278a11c22b6d33b";

function decode(segment) {
  return Uint8Array.from(atob(segment.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}

export async function canDelete(request, env) {
  if (
    new URL(request.url).origin !== DASHBOARD_ORIGIN ||
    !env.BACKUP_DELETE_TOKEN ||
    !env.BACKUP_DELETE_EMAIL
  ) {
    return false;
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return false;
  try {
    const [header, body, signature] = token.split(".");
    const decoder = new TextDecoder();
    const { alg, kid } = JSON.parse(decoder.decode(decode(header)));
    const claims = JSON.parse(decoder.decode(decode(body)));
    const now = Date.now() / 1000;
    if (
      alg !== "RS256" ||
      !kid ||
      claims.iss !== ISSUER ||
      claims.type !== "app" ||
      !Array.isArray(claims.aud) ||
      !claims.aud.includes(AUDIENCE) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) ||
      typeof claims.email !== "string" ||
      claims.email.toLowerCase() !== env.BACKUP_DELETE_EMAIL.trim().toLowerCase()
    )
      return false;

    const response = await fetch(ISSUER + "/cdn-cgi/access/certs", {
      cf: { cacheEverything: true, cacheTtl: 300 },
      redirect: "manual",
    });
    if (!response.ok) return false;
    const { keys } = await response.json();
    const jwk = keys.find((key) => key.kid === kid && key.kty === "RSA" && key.alg === "RS256");
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(signature),
      new TextEncoder().encode(header + "." + body),
    );
  } catch {
    return false;
  }
}
