strict no backward compatibility

single user only

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env`, so don't add `dotenv` unless explicitly required.

## Project Stack

Keep the current architecture unless explicitly asked to change it:

- Client: React + Vite + TypeScript
- Server: Bun runtime + Express + `ws`
- Remote protocol: RFB (VNC) via a vendored fork of noVNC 1.7.0 in the browser (`src/vendor/novnc`, MPL-2.0 — keep file headers, record changes in its ORIGIN.md); the server is a dumb WebSocket↔TCP byte pipe

## Lint & Type Check

Run lint and type check after making changes:

- `bunx biome check .` — lint + format checks (errors must be zero)
- `bunx biome check --write .` — auto-fix lint/format/import ordering issues
- `bunx tsc --noEmit` — run TypeScript type check

## Build

- `bun run build` — build the client bundle with Vite

## Testing

Use `bun test` to run tests.

```ts
import { expect, test } from "bun:test";

test("hello world", () => {
	expect(1).toBe(1);
});
```
