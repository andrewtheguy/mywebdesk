let storedUsername = "";
let storedHash = "";

export function initHtpasswd(): void {
	const raw = process.env.SITE_PASSWD;
	if (!raw) {
		throw new Error("SITE_PASSWD environment variable is required");
	}

	const decoded = Buffer.from(raw.trim(), "base64url").toString("utf-8");
	const idx = decoded.indexOf(":");
	if (idx === -1) {
		throw new Error(
			"SITE_PASSWD must be a base64-encoded username:bcrypt_hash",
		);
	}

	const username = decoded.slice(0, idx);
	const hash = decoded.slice(idx + 1);

	if (!username) {
		throw new Error("SITE_PASSWD username must not be empty");
	}

	if (!/^\$2[aby]\$/.test(hash)) {
		throw new Error(
			`Unsupported hash for user "${username}" (only bcrypt $2a$/$2b$/$2y$ supported)`,
		);
	}

	storedUsername = username;
	storedHash = hash;
	console.log(`[auth] loaded credentials for user "${username}"`);
}

export async function verifyCredentials(
	username: string,
	password: string,
): Promise<boolean> {
	if (!storedUsername) return false;
	if (username !== storedUsername) return false;
	return Bun.password.verify(password, storedHash);
}
