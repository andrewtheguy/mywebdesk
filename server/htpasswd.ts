let storedUsername = "";
let storedHash = "";

export function initHtpasswd(): void {
	const raw = process.env.HTPASSWD;
	if (!raw) {
		throw new Error("HTPASSWD environment variable is required");
	}

	const line = raw.trim();
	const idx = line.indexOf(":");
	if (idx === -1) {
		throw new Error("HTPASSWD must be in format username:bcrypt_hash");
	}

	const username = line.slice(0, idx);
	const hash = line.slice(idx + 1);

	if (!username) {
		throw new Error("HTPASSWD username must not be empty");
	}

	if (!/^\$2[aby]\$/.test(hash)) {
		throw new Error(
			`Unsupported hash for user "${username}" (only bcrypt $2a$/$2b$/$2y$ supported)`,
		);
	}

	storedUsername = username;
	storedHash = hash;
	console.log(`[htpasswd] loaded credentials for user "${username}"`);
}

export async function verifyCredentials(
	username: string,
	password: string,
): Promise<boolean> {
	if (!storedUsername) return false;
	if (username !== storedUsername) return false;
	return Bun.password.verify(password, storedHash);
}
