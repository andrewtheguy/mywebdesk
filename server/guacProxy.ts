import type { Server } from "node:http";
import net from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { getAuthTokenFromCookieHeader, validateAuthToken } from "./auth.js";
import { registerSessionWebSocket, validateSessionId } from "./session.js";

interface GuacProxyOptions {
	guacdHost: string;
	guacdPort: number;
}

const activeSockets = new Set<net.Socket>();
const activeWebSockets = new Set<WebSocket>();

const GUAC_STATUS = {
	SERVER_ERROR: 0x0200,
	UPSTREAM_TIMEOUT: 0x0202,
	UPSTREAM_NOT_FOUND: 0x0207,
};

const READY_TIMEOUT_MS = 15000;
const DEFAULT_DPI = "96";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_IMAGE_MIMETYPES = ["image/png", "image/jpeg"];
const DEBUG_GUAC_PROXY = process.env.DEBUG_GUAC_PROXY === "1";

let vncDisplaySize = { width: 0, height: 0 };

export function getVncDisplaySize(): { width: number; height: number } {
	return vncDisplaySize;
}

interface ParsedInstruction {
	opcode: string;
	args: string[];
	raw: string;
	nextOffset: number;
}

function normalizeParamName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toInstruction(
	elements: Array<string | number | null | undefined>,
): string {
	const encoded = elements.map((element) => {
		const value = element == null ? "" : String(element);
		return `${value.length}.${value}`;
	});
	return `${encoded.join(",")};`;
}

function parseOneInstruction(
	buffer: string,
	offset: number,
): ParsedInstruction | null {
	const startOffset = offset;
	const elements: string[] = [];

	while (offset < buffer.length) {
		const lengthEnd = buffer.indexOf(".", offset);
		if (lengthEnd === -1) return null;

		const lengthValue = buffer.slice(offset, lengthEnd);
		if (!/^\d+$/.test(lengthValue)) {
			throw new Error(`Invalid instruction length "${lengthValue}"`);
		}

		const elementLength = Number.parseInt(lengthValue, 10);
		const elementStart = lengthEnd + 1;
		const elementEnd = elementStart + elementLength;

		if (elementEnd >= buffer.length) return null;

		const terminator = buffer[elementEnd];
		if (terminator !== "," && terminator !== ";") {
			throw new Error(`Unexpected instruction terminator "${terminator}"`);
		}

		elements.push(buffer.slice(elementStart, elementEnd));
		offset = elementEnd + 1;

		if (terminator === ";") {
			const [opcode = "", ...args] = elements;
			return {
				opcode,
				args,
				raw: buffer.slice(startOffset, offset),
				nextOffset: offset,
			};
		}
	}

	return null;
}

function parseInstructionStream(
	onInstruction: (instruction: ParsedInstruction) => void,
): (chunk: string) => void {
	let buffer = "";

	return (chunk: string) => {
		buffer += chunk;
		let offset = 0;

		while (offset < buffer.length) {
			const instruction = parseOneInstruction(buffer, offset);
			if (!instruction) break;
			offset = instruction.nextOffset;
			onInstruction(instruction);
		}

		if (offset > 0) {
			buffer = buffer.slice(offset);
		}
	};
}

function parseInstructionMessage(message: string): ParsedInstruction[] | null {
	const instructions: ParsedInstruction[] = [];
	let offset = 0;

	while (offset < message.length) {
		const instruction = parseOneInstruction(message, offset);
		if (!instruction) return null;
		instructions.push(instruction);
		offset = instruction.nextOffset;
	}

	return instructions;
}

function parseList(value: string | null): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function decodeWebSocketMessageData(
	data: string | Buffer | ArrayBuffer | Buffer[],
): string {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf-8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
	return Buffer.from(data).toString("utf-8");
}

function normalizeKeyPressedArg(value: string): string {
	const normalized = value.toLowerCase();
	if (normalized === "true") return "1";
	if (normalized === "false") return "0";
	return value;
}

function normalizeClientInstruction(instruction: ParsedInstruction): string {
	if (instruction.opcode !== "key" || instruction.args.length < 2) {
		return instruction.raw;
	}

	const normalizedPressed = normalizeKeyPressedArg(instruction.args[1]);
	if (normalizedPressed === instruction.args[1]) {
		return instruction.raw;
	}

	return toInstruction([
		instruction.opcode,
		instruction.args[0],
		normalizedPressed,
		...instruction.args.slice(2),
	]);
}

function isInternalPingInstruction(instruction: ParsedInstruction): boolean {
	return instruction.opcode === "" && instruction.args[0] === "ping";
}

function closeWithGuacStatus(ws: WebSocket, statusCode: number): void {
	if (ws.readyState === ws.OPEN) {
		ws.close(1011, String(statusCode));
		return;
	}
	if (ws.readyState === ws.CONNECTING) {
		ws.terminate();
	}
}

