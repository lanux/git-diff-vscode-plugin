import type { ExtToWebview } from '../types';
import './api';
import { initMerge, getResultContent, getUnresolvedConflictCount } from './views/mergeView';
import { initCompare, selectCompareFile, showFileDiff } from './views/compareView';
import { vscode } from './api';

window.addEventListener('message', (e) => {
  const msg = e.data as ExtToWebview;
  if (!msg) return;
  if (msg.type === 'init') {
    if (msg.view === 'merge') initMerge(msg);
    else if (msg.view === 'compare') initCompare(msg);
  } else if (msg.type === 'fileDiff') {
    showFileDiff(msg);
  } else if (msg.type === 'selectCompareFile') {
    selectCompareFile(msg.path);
  } else if (msg.type === 'requestResult') {
    vscode.postMessage({
      type: 'finishMerge',
      result: 'RESOLVED',
      outputText: getResultContent(),
      dirty: true,
      unresolvedCount: getUnresolvedConflictCount()
    });
  }
});

vscode.postMessage({ type: 'ready' });
