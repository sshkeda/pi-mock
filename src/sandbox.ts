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

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { resolve, basename, dirname, join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface SandboxConfig {
  /** Gateway port on the host. */
  gatewayPort: number;
  /** Extension file paths to load. */
  extensions?: string[];
  /** Working directory for pi inside the container. */
  cwd?: string;
  /** Extra CLI args for pi. */
  piArgs?: string[];
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

  // Only define the pi-mock provider for the primary pi process.
  // All other providers keep their real hostnames and API keys.
  // The gateway intercepts them at the HTTPS proxy level via MITM —
  // the sandbox talks to real hostnames, TLS validates via our CA cert,
  // and the gateway serves brain responses in the correct provider format.
  const modelsJson = {
    providers: {
      "pi-mock": {
        baseUrl: `${gatewayUrl}/v1`,
        api: "anthropic-messages",
        apiKey: "mock-key",
        models: [{ id: "mock", name: "pi-mock" }],
      },
    },
  };

  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));
  writeFileSync(join(dir, "settings.json"), "{}");
  return dir;
}

// ─── Local mode (no Docker) ──────────────────────────────────────────

export function spawnLocal(config: SandboxConfig): SpawnResult {
  const agentDir = createAgentDir(`http://127.0.0.1:${config.gatewayPort}`);

  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider",
    "pi-mock",
    "--model",
    "mock",
    ...(config.piArgs ?? []),
  ];

  for (const ext of config.extensions ?? []) {
    args.push("-e", resolve(ext));
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
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

  const child = spawn(config.piBinary ?? "pi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: config.cwd ?? process.cwd(),
    env,
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
  try {
    execSync(`docker image inspect ${image} > /dev/null 2>&1`, { stdio: "ignore" });
    return image;
  } catch {
    // Build from our Dockerfile
    const dockerfilePath = findDockerfile();
    console.error(`[pi-mock] Building sandbox image "${image}" from ${dockerfilePath}...`);
    execSync(`docker build -t ${image} ${dirname(dockerfilePath)}`, { stdio: "inherit" });
    return image;
  }
}

function findDockerfile(): string {
  // Look for Dockerfile relative to this module
  const candidates = [
    resolve(dirname(new URL(import.meta.url).pathname), "..", "Dockerfile"),
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
    // Mount agent dir with models.json
    "-v",
    `${agentDir}:/home/node/.pi/agent`,
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
    "-e",
    "NODE_TLS_REJECT_UNAUTHORIZED=0",
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

  // Pi command inside container
  const piCmd = [
    "pi",
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider",
    "pi-mock",
    "--model",
    "mock",
    ...(config.piArgs ?? []),
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
  try {
    execSync("docker version > /dev/null 2>&1", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
