# Git Diff Fast

Fast three-way merge conflict resolver and branch compare tool for VS Code.

## Features

- **Three-way merge**: Local | Result | Remote three-pane view for intuitive Git conflict resolution
- **Branch compare**: Compare file diffs between any branch/tag/commit with editing support
- **Synchronized scrolling**: Monaco editors aligned vertically
- **Visual highlights**: Auto-merge, conflict, and resolved blocks in distinct colors
- **Conflict navigation**: F7 / Shift+F7 quick jump between conflicts
- **Magic resolve**: Auto-handle whitespace-only and import-only conflicts
- **Intra-line diff**: Char / Word / Line granularity options
- **Auto-stage**: Accept writes to disk and runs `git add`

## Quick Start

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Test
npm test

# Package VSIX
npm run build
```

Press **F5** to launch the Extension Development Host for debugging.

## Documentation

See [docs/usage-guide.md](docs/usage-guide.md) for detailed usage instructions.

## Architecture

```
┌─ Extension Host (Node) ────────┐         ┌─ Webview ──────────────────────┐
│ src/extension.ts               │         │ src/webview/main.ts            │
│  ├─ MergePanel (WebviewPanel)  │ msg ◄──►│  ├─ Monaco editors             │
│  ├─ BranchComparePanel          │ post   │  ├─ Sync scroll                │
│  ├─ Git commands                │         │  ├─ Gutter actions             │
│  └─ Diff engine                 │         │  └─ Conflict navigation        │
└────────────────────────────────┘         └────────────────────────────────┘
```

## License

[Apache-2.0](LICENSE)
