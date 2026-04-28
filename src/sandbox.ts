/**
 * Docker sandbox — network-isolated container for pi.
 *
 * The container can ONLY talk to the gateway on the host.
 * iptables in the entrypoint blocks everything else.
 *
 * Supports two modes:
 *   - sandbox: true   → Docker container, full network isolation
 *   - sandbox: false  → local child process (default, faster, no isolation)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve, basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── Helper extension path ──────────────────────────────────────────

/** Resolve path to the test-helper extension bundled with pi-mock. */
function getHelperExtensionPath(): string {
  // Works whether running from src/ (dev) or dist/ (published)
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "test-helper-extension.ts"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "test-helper-extension.ts"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: assume it's next to this file (dist/test-helper-extension.js won't work with jiti,
  // but the .ts source is always shipped in the npm package)
  return candidates[0];
}

// ─── Types ───────────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Gateway port on the host. */
  gatewayPort: number;
  /** Extension file paths to load. */
  extensions?: string[];
  /** Provider pi should use when talking to the gateway. Default: "pi-mock" */
  piProvider?: string;
  /** Model pi should use when talking to the gateway. Default: "mock" */
  piModel?: string;
  /** Working directory for pi inside the container. */
  cwd?: string;
  /** Extra CLI args for pi. */
  piArgs?: string[];
  /**
   * Path to an existing pi session JSONL file to load as pi's active
   * session. When set, pi-mock spawns pi with `--session <path>` instead
   * of the default `--no-session`. Useful for tests that need pi to see
   * preloaded conversation history (e.g. a cross-provider session that
   * triggers a specific extension code path).
   */
  sessionFile?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Docker image name. Default: auto-build "pi-mock-sandbox" */
  image?: string;
  /** Path to pi binary (local mode only). Default: "pi" */
  piBinary?: string;
  /** Extra Docker volumes: ["host:container:ro", ...] */
  volumes?: string[];
}

export interface SpawnResult {
  process: ChildProcess;
  /** Stderr accumulator. */
  stderr: string[];
  /** Temp directory (caller should clean up). */
  tmpDir: string;
}

// ─── Models.json for gateway routing ─────────────────────────────────

/**
 * Create a temp PI_CODING_AGENT_DIR with a models.json that routes
 * the "anthropic" provider to our gateway. This is the only reliable
 * way to override pi's API endpoint — env vars like ANTHROPIC_BASE_URL
 * are NOT used by pi's internal provider system.
 */
function createAgentDir(gatewayUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mock-agent-"));

  // Override ALL provider base URLs to point to our gateway.
  // The gateway detects the provider format from the URL path and responds correctly.
  // This means every pi process in the sandbox (including subprocesses) hits our brain.
  const modelsJson = {
    providers: {
      "pi-mock": {
        baseUrl: `${gatewayUrl}/v1`,
        api: "anthropic-messages",
        apiKey: "mock-key",
        models: [{ id: "mock", name: "pi-mock" }],
      },
      anthropic: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      openai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      google: { baseUrl: `${gatewayUrl}/v1beta`, apiKey: "mock-key" },
      groq: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      xai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      openrouter: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      mistral: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      cerebras: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
    },
  };

  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));

  // Fast retry defaults for testing — 100ms base delay instead of 2s.
  // Tests that need real retry timing can override via setAutoRetry() or sendRpc().
  const settingsJson = {
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 100,
    },
  };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settingsJson, null, 2));
  return dir;
}

// ─── Local mode (no Docker) ──────────────────────────────────────────

export function spawnLocal(config: SandboxConfig): SpawnResult {
  const agentDir = createAgentDir(`http://127.0.0.1:${config.gatewayPort}`);

  const provider = config.piProvider ?? "pi-mock";
  const model = config.piModel ?? "mock";

  // Default to ephemeral (--no-session) unless the test explicitly wants
  // pi to load a real session file via the sessionFile option. Mutually
  // exclusive: passing sessionFile drops --no-session and adds
  // --session <path>.
  const sessionArgs = config.sessionFile
    ? ["--session", config.sessionFile]
    : ["--no-session"];
  const args = [
    "--mode",
    "rpc",
    ...sessionArgs,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider",
    provider,
    "--model",
    model,
    ...(config.piArgs ?? []),
  ];

  // Auto-load test helper extension FIRST (before user extensions)
  // so its input handler runs before user extension handlers.
  args.push("-e", getHelperExtensionPath());

  for (const ext of config.extensions ?? []) {
    args.push("-e", resolve(ext));
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    // Proxy env vars — best-effort capture in local mode (no iptables)
    HTTP_PROXY: `http://127.0.0.1:${config.gatewayPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${config.gatewayPort}`,
    http_proxy: `http://127.0.0.1:${config.gatewayPort}`,
    https_proxy: `http://127.0.0.1:${config.gatewayPort}`,
    ALL_PROXY: `http://127.0.0.1:${config.gatewayPort}`,
    // Exclude gateway itself from proxy — API calls go direct, everything else through proxy
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...(config.env ?? {}),
  };

  const piBinary = config.piBinary ?? "pi";
  const child = spawn(piBinary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: config.cwd ?? process.cwd(),
    env,
  });

  // Catch spawn errors (e.g. ENOENT when pi binary is not installed)
  // to prevent unhandled error events from crashing the process.
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      const msg =
        `pi binary not found: "${piBinary}". ` +
        `Install it with: npm install -g @mariozechner/pi-coding-agent` +
        (piBinary === "pi" ? "" : `, or check that "${piBinary}" is on your PATH.`);
      child.emit("close", 1);
      // Attach the friendly message so waitForReady can surface it
      (child as any)._spawnError = new Error(msg);
    }
  });

  const stderr: string[] = [];
  child.stderr?.on("data", (c: Buffer) => stderr.push(c.toString()));

  return { process: child, stderr, tmpDir: agentDir };
}

