import crypto from "node:crypto";

const AUTH_COOKIE_NAME = "auth_token";

if (!process.env.SITE_SECRET) {
	throw new Error("SITE_SECRET environment variable is required");
}
const SITE_SECRET: string = process.env.SITE_SECRET;

let authToken: string | null = null;

const MAX_COMPARE_LENGTH = 1024;

function timingSafeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf-8");
	const bufB = Buffer.from(b, "utf-8");
	const maxLen = Math.min(
		Math.max(bufA.length, bufB.length),
		MAX_COMPARE_LENGTH,
	);
	const paddedA = Buffer.alloc(maxLen);
	const paddedB = Buffer.alloc(maxLen);
	bufA.copy(paddedA, 0, 0, Math.min(bufA.length, maxLen));
	bufB.copy(paddedB, 0, 0, Math.min(bufB.length, maxLen));
	return (
		crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length
	);
}

export function validateSecret(candidate: string): boolean {
	return timingSafeEqual(candidate, SITE_SECRET);
}

export function createAuthToken(): string {
	authToken = crypto.randomUUID();
	return authToken;
}

export function validateAuthToken(token: string): boolean {
	if (!authToken) return false;
	return timingSafeEqual(token, authToken);
}

export function revokeAuthToken(): void {
	authToken = null;
}

export function getAuthCookieName(): string {
	return AUTH_COOKIE_NAME;
}

export function getAuthTokenFromCookieHeader(
	header: string | undefined,
): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.split("=");
		if (name.trim() === AUTH_COOKIE_NAME) {
			return rest.join("=").trim() || null;
		}
	}
	return null;
}
