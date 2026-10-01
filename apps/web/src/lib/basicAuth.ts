import { createHash, timingSafeEqual } from "node:crypto";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Hashing first gives both sides the same length, which timingSafeEqual requires, and hides the password's length. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Checks an `Authorization: Basic ...` header against the site password. The username is ignored (browsers insist
 * on asking for one); only the password matters, compared in constant time. Anything malformed is simply false.
 */
export function checkBasicAuth(header: string | null | undefined, password: string): boolean {
  if (!password || !header) return false;

  const match = /^basic\s+(\S+)$/i.exec(header.trim());
  const encoded = match?.[1];
  if (!encoded || !BASE64.test(encoded)) return false;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  // The password is everything after the first colon, so it may itself contain colons.
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;

  return timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
}

export type GateDecision = { allow: true } | { allow: false; status: 401 | 503 };

/**
 * Whether a request may see the site. With a password set it is enforced everywhere. Without one the site is open
 * only in development and test; any other environment (production, or one we do not recognise) refuses to serve
 * rather than quietly going public.
 */
export function gateDecision(input: {
  authorization: string | null | undefined;
  sitePassword: string | undefined;
  nodeEnv: string | undefined;
}): GateDecision {
  if (input.sitePassword) {
    return checkBasicAuth(input.authorization, input.sitePassword) ? { allow: true } : { allow: false, status: 401 };
  }
  if (input.nodeEnv === "development" || input.nodeEnv === "test") return { allow: true };
  return { allow: false, status: 503 };
}
