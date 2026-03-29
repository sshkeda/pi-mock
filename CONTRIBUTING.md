# Contributing

Thanks for your interest in contributing to pi-mock!

## Development

```bash
git clone https://github.com/sshkeda/pi-mock.git
cd pi-mock
npm install
npm run build
```

## Testing

Tests require [pi](https://github.com/mariozechner/pi-mono) to be installed globally:

```bash
npm install -g @mariozechner/pi-coding-agent
```

Run all tests:

```bash
npm test
```

Run individual test suites:

```bash
npm run test:e2e
npm run test:issues
```

## Project Structure

```
src/
├── index.ts        # Public API exports
├── mock.ts         # Core Mock class — orchestrates gateway + pi process
├── gateway.ts      # HTTP/HTTPS proxy + management API server
├── anthropic.ts    # Anthropic SSE serialization + response builders
├── providers.ts    # Multi-provider support (OpenAI, Google, Anthropic)
├── rpc.ts          # RPC client for pi process communication
├── record.ts       # Record & replay infrastructure
├── faults.ts       # Fault injection brain wrappers
├── sandbox.ts      # Docker sandbox spawning + iptables setup
└── cli.ts          # CLI interface
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `npm test` passes
4. Submit a PR with a clear description

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
