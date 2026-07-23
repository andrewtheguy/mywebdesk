let storedUsername = "";
let storedHash = "";

export function initHtpasswd(sitePasswd: string): void {
  const decoded = Buffer.from(sitePasswd.trim(), "base64url").toString("utf-8");
  const idx = decoded.indexOf(":");
  if (idx === -1) {
    throw new Error(
      "site_passwd must be a base64-encoded username:bcrypt_hash",
    );
  }

  const username = decoded.slice(0, idx);
  const hash = decoded.slice(idx + 1);

  if (!username) {
    throw new Error("site_passwd username must not be empty");
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
