import { isImportChange, mergeImportBlocks } from './importResolve';

export interface SemanticMergeResolution {
  lines: string[];
  description?: string;
}

export interface LangSpecificMergeConflictResolver {
  readonly languageId: string;
  canResolve(localLines: readonly string[], baseLines: readonly string[], remoteLines: readonly string[]): boolean;
  resolve(localLines: readonly string[], baseLines: readonly string[], remoteLines: readonly string[]): SemanticMergeResolution | null;
}

const resolvers = new Map<string, LangSpecificMergeConflictResolver>();

const BUILTIN_IMPORT_RESOLVER_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'c',
  'cpp',
  'csharp',
  'rust'
] as const;

function createImportSemanticResolver(languageId: string): LangSpecificMergeConflictResolver {
  return {
    languageId,
    canResolve(localLines, baseLines, remoteLines) {
      return isImportChange(localLines, baseLines, remoteLines);
    },
    resolve(localLines, baseLines, remoteLines) {
      if (!isImportChange(localLines, baseLines, remoteLines)) return null;
      return {
        lines: mergeImportBlocks(localLines, baseLines, remoteLines),
        description: 'Built-in import merge resolver'
      };
    }
  };
}

for (const languageId of BUILTIN_IMPORT_RESOLVER_LANGUAGES) {
  resolvers.set(languageId, createImportSemanticResolver(languageId));
}

export function registerLangSpecificMergeConflictResolver(resolver: LangSpecificMergeConflictResolver): void {
  resolvers.set(resolver.languageId, resolver);
}

export function getLangSpecificMergeConflictResolver(languageId?: string): LangSpecificMergeConflictResolver | undefined {
  if (!languageId) return undefined;
  return resolvers.get(languageId);
}
