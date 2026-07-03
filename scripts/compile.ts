// Compiles mywebdesk into a single self-contained binary.
// Sequence: vite build -> embed dist assets -> bun build --compile.
// Passing --define via Bun.spawn array args avoids the shell/JSON quoting
// mess of putting it in a package.json script string.
import { $ } from "bun";

const version = (await Bun.file("package.json").json()).version ?? "dev";
const outfile = Bun.argv[2] ?? "bin/mywebdesk";

// 1. Build the frontend (Vite -> dist/) and generate the embed module.
await $`bun run build`;
await $`bun run scripts/gen-embedded-assets.ts`;

// 2. Compile the server + embedded assets into a standalone executable.
//    NODE_ENV is baked so the binary always serves the embedded frontend.
//    --no-compile-autoload-dotenv keeps the build-time .env out of the binary and
//    stops the binary from auto-loading a .env at runtime; config is via real env
//    vars only.
const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "server/index.ts",
    "--outfile",
    outfile,
    "--define",
    'process.env.NODE_ENV="production"',
    "--define",
    `BUILD_VERSION="${version}"`,
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);
const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}
console.log(`Compiled ${outfile} (v${version})`);
