// SetTimes regression guard (PBKDF2-DESIGN.md §10.3): the PBKDF2 runtime
// cap (100,000) and any above-cap value may appear as literals ONLY in
// worker/src/auth/constants.ts. A second hand-typed iteration literal at
// a call site is how a >100k configuration shipped to production in one
// of the incidents behind the design — local runtimes don't enforce the
// cap, so only this scan stands guard. Runs as part of `npm test`.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const authDir = join(repoRoot, "worker", "src", "auth");
const FORBIDDEN = /\b100_?000\b|\b100_?001\b/;

const offenders = [];
for (const file of readdirSync(authDir)) {
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
  if (file === "constants.ts") continue;
  const lines = readFileSync(join(authDir, file), "utf8").split("\n");
  lines.forEach((line, index) => {
    if (FORBIDDEN.test(line)) {
      offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}
// The seed script consumes the constant too; it must not carry a literal.
const seed = readFileSync(
  join(repoRoot, "scripts", "seed-cloud-accounts.ts"),
  "utf8",
);
if (FORBIDDEN.test(seed)) {
  offenders.push("scripts/seed-cloud-accounts.ts");
}

if (offenders.length > 0) {
  console.error(
    "iteration literals found outside auth/constants.ts:\n" +
      offenders.join("\n"),
  );
  process.exit(1);
}
console.log("iteration-literal guard: clean");
