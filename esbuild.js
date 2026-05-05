const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'out/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: !production,
  minify: production,
  loader: { '.ttf': 'file' },
  logLevel: 'info'
};

const testConfig = {
  entryPoints: ['test/merge.test.ts'],
  bundle: true,
  outfile: 'out/test/merge.test.js',
  external: ['mocha', 'vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info'
};

function copyWebviewStatic() {
  const outDir = path.join('out', 'webview');
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync('src/webview/index.html', path.join(outDir, 'index.html'));
  fs.copyFileSync('src/webview/style.css', path.join(outDir, 'style.css'));
  fs.copyFileSync('node_modules/@vscode/codicons/dist/codicon.css', path.join(outDir, 'codicon.css'));
  fs.copyFileSync('node_modules/@vscode/codicons/dist/codicon.ttf', path.join(outDir, 'codicon.ttf'));
}

// esbuild emits monaco's CSS as out/webview/main.css automatically (matches the .js outfile).

async function run() {
  copyWebviewStatic();
  if (watch) {
    const ctxs = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig)
    ]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('watching...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(testConfig).catch(() => {})
    ]);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