// ─── Docker sandbox mode ─────────────────────────────────────────────

const DEFAULT_IMAGE = "pi-mock-sandbox";

/**
 * Ensure the Docker image exists. Builds it if missing.
 * Returns the image name.
 */
export function ensureImage(image: string = DEFAULT_IMAGE): string {
  const inspectResult = spawnSync("docker", ["image", "inspect", image], {
    stdio: "ignore",
  });

  if (inspectResult.status === 0) return image;

  // Build from our Dockerfile
  const dockerfilePath = findDockerfile();
  console.error(`[pi-mock] Building sandbox image "${image}" from ${dockerfilePath}...`);
  const buildResult = spawnSync(
    "docker",
    ["build", "-t", image, dirname(dockerfilePath)],
    { stdio: "inherit" },
  );

  if (buildResult.status !== 0) {
    throw new Error(`Failed to build Docker image "${image}" (exit code ${buildResult.status})`);
  }

  return image;
}

function findDockerfile(): string {
  // Look for Dockerfile relative to this module
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "Dockerfile"),
    resolve(process.cwd(), "Dockerfile"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "[pi-mock] Dockerfile not found. Expected at package root.\n" +
      "  Searched: " +
      candidates.join(", "),
  );
}

export function spawnSandbox(config: SandboxConfig): SpawnResult {
  const image = config.image ?? ensureImage();
  const cwd = resolve(config.cwd ?? process.cwd());

  // Create agent dir with models.json pointing to gateway via Docker host
  const agentDir = createAgentDir(`http://host.docker.internal:${config.gatewayPort}`);

  const dockerArgs: string[] = [
    "run",
    "-i",
    "--rm",
    "--name",
    `pi-mock-${Date.now()}`,
    // Needed for iptables network isolation
    "--cap-add",
    "NET_ADMIN",
    // Linux: make host.docker.internal work
    "--add-host",
    "host.docker.internal:host-gateway",
    // Mount agent dir with models.json (container runs as root)
    "-v",
    `${agentDir}:/root/.pi/agent`,
    // Environment
    "-e",
    `GATEWAY_HOST=host.docker.internal`,
    "-e",
    `GATEWAY_PORT=${config.gatewayPort}`,
    "-e",
    `HTTP_PROXY=http://host.docker.internal:${config.gatewayPort}`,
    "-e",
    `HTTPS_PROXY=http://host.docker.internal:${config.gatewayPort}`,
    "-e",
    `http_proxy=http://host.docker.internal:${config.gatewayPort}`,
    "-e",
    `https_proxy=http://host.docker.internal:${config.gatewayPort}`,
    "-e",
    `ALL_PROXY=http://host.docker.internal:${config.gatewayPort}`,
    // Exclude gateway from proxy — API calls go direct to gateway
    "-e",
    "NO_PROXY=host.docker.internal",
    "-e",
    "no_proxy=host.docker.internal",
    "-e",
    "PI_OFFLINE=1",

    // Mount working directory
    "-v",
    `${cwd}:/work`,
    "-w",
    "/work",
  ];

  // Mount extensions — mount each extension's parent dir so relative imports work
  const extMounts = new Map<string, string>(); // host dir → container dir
  const extArgs: string[] = [];

  for (const ext of config.extensions ?? []) {
    const absExt = resolve(ext);
    const dir = dirname(absExt);
    const file = basename(absExt);

    if (!extMounts.has(dir)) {
      const containerDir = `/ext/${extMounts.size}`;
      extMounts.set(dir, containerDir);
      dockerArgs.push("-v", `${dir}:${containerDir}:ro`);
    }

    const containerPath = `${extMounts.get(dir)}/${file}`;
    extArgs.push("-e", containerPath);
  }

  // Extra env vars
  for (const [k, v] of Object.entries(config.env ?? {})) {
    dockerArgs.push("-e", `${k}=${v}`);
  }

  // Extra volumes
  for (const vol of config.volumes ?? []) {
    dockerArgs.push("-v", vol);
  }

  // Image
  dockerArgs.push(image);

  // Pi command inside container — helper extension loaded first
  const helperExt = getHelperExtensionPath();
  const helperContainerDir = `/ext/helper`;
  dockerArgs.push("-v", `${dirname(helperExt)}:${helperContainerDir}:ro`);

  const provider = config.piProvider ?? "pi-mock";
  const model = config.piModel ?? "mock";

  const piCmd = [
    "pi",
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider",
    provider,
    "--model",
    model,
    ...(config.piArgs ?? []),
    "-e", `${helperContainerDir}/${basename(helperExt)}`,
    ...extArgs,
  ];
  dockerArgs.push(...piCmd);

  const child = spawn("docker", dockerArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr: string[] = [];
  child.stderr?.on("data", (c: Buffer) => stderr.push(c.toString()));

  return { process: child, stderr, tmpDir: agentDir };
}

/**
 * Check if Docker is available.
 */
export function hasDocker(): boolean {
  const result = spawnSync("docker", ["version"], { stdio: "ignore" });
  return result.status === 0;
}
