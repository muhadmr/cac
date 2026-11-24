export type AgentName =
  | 'claude'
  | 'codex'
  | 'pi'
  | 'omp'
  | 'gemini'
  | 'copilot'
  | 'cursor'
  | 'cline'
  | 'roo'
  | 'zed'
  | 'goose'
  | 'antigravity'
  | 'kilocode'
  | 'kimi'
  | 'deepseek'
  | 'hermes'
  | 'openhands'
  | 'openclaw'
  | 'qwen';

export type ArtifactCategory =
  | 'cache'
  | 'log'
  | 'session'
  | 'config'
  | 'storage'
  | 'backup';

export type SafetyLevel = 'safe' | 'caution' | 'critical';

export type ArtifactAction = 'keep' | 'clean';

export interface ArtifactDefinition {
  agent: AgentName;
  category: ArtifactCategory;
  name: string;
  relativePath: string;
  description: string;
  safetyLevel: SafetyLevel;
  recommendedAction: ArtifactAction;
}

export interface ArtifactRecord extends ArtifactDefinition {
  id: string;
  absolutePath: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  lastModified?: Date;
}

export interface McpServerConfig {
  name: string;
  source: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServerStatus {
  name: string;
  source: string;
  type: 'stdio' | 'sse' | 'http';
  available: boolean;
  statusMessage: string;
  latencyMs?: number;
}

export interface CleanOptions {
  dryRun?: boolean;
  categories?: ArtifactCategory[];
  agents?: AgentName[];
  safetyLevels?: SafetyLevel[];
}

export interface CleanResult {
  artifact: ArtifactRecord;
  cleaned: boolean;
  bytesFreed: number;
  error?: string;
}
