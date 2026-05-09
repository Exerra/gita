# Gita

A Bun-first CLI for commit + push workflows with optional AI-assisted commit messages.

# Requirements

- [Bun](https://bun.sh)

# Install

Install dependencies and link the CLI.

```bash
bun install
bun link
```

# Usage

Run inside a git repository.

```bash
gita
```

AI mode overrides (CLI flags take precedence):

```bash
gita --ai
gita --no-ai
```

# Configuration

Global config path:

`~/.config/gita/config.json`

Project config path (temperature, enabled, mode only):

`.gita/config.json`

Example global config:

```json
{
  "ai": {
    "enabled": true,
    "mode": "ask",
    "temperature": 0.2,
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "skipProviderCheck": false,
    "apiKey": "YOUR_API_KEY"
  }
}
```

Example project config (safe subset):

```json
{
  "ai": {
    "enabled": true,
    "mode": "always",
    "temperature": 0.1,
    "skipProviderCheck": false
  }
}
```

AI behavior:

- `always`: always use AI to draft the title/description
- `ask`: prompt with AI default
- `none`: manual commit message prompts
- `skipProviderCheck`: skip the `/models` provider check (some providers do not support this endpoint)

If the AI provider check fails, Gita falls back to the manual flow.

# Environment variables

These are optional and can replace config values:

- `GITA_AI_API_KEY` or `OPENAI_API_KEY`
- `GITA_AI_MODEL` or `OPENAI_MODEL`
- `GITA_AI_BASE_URL` or `OPENAI_BASE_URL`

# Bun-first design

Gita prefers Bun built-ins for core runtime behavior:

- `Bun.file(...)` for file reads
- `fetch(...)` for network calls
- `import.meta.dir` for module paths
- `Bun.argv` for CLI arguments
- `Bun.env` for environment variables

References:

- https://bun.sh/docs/runtime/bun-apis#bunfile
- https://bun.sh/docs/runtime/networking/fetch
- https://bun.sh/docs/runtime/module-resolution#importmeta
- https://bun.sh/docs/guides/process/argv
- https://bun.sh/docs/runtime/environment-variables
