# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build
- `bun run build`: Build the project using bun build.

### Installation
- `bun i`: Install all dependencies.
- `bun link`: Link the package globally for local development.

### Commands
- `bun run cmd`: Run `bun link` (as defined in package.json).

## Project Structure

- `src/index.ts`: Main entry point for the CLI tool.
- `dist/`: Contains the built output (`index.js`, `index.d.ts`).

The project is a simple CLI tool built with Bun, `@clack/prompts`, and `simple-git` to automate committing and pushing changes in a Git repository.

## Architecture

The CLI tool follows a linear execution flow:
1.  **Initialization**: Sets up a `simple-git` instance targeting the current working directory.
2.  **User Interaction**: Uses `@clack/prompts` to gather user input for:
    - Committing all changes or a specific file/path.
    - Commit title and description.
    - Whether to push to a remote.
3.  **Execution**: Executes Git tasks (staging, committing, and optionally pushing) sequentially within a task-based flow.
4.  **Error Handling**: Handles common Git errors, such as missing upstream branches, by attempting to set up the upstream branch if a remote is available.
