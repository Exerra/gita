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

When asked whether to stage all changes, choose **No** to pick folders and files
from a tree. Paths are relative to the repository root, even when running Gita
from a subdirectory.

- **↑ / ↓** moves through the tree; **← / →** closes or opens a folder.
- **Space** toggles a file, or all changed files inside a folder (including nested folders).
- Folder counts show selected / changed files. **[x]** means all selected;
  **[-]** means partly selected. Open a selected folder to exclude individual files.
- **a** selects all files, or clears the selection when everything is selected.
- **Enter** continues with the selected files; **Esc / Ctrl+C** cancels.

New folders can be opened to select individual untracked files. Ignored and
unchanged files are excluded from the tree. Selecting a folder stages its exact
listed files.

AI mode overrides (CLI flags take precedence):

```bash
gita --ai
gita --no-ai
```

# Configuration

Global config path:

`~/.config/gita/config.json`

Project config path (AI behavior, knowledge base, and Jira settings):

`.gita/config.json`

Example global config:

```json
{
  "ai": {
    "enabled": true,
    "mode": "ask",
    "temperature": 0.2,
    "maxRetries": 2,
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
    "maxRetries": 2,
    "skipProviderCheck": false
  },
  "knowledgeBase": {
    "enabled": true,
    "paths": [".gita/knowledge"],
    "maxChars": 6000,
    "includeExtensions": [".md", ".txt", ".markdown", ".mdx", ".json", ".yml", ".yaml"]
  }
}
```

AI behavior:

- `always`: always use AI to draft the title/description
- `ask`: prompt with AI default
- `none`: manual commit message prompts
- `skipProviderCheck`: skip the `/models` provider check (some providers do not support this endpoint)
- `maxRetries`: automatic retries after the initial attempt, for both provider checks and commit generation (default: `2`, so up to `3` attempts per operation). Set `0` to disable retries. Project settings override global settings; invalid values retain the inherited or default value. Must be a non-negative safe integer.
- when enabled, the knowledge base content is appended to the AI prompt before diff context

HTTP errors (including authentication and rate limits), network errors, timeouts,
invalid response bodies, and empty or malformed commit JSON all trigger retries.
Retries wait 500ms, then 1s, doubling up to 4s between attempts. JSON inside Markdown
fences or surrounding commentary is accepted when it contains a valid title and
optional description; malformed JSON is never used as a raw commit title.
After either operation exhausts its retries, Gita falls back to the manual flow.
Missing base URL or model settings fall back immediately because retries cannot
resolve missing configuration.

# Jira issue IDs in commit titles

Enable this in either config file (project settings override global settings):

```json
{
  "jira": {
    "enabled": true,
    "template": "%ticket% - %title%"
  }
}
```

On branch `feature/scaffold/AI-100`, a title of `feat: add scaffold` becomes
`AI-100 - feat: add scaffold`. For a suffix, use `"%title% [%ticket%]"`.

- Disabled by default. Enabling it without a template uses `%ticket% - %title%`.
- `%title%` is the title entered or accepted in the prompt, including AI-generated titles.
- `%ticket%` contains uppercase Jira issue IDs found in the branch (such as `AI-100`). Multiple IDs are deduplicated in branch order and joined with `, `.
- Branches without a matching ID, including detached HEAD, keep the original title.
- Templates must be a single line containing both `%ticket%` and `%title%`. Invalid templates produce a warning and retain the inherited or default template.

Formatting happens locally after title input, before the length warning and commit.
The final title is displayed when formatting changes it. The branch, extracted IDs,
and template are not added to the AI request.

# Knowledge base

Gita can include local docs in AI commit prompts. Drop files into `.gita/knowledge` by default.

Settings:

- `enabled`: toggle knowledge base injection
- `paths`: folders to scan (relative to repo root)
- `maxChars`: maximum characters injected into the prompt
- `includeExtensions`: file types to include

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
