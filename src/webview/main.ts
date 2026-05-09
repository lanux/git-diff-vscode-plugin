import type { ExtToWebview } from '../types';
import './api';
import { initMerge, getResultContent } from './views/mergeView';
import { initCompare, showFileDiff } from './views/compareView';
import { vscode } from './api';

window.addEventListener('message', (e) => {
  const msg = e.data as ExtToWebview | { type: 'requestResult' };
  if (!msg) return;
  if (msg.type === 'init') {
    if (msg.view === 'merge') initMerge(msg);
    else if (msg.view === 'compare') initCompare(msg);
  } else if (msg.type === 'fileDiff') {
    showFileDiff(msg);
  } else if (msg.type === 'requestResult') {
    vscode.postMessage({ type: 'finishMerge', result: 'RESOLVED', outputText: getResultContent(), dirty: true });
  }
});

vscode.postMessage({ type: 'ready' });
