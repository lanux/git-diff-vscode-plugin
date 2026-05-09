import * as vscode from 'vscode';

export function renderShell(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const out = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(out, 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(out, 'style.css'));
  const monacoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(out, 'main.css'));
  const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(out, 'codicon.css'));
  const nonce = Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `worker-src blob:`
  ].join('; ');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${monacoCssUri}" />
  <link rel="stylesheet" href="${codiconCssUri}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Git Diff Fast</title>
</head>
<body data-mode="merge">
  <!-- Merge view -->
  <div id="mergeRoot">
    <div class="toolbar">
      <div class="actions-group">
        <button id="prev" class="action-btn" title="Previous conflict (F7) — crosses file boundary" aria-label="Previous conflict"><span class="codicon codicon-arrow-up"></span></button>
        <button id="next" class="action-btn" title="Next conflict (Shift+F7) — crosses file boundary" aria-label="Next conflict"><span class="codicon codicon-arrow-down"></span></button>
        <button id="prevFile" class="action-btn" title="Previous conflicted file" aria-label="Previous file"><span class="codicon codicon-chevron-left"></span></button>
        <button id="nextFile" class="action-btn" title="Next conflicted file" aria-label="Next file"><span class="codicon codicon-chevron-right"></span></button>
        <span id="counter" class="action-label">0 conflicts</span>
      </div>
      <div class="actions-separator"></div>
      <div class="actions-group">
        <button id="applyL" class="action-btn" title="Apply all non-conflicting from Local (Alt+Shift+,)" aria-label="Apply from Local"><span class="codicon codicon-arrow-right"></span></button>
        <button id="applyB" class="action-btn" title="Apply All Non-Conflicts" aria-label="Apply All Non-Conflicts"><span class="codicon codicon-arrow-swap"></span></button>
        <button id="applyR" class="action-btn" title="Apply all non-conflicting from Remote (Alt+Shift+.)" aria-label="Apply from Remote"><span class="codicon codicon-arrow-left"></span></button>
        <button id="magic" class="action-btn" title="Magic Resolve: auto-resolve whitespace-only and pure import conflicts" aria-label="Magic Resolve"><span class="codicon codicon-wand"></span></button>
      </div>
      <div class="actions-separator"></div>
      <div class="actions-group">
        <select id="mergeIgnoreWS" class="action-select" title="Whitespace handling" aria-label="Whitespace handling">
          <option value="none">Do not ignore</option>
          <option value="trim">Trim whitespace</option>
          <option value="inner">Ignore whitespace</option>
          <option value="whole">Ignore all whitespace</option>
        </select>
        <select id="mergeGranularity" class="action-select" title="Intra-line diff granularity" aria-label="Diff granularity">
          <option value="char">Char</option>
          <option value="word">Word</option>
          <option value="line">Line</option>
        </select>
      </div>
      <span id="title" class="action-label file-path-label"></span>
      <span class="spacer"></span>
      <div class="actions-group">
        <button id="acceptLeft" class="action-btn" title="Accept Local Revision (use Local for entire file)" aria-label="Accept Local Revision">L</button>
        <button id="acceptRight" class="action-btn" title="Accept Remote Revision (use Remote for entire file)" aria-label="Accept Remote Revision">R</button>
        <button id="accept" class="action-btn primary" title="Accept Merge" aria-label="Accept Merge"><span class="codicon codicon-check"></span></button>
        <button id="cancel" class="action-btn" title="Cancel" aria-label="Cancel"><span class="codicon codicon-close"></span></button>
      </div>
    </div>
    <div id="mergeBody">
    <div id="panes">
      <div class="pane"><div class="pane-header">Local (Yours)</div><div id="local" class="editor"></div></div>
      <div class="pane"><div class="pane-header">Result</div><div id="result" class="editor"></div></div>
      <div class="pane"><div class="pane-header">Remote (Theirs)</div><div id="remote" class="editor"></div></div>
    </div>
    <div id="ribbonOverlay" class="ribbon-overlay-container"></div>
    </div>
  </div>

  <!-- Compare view -->
  <div id="compareRoot">
    <div class="toolbar">
      <div class="actions-group">
        <button id="cmpRefresh" class="action-btn" title="Refresh" aria-label="Refresh"><span class="codicon codicon-refresh"></span></button>
        <button id="cmpReverse" class="action-btn" title="Reverse sides (current \u21C4 target)" aria-label="Reverse sides"><span class="codicon codicon-arrow-swap"></span></button>
      </div>
      <div class="actions-separator"></div>
      <div class="actions-group">
        <select id="cmpGroupBy" class="action-select" title="Group changes by" aria-label="Group by">
          <option value="dir">Tree</option>
          <option value="flat">Flat</option>
        </select>
      </div>
      <span class="spacer"></span>
      <span id="compareTitle" class="action-label"></span>
      <span class="spacer"></span>
    </div>
    <div id="compareBody">
      <div id="tree"></div>
      <div id="compareDiff"></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
