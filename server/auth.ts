import crypto from "node:crypto";

const AUTH_COOKIE_NAME = "auth_token";

let authToken: string | null = null;

function timingSafeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf-8");
	const bufB = Buffer.from(b, "utf-8");
	if (bufA.length !== bufB.length) {
		// Compare against self to burn constant time, then return false.
		crypto.timingSafeEqual(bufA, bufA);
		return false;
	}
	return crypto.timingSafeEqual(bufA, bufB);
}

export function validateSecret(candidate: string): boolean {
	const secret = process.env.SITE_SECRET;
	if (!secret) return false;
	return timingSafeEqual(candidate, secret);
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
