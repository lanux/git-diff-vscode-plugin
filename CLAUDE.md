# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VSCode extension project (name TBD). When adding files, ensure all TypeScript source lives in `src/` with proper tsconfig configuration.

## Commands

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run tests
npm test

# Build VSIX package
npm run build
```

## Architecture

- `src/` — TypeScript source code
- `test/` — Test files
- `out/` — Compiled JavaScript output
