/**
 * CLI smoke tests — verify arg parsing, help, version, error handling.
 *
 * Does NOT require a running pi process. Tests the CLI binary directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "dist", "cli.js");
const PKG = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));

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

test("--help prints usage and exits 0", () => {
  const { stdout, exitCode } = run("--help");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("pi-mock"), "mentions pi-mock");
  assert.ok(stdout.includes("start"), "mentions start command");
  assert.ok(stdout.includes("run"), "mentions run command");
  assert.ok(stdout.includes("prompt"), "mentions prompt command");
  assert.ok(stdout.includes("record"), "mentions record command");
  assert.ok(stdout.includes("stop"), "mentions stop command");
  assert.ok(stdout.includes("--brain"), "mentions --brain flag");
  assert.ok(stdout.includes("--sandbox"), "mentions --sandbox flag");
});

test("-h also prints help", () => {
  const { stdout, exitCode } = run("-h");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("pi-mock"));
});

test("no args prints help", () => {
  const { stdout, exitCode } = run();
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("pi-mock"));
});

// ═══════════════════════════════════════════════════════════════════
// --version
// ═══════════════════════════════════════════════════════════════════

test("--version prints package version", () => {
  const { stdout, exitCode } = run("--version");
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), PKG.version);
});

test("-v also prints version", () => {
  const { stdout, exitCode } = run("-v");
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), PKG.version);
});

// ═══════════════════════════════════════════════════════════════════
// Subcommand --help
// ═══════════════════════════════════════════════════════════════════

test("start --help prints start usage", () => {
  const { stdout, exitCode } = run("start", "--help");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("pi-mock start"));
  assert.ok(stdout.includes("--brain"));
  assert.ok(stdout.includes("--extension"));
  assert.ok(stdout.includes("--sandbox"));
});

test("record --help prints record usage", () => {
  const { stdout, exitCode } = run("record", "--help");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("pi-mock record"));
  assert.ok(stdout.includes("--model"));
  assert.ok(stdout.includes("--output"));
});

test("run --help prints run usage", () => {
  const { stdout, exitCode } = run("run", "--help");
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("pi-mock run"));
});

// ═══════════════════════════════════════════════════════════════════
// Error cases
// ═══════════════════════════════════════════════════════════════════

test("unknown command exits with error", () => {
  const { stderr, exitCode } = run("nonexistent");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("Unknown command") || stderr.includes("nonexistent"), `stderr: ${stderr}`);
});

test("prompt with no message exits with error", () => {
  const { stderr, exitCode } = run("prompt");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("Usage") || stderr.includes("message"), `stderr: ${stderr}`);
});

test("run with no message exits with error", () => {
  const { stderr, exitCode } = run("run");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("Usage") || stderr.includes("message"), `stderr: ${stderr}`);
});

test("record with no args exits with error", () => {
  const { stderr, exitCode } = run("record");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("Usage") || stderr.includes("message") || stderr.includes("model"), `stderr: ${stderr}`);
});

test("prompt with no running session gives clear error", () => {
  const { stderr, exitCode } = run("prompt", "--state", "/tmp/pi-mock-nonexistent-state.json", "hello");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("No running session") || stderr.includes("not found"), `stderr: ${stderr}`);
});

test("events with no running session gives clear error", () => {
  const { stderr, exitCode } = run("events", "--state", "/tmp/pi-mock-nonexistent-state.json");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("No running session") || stderr.includes("not found"), `stderr: ${stderr}`);
});

test("stop with no running session gives clear error", () => {
  const { stderr, exitCode } = run("stop", "--state", "/tmp/pi-mock-nonexistent-state.json");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("No running session") || stderr.includes("not found"), `stderr: ${stderr}`);
});

test("start with nonexistent brain file gives clear error", () => {
  const { stderr, exitCode } = run("start", "--brain", "/tmp/pi-mock-nonexistent-brain.js");
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("not found") || stderr.includes("Brain file"), `stderr: ${stderr}`);
});