function buildConnectArgs(
	serverArgs: string[],
	queryByNormalizedName: Map<string, string>,
): { selectedVersion: string; connectArgs: string[] } {
	const requestedVersion =
		queryByNormalizedName.get("version") || "VERSION_1_1_0";
	const versionArgs = serverArgs.filter((arg) => arg.startsWith("VERSION_"));

	let selectedVersion = requestedVersion;
	if (versionArgs.length > 0 && !versionArgs.includes(requestedVersion)) {
		selectedVersion = versionArgs.includes("VERSION_1_1_0")
			? "VERSION_1_1_0"
			: versionArgs[0];
	}

	const connectArgs = serverArgs.map((argName) => {
		if (argName.startsWith("VERSION_")) {
			return selectedVersion;
		}

		const normalizedArgName = normalizeParamName(argName);
		if (normalizedArgName === "hostname" && queryByNormalizedName.has("host")) {
			return queryByNormalizedName.get("host") || "";
		}

		return queryByNormalizedName.get(normalizedArgName) || "";
	});

	return { selectedVersion, connectArgs };
}

export function attachGuacProxy(
	server: Server,
	options: GuacProxyOptions,
): WebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req, socket, head) => {
		const upgradeUrl = req.url
			? new URL(req.url, `http://${req.headers.host || "localhost"}`)
			: null;
		const pathname = upgradeUrl?.pathname ?? "";
		if (pathname !== "/guac/ws") {
			socket.destroy();
			return;
		}
		const cookieToken = getAuthTokenFromCookieHeader(req.headers.cookie);
		if (!cookieToken || !validateAuthToken(cookieToken)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		const sessionId = upgradeUrl?.searchParams.get("SESSION_ID") ?? "";
		if (!validateSessionId(sessionId)) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			// Pass the already-parsed URL to avoid re-parsing in the connection handler.
			wss.emit("connection", ws, upgradeUrl);
		});
	});

	wss.on("connection", (ws: WebSocket, requestUrl: URL) => {
		activeWebSockets.add(ws);
		registerSessionWebSocket(ws);
		const query = requestUrl.searchParams;
		const queryByNormalizedName = new Map<string, string>();
		for (const [key, value] of query.entries()) {
			const normalizedName = normalizeParamName(key);
			if (!queryByNormalizedName.has(normalizedName)) {
				queryByNormalizedName.set(normalizedName, value);
			}
		}

		queryByNormalizedName.delete("password");
		const vncPassword = process.env.VNC_PASSWORD || "";
		if (vncPassword) {
			queryByNormalizedName.set("password", vncPassword);
		}

		const connectionType = queryByNormalizedName.get("type") || "vnc";
		const width = queryByNormalizedName.get("width") || "";
		const height = queryByNormalizedName.get("height") || "";
		const dpi = queryByNormalizedName.get("dpi") || DEFAULT_DPI;
		const timezone = queryByNormalizedName.get("timezone") || DEFAULT_TIMEZONE;
		const requestedImageMimetypes = parseList(
			queryByNormalizedName.get("image") || null,
		);
		const imageMimetypes =
			requestedImageMimetypes.length > 0
				? requestedImageMimetypes
				: DEFAULT_IMAGE_MIMETYPES;
		if (DEBUG_GUAC_PROXY) {
			console.log(
				`[guac-proxy] ws connected type=${connectionType} host=${queryByNormalizedName.get("hostname") || ""} port=${queryByNormalizedName.get("port") || ""}`,
			);
		}

		let ready = false;
		let tcpChunkCount = 0;
		const pendingClientMessages: string[] = [];
		const readyTimeout = setTimeout(() => {
			if (ready) return;
			console.error("guacd handshake timed out before ready");
			closeWithGuacStatus(ws, GUAC_STATUS.UPSTREAM_TIMEOUT);
			destroyTcp();
		}, READY_TIMEOUT_MS);

		function sendToGuacd(message: string): void {
			if (!tcp.destroyed) {
				tcp.write(message);
			}
		}

		function flushPendingMessages(): void {
			if (!ready) return;
			while (pendingClientMessages.length > 0) {
				const message = pendingClientMessages.shift();
				if (message) sendToGuacd(message);
			}
		}

		function destroyTcp(): void {
			if (tcp.destroyed) return;
			tcp.write(toInstruction(["disconnect"]));
			tcp.destroy();
		}

		const tcp = net.createConnection(
			{ host: options.guacdHost, port: options.guacdPort },
			() => {
				console.log(
					`Connected to guacd (${options.guacdHost}:${options.guacdPort})`,
				);
				sendToGuacd(toInstruction(["select", connectionType]));
			},
		);

		activeSockets.add(tcp);

		const parseTcpData = parseInstructionStream((instruction) => {
			if (
				DEBUG_GUAC_PROXY &&
				(instruction.opcode === "args" ||
					instruction.opcode === "ready" ||
					instruction.opcode === "sync" ||
					instruction.opcode === "error")
			) {
				console.log(`[guac-proxy] <= ${instruction.opcode}`);
			}

			if (instruction.opcode === "args") {
				const { selectedVersion, connectArgs } = buildConnectArgs(
					instruction.args,
					queryByNormalizedName,
				);
				sendToGuacd(toInstruction(["size", width, height, dpi]));
				sendToGuacd(toInstruction(["audio"]));
				sendToGuacd(toInstruction(["video"]));
				sendToGuacd(toInstruction(["image", ...imageMimetypes]));
				if (selectedVersion === "VERSION_1_1_0") {
					sendToGuacd(toInstruction(["timezone", timezone]));
				}
				sendToGuacd(toInstruction(["connect", ...connectArgs]));
				return;
			}

			if (instruction.opcode === "ready") {
				ready = true;
				clearTimeout(readyTimeout);
				if (ws.readyState === ws.OPEN) {
					ws.send(toInstruction(["", instruction.args[0] || ""]));
				}
				flushPendingMessages();
				return;
			}

			if (instruction.opcode === "size" && instruction.args[0] === "0") {
				const w = Number.parseInt(instruction.args[1], 10);
				const h = Number.parseInt(instruction.args[2], 10);
				if (Number.isFinite(w) && Number.isFinite(h)) {
					vncDisplaySize = { width: w, height: h };
				}
			}

			if (ws.readyState === ws.OPEN) {
				ws.send(instruction.raw);
			}
		});

		tcp.on("data", (data) => {
			const chunkText = data.toString("utf-8");
			tcpChunkCount += 1;
			if (DEBUG_GUAC_PROXY && tcpChunkCount <= 3) {
				console.log(
					`[guac-proxy] <= raw[${tcpChunkCount}] ${JSON.stringify(chunkText.slice(0, 180))}`,
				);
			}
			try {
				parseTcpData(chunkText);
			} catch (err) {
				console.error(
					"Failed parsing guacd instruction stream:",
					err instanceof Error ? err.message : String(err),
				);
				closeWithGuacStatus(ws, GUAC_STATUS.SERVER_ERROR);
				destroyTcp();
			}
		});

		tcp.on("error", (err) => {
			console.error("guacd TCP error:", err.message);
			closeWithGuacStatus(ws, GUAC_STATUS.UPSTREAM_NOT_FOUND);
		});

		tcp.on("close", () => {
			if (DEBUG_GUAC_PROXY) {
				console.log("[guac-proxy] guacd tcp closed");
			}
			clearTimeout(readyTimeout);
			activeSockets.delete(tcp);
			closeWithGuacStatus(ws, GUAC_STATUS.UPSTREAM_NOT_FOUND);
		});

		ws.on("message", (data) => {
			try {
				const message = decodeWebSocketMessageData(
					data as string | Buffer | ArrayBuffer | Buffer[],
				);

				let instructions: ParsedInstruction[] | null = null;
				try {
					instructions = parseInstructionMessage(message);
				} catch (err) {
					console.error(
						"Failed parsing websocket instruction stream from client:",
						err instanceof Error ? err.message : String(err),
					);
					closeWithGuacStatus(ws, GUAC_STATUS.SERVER_ERROR);
					destroyTcp();
					return;
				}

				if (!instructions) {
					console.error(
						"Failed parsing websocket instruction stream from client",
					);
					closeWithGuacStatus(ws, GUAC_STATUS.SERVER_ERROR);
					destroyTcp();
					return;
				}

				for (const instruction of instructions) {
					if (isInternalPingInstruction(instruction)) {
						if (ws.readyState === ws.OPEN) {
							ws.send(instruction.raw);
						}
						continue;
					}

					const normalizedInstruction = normalizeClientInstruction(instruction);
					if (!ready) {
						pendingClientMessages.push(normalizedInstruction);
						continue;
					}

					if (!tcp.destroyed) {
						tcp.write(normalizedInstruction);
					}
				}
			} catch (err) {
				console.error(
					"Unhandled error while processing websocket message:",
					err instanceof Error ? err.message : String(err),
				);
				closeWithGuacStatus(ws, GUAC_STATUS.SERVER_ERROR);
				destroyTcp();
			}
		});

		ws.on("close", (code, reason) => {
			if (DEBUG_GUAC_PROXY) {
				console.log(
					`[guac-proxy] ws closed code=${code} reason=${reason.toString()}`,
				);
			}
			clearTimeout(readyTimeout);
			activeWebSockets.delete(ws);
			destroyTcp();
		});

		ws.on("error", (err) => {
			console.error("WebSocket error:", err.message);
			destroyTcp();
		});
	});

	return wss;
}

export function closeAll() {
	for (const ws of activeWebSockets) {
		ws.terminate();
	}
	activeWebSockets.clear();
	for (const s of activeSockets) {
		s.destroy();
	}
	activeSockets.clear();
}
