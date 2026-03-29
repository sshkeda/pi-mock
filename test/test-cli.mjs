/**
 * CLI smoke tests — verify arg parsing, help, version, error handling.
 *
 * Does NOT require a running pi process. Tests the CLI binary directly.
 */
import { execFileSync, execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");
const PKG = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stderr.write(`\n━━━ ${name} `);
  try {
    await fn();
    passed++;
    process.stderr.write(`✅ PASS\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`❌ FAIL: ${err.message}\n`);
    if (err.stack) process.stderr.write(`    ${err.stack.split("\n").slice(1, 3).join("\n    ")}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/** Run CLI, return { stdout, stderr, exitCode }. */
function run(...args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// --help
// ═══════════════════════════════════════════════════════════════════

await test("--help prints usage and exits 0", () => {
  const { stdout, exitCode } = run("--help");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.includes("pi-mock"), "mentions pi-mock");
  assert(stdout.includes("start"), "mentions start command");
  assert(stdout.includes("run"), "mentions run command");
  assert(stdout.includes("prompt"), "mentions prompt command");
  assert(stdout.includes("record"), "mentions record command");
  assert(stdout.includes("stop"), "mentions stop command");
  assert(stdout.includes("--brain"), "mentions --brain flag");
  assert(stdout.includes("--sandbox"), "mentions --sandbox flag");
});

await test("-h also prints help", () => {
  const { stdout, exitCode } = run("-h");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.includes("pi-mock"), "mentions pi-mock");
});

await test("no args prints help", () => {
  const { stdout, exitCode } = run();
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.includes("pi-mock"), "mentions pi-mock");
});

// ═══════════════════════════════════════════════════════════════════
// --version
// ═══════════════════════════════════════════════════════════════════

await test("--version prints package version", () => {
  const { stdout, exitCode } = run("--version");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.trim() === PKG.version, `expected "${PKG.version}", got "${stdout.trim()}"`);
});

await test("-v also prints version", () => {
  const { stdout, exitCode } = run("-v");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.trim() === PKG.version, `expected "${PKG.version}", got "${stdout.trim()}"`);
});

// ═══════════════════════════════════════════════════════════════════
// Subcommand --help
// ═══════════════════════════════════════════════════════════════════

await test("start --help prints start usage", () => {
  const { stdout, exitCode } = run("start", "--help");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.includes("pi-mock start"), "mentions pi-mock start");
  assert(stdout.includes("--brain"), "mentions --brain");
  assert(stdout.includes("--extension"), "mentions --extension");
  assert(stdout.includes("--sandbox"), "mentions --sandbox");
});

await test("record --help prints record usage", () => {
  const { stdout, exitCode } = run("record", "--help");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.includes("pi-mock record"), "mentions pi-mock record");
  assert(stdout.includes("--model"), "mentions --model");
  assert(stdout.includes("--output"), "mentions --output");
});

await test("run --help prints run usage", () => {
  const { stdout, exitCode } = run("run", "--help");
  assert(exitCode === 0, `exit code: ${exitCode}`);
  assert(stdout.includes("pi-mock run"), "mentions pi-mock run");
});

// ═══════════════════════════════════════════════════════════════════
// Error cases
// ═══════════════════════════════════════════════════════════════════

await test("unknown command exits with error", () => {
  const { stderr, exitCode } = run("nonexistent");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("Unknown command") || stderr.includes("nonexistent"), `stderr: ${stderr}`);
});

await test("prompt with no message exits with error", () => {
  const { stderr, exitCode } = run("prompt");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("Usage") || stderr.includes("message"), `stderr: ${stderr}`);
});

await test("run with no message exits with error", () => {
  const { stderr, exitCode } = run("run");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("Usage") || stderr.includes("message"), `stderr: ${stderr}`);
});

await test("record with no args exits with error", () => {
  const { stderr, exitCode } = run("record");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("Usage") || stderr.includes("message") || stderr.includes("model"), `stderr: ${stderr}`);
});

await test("prompt with no running session gives clear error", () => {
  const { stderr, exitCode } = run("prompt", "--state", "/tmp/pi-mock-nonexistent-state.json", "hello");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("No running session") || stderr.includes("not found"), `stderr: ${stderr}`);
});

await test("events with no running session gives clear error", () => {
  const { stderr, exitCode } = run("events", "--state", "/tmp/pi-mock-nonexistent-state.json");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("No running session") || stderr.includes("not found"), `stderr: ${stderr}`);
});

await test("stop with no running session gives clear error", () => {
  const { stderr, exitCode } = run("stop", "--state", "/tmp/pi-mock-nonexistent-state.json");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("No running session") || stderr.includes("not found"), `stderr: ${stderr}`);
});

await test("start with nonexistent brain file gives clear error", () => {
  const { stderr, exitCode } = run("start", "--brain", "/tmp/pi-mock-nonexistent-brain.js");
  assert(exitCode === 1, `exit code: ${exitCode}`);
  assert(stderr.includes("not found") || stderr.includes("Brain file"), `stderr: ${stderr}`);
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.error(`\n${"═".repeat(60)}`);
console.error(`CLI tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.error(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
