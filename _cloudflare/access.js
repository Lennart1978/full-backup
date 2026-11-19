export const DASHBOARD_ORIGIN = "https://full-backup.eisenfeld.workers.dev";
const ISSUER = "https://eisenfeld.cloudflareaccess.com";
const AUDIENCE = "fd5ac4c45d304ef414fe95b0fe9c066679dd25d2d1c30af7f278a11c22b6d33b";

function decode(segment) {
  return Uint8Array.from(atob(segment.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}

export function missingDeletionSecrets(env) {
  return ["BACKUP_DELETE_EMAIL", "BACKUP_DELETE_TOKEN"].filter(
    (name) => typeof env[name] !== "string" || !env[name].trim(),
  );
}

export async function deletionAccess(request, env) {
  if (new URL(request.url).origin !== DASHBOARD_ORIGIN) return "preview";
  if (missingDeletionSecrets(env).length) return "configuration";

  // Browser requests can carry the signed app token in the Access cookie.
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    request.headers.get("Cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return "session";
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
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
    )
      return "session";

    const response = await fetch(ISSUER + "/cdn-cgi/access/certs", {
      cf: { cacheEverything: true, cacheTtl: 300 },
      redirect: "manual",
    });
    if (!response.ok) return "verification";
    const { keys } = await response.json();
    const jwk = keys.find((key) => key.kid === kid && key.kty === "RSA" && key.alg === "RS256");
    if (!jwk) return "verification";
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(signature),
      new TextEncoder().encode(header + "." + body),
    );
    if (!verified) return "session";
    return typeof claims.email === "string" &&
      claims.email.trim().toLowerCase() === env.BACKUP_DELETE_EMAIL.trim().toLowerCase()
      ? "allowed"
      : "email";
  } catch {
    return "verification";
  }
}
