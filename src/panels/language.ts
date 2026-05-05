import * as path from 'path';

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.json': 'json', '.md': 'markdown', '.py': 'python', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.c': 'c', '.cpp': 'cpp', '.h': 'cpp',
    '.cs': 'csharp', '.css': 'css', '.scss': 'scss', '.html': 'html', '.xml': 'xml',
    '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'shell', '.sql': 'sql', '.vue': 'html'
  };
  return map[ext] ?? 'plaintext';
}
