export { initHtpasswd, verifyCredentials } from "./htpasswd.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const SESSION_COOKIE_NAME = "guac_session";

interface SessionData {
  username: string;
  expiresAt: number;
}

const validSessions = new Map<string, SessionData>();

function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, data] of validSessions) {
    if (now >= data.expiresAt) {
      validSessions.delete(token);
    }
  }
}

setInterval(purgeExpiredSessions, PURGE_INTERVAL_MS).unref();

export function createSession(username: string): string {
  purgeExpiredSessions();
  const token = crypto.randomUUID();
  validSessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function isValidSession(token: string): boolean {
  const data = validSessions.get(token);
  if (!data) return false;
  if (Date.now() >= data.expiresAt) {
    validSessions.delete(token);
    return false;
  }
  data.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

export function invalidateSession(token: string): void {
  validSessions.delete(token);
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function getSessionTokenFromCookieHeader(
  header: string | undefined,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name.trim() === SESSION_COOKIE_NAME) {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}
