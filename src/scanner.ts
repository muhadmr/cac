import { readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  AgentName,
  ArtifactDefinition,
  ArtifactRecord,
} from './types';

const HOME = homedir();

function def(
  agent: AgentName,
  category: ArtifactDefinition['category'],
  name: string,
  relativePath: string,
  description: string,
  safetyLevel: ArtifactDefinition['safetyLevel'],
  recommendedAction: ArtifactDefinition['recommendedAction'],
): ArtifactDefinition {
  return { agent, category, name, relativePath, description, safetyLevel, recommendedAction };
}

/**
 * Known artifact locations. Paths are relative to the user home directory so
 * the inventory stays portable across machines.
 */
export const ARTIFACT_DEFINITIONS: ArtifactDefinition[] = [
  // ---------------------------------------------------------------- Claude --
  def('claude', 'cache', 'cache', '.claude/cache', 'Regenerable tool and command caches', 'safe', 'clean'),
  def('claude', 'cache', 'paste-cache', '.claude/paste-cache', 'Pasted clipboard payloads', 'safe', 'clean'),
  def('claude', 'cache', 'shell-snapshots', '.claude/shell-snapshots', 'Captured shell environments', 'safe', 'clean'),
  def('claude', 'cache', 'statsig', '.claude/statsig', 'Feature flag evaluation cache', 'safe', 'clean'),
  def('claude', 'cache', 'todos', '.claude/todos', 'Per-session todo lists', 'safe', 'clean'),
  def('claude', 'log', 'debug', '.claude/debug', 'Debug logs', 'safe', 'clean'),
  def('claude', 'log', 'history', '.claude/history.jsonl', 'Prompt history', 'caution', 'keep'),
  def('claude', 'backup', 'backups', '.claude/backups', 'Config file backups', 'safe', 'clean'),
  def('claude', 'session', 'file-history', '.claude/file-history', 'Rewind and undo snapshots', 'caution', 'keep'),
  def('claude', 'backup', 'settings-backup', '.claude/settings.json.bak', 'Previous settings file', 'safe', 'clean'),
  def('claude', 'backup', 'root-json-backup', '.claude.json.backup', 'Previous root state file', 'safe', 'clean'),
  def('claude', 'session', 'projects', '.claude/projects', 'Per-project transcripts and state', 'caution', 'keep'),
  def('claude', 'session', 'transcripts', '.claude/transcripts', 'Full conversation transcripts', 'caution', 'keep'),
  def('claude', 'session', 'sessions', '.claude/sessions', 'Session metadata', 'caution', 'keep'),
  def('claude', 'session', 'session-data', '.claude/session-data', 'Session working data', 'caution', 'keep'),
  def('claude', 'session', 'session-env', '.claude/session-env', 'Captured session environment', 'caution', 'keep'),
  def('claude', 'session', 'tasks', '.claude/tasks', 'Background task outputs', 'caution', 'keep'),
  def('claude', 'storage', 'downloads', '.claude/downloads', 'Downloaded packages and assets', 'caution', 'keep'),
  def('claude', 'config', 'settings', '.claude/settings.json', 'Global settings', 'critical', 'keep'),
  def('claude', 'config', 'root-json', '.claude.json', 'Global state, MCP servers, project history', 'critical', 'keep'),
  def('claude', 'config', 'skills', '.claude/skills', 'Installed skills', 'critical', 'keep'),
  def('claude', 'config', 'plugins', '.claude/plugins', 'Installed plugins', 'critical', 'keep'),
  def('claude', 'config', 'agents', '.claude/agents', 'Custom agent definitions', 'critical', 'keep'),
  def('claude', 'config', 'hooks', '.claude/hooks', 'Hook scripts', 'critical', 'keep'),

  // ----------------------------------------------------------------- Codex --
  def('codex', 'cache', 'cache', '.codex/cache', 'Regenerable caches', 'safe', 'clean'),
  def('codex', 'cache', 'tmp', '.codex/tmp', 'Scratch files', 'safe', 'clean'),
  def('codex', 'cache', 'dot-tmp', '.codex/.tmp', 'Scratch files', 'safe', 'clean'),
  def('codex', 'cache', 'models-cache', '.codex/models_cache.json', 'Model list cache', 'safe', 'clean'),
  def('codex', 'log', 'log', '.codex/log', 'Runtime logs', 'safe', 'clean'),
  def('codex', 'log', 'sandbox-logs', '.codex/sandbox.*.log', 'Legacy sandbox logs', 'safe', 'clean'),
  def('codex', 'log', 'sandbox-log-dir', '.codex/.sandbox', 'Current sandbox logs', 'safe', 'clean'),
  def('codex', 'storage', 'sandbox-bin', '.codex/.sandbox-bin', 'Sandbox helper executables', 'caution', 'keep'),
  def('codex', 'log', 'logs-db', '.codex/logs_2.sqlite', 'Log database', 'caution', 'clean'),
  def('codex', 'backup', 'global-state-backup', '.codex/.codex-global-state.json.bak', 'Previous global state', 'safe', 'clean'),
  def('codex', 'backup', 'config-backup', '.codex/config.toml.bak', 'Previous config', 'safe', 'clean'),
  def('codex', 'backup', 'config-backup-dated', '.codex/config.toml.before-skill-filter-*.bak', 'Dated config snapshots', 'safe', 'clean'),
  def('codex', 'session', 'sessions', '.codex/sessions', 'Conversation rollouts', 'caution', 'keep'),
  def('codex', 'session', 'history', '.codex/history.jsonl', 'Prompt history', 'caution', 'keep'),
  def('codex', 'session', 'session-index', '.codex/session_index.jsonl', 'Session index', 'caution', 'keep'),
  def('codex', 'storage', 'state-db', '.codex/state_5.sqlite', 'App state database', 'caution', 'keep'),
  def('codex', 'storage', 'goals-db', '.codex/goals_1.sqlite', 'Goals database', 'caution', 'keep'),
  def('codex', 'storage', 'memories-db', '.codex/memories_1.sqlite', 'Memories database', 'caution', 'keep'),
  def('codex', 'storage', 'thread-history-db', '.codex/thread_history_1.sqlite', 'Thread history database', 'caution', 'keep'),
  def('codex', 'storage', 'generated-images', '.codex/generated_images', 'Generated image output', 'caution', 'keep'),
  def('codex', 'storage', 'packages', '.codex/packages', 'Downloaded runtimes and packages', 'caution', 'keep'),
  def('codex', 'config', 'config', '.codex/config.toml', 'Main config and MCP servers', 'critical', 'keep'),
  def('codex', 'config', 'auth', '.codex/auth.json', 'Credentials', 'critical', 'keep'),
  def('codex', 'config', 'skills', '.codex/skills', 'Installed skills', 'critical', 'keep'),
  def('codex', 'config', 'plugins', '.codex/plugins', 'Installed plugins', 'critical', 'keep'),

  // -------------------------------------------------------------------- Pi --
  def('pi', 'cache', 'cache', '.pi/agent/cache', 'Regenerable caches', 'safe', 'clean'),
  def('pi', 'cache', 'models-store', '.pi/agent/models-store.json', 'Model catalog cache', 'safe', 'clean'),
  def('pi', 'cache', 'git', '.pi/agent/git', 'Cloned helper repositories', 'safe', 'clean'),
  def('pi', 'cache', 'tool-output-artifacts', '.pi/agent/tool-output-artifacts', 'Spilled tool output', 'safe', 'clean'),
  def('pi', 'session', 'sessions', '.pi/agent/sessions', 'Conversation sessions', 'caution', 'keep'),
  def('pi', 'storage', 'bin', '.pi/agent/bin', 'Downloaded tool binaries', 'caution', 'keep'),
  def('pi', 'config', 'mcp', '.pi/agent/mcp.json', 'MCP server list', 'critical', 'keep'),
  def('pi', 'config', 'settings', '.pi/agent/settings.json', 'Agent settings', 'critical', 'keep'),
  def('pi', 'config', 'auth', '.pi/agent/auth.json', 'Credentials', 'critical', 'keep'),
  def('pi', 'config', 'skills', '.pi/agent/skills', 'Installed skills', 'critical', 'keep'),

  // ------------------------------------------------------------------- OMP --
  def('omp', 'cache', 'cache', '.omp/cache', 'Regenerable caches', 'safe', 'clean'),
  def('omp', 'cache', 'webcache', '.omp/webcache', 'Fetched web page cache', 'safe', 'clean'),
  def('omp', 'cache', 'puppeteer', '.omp/puppeteer', 'Puppeteer browser profile', 'safe', 'clean'),
  def('omp', 'cache', 'skill-descriptions-db', '.omp/agent/skill-descriptions.db', 'Derived skill index', 'safe', 'clean'),
  def('omp', 'cache', 'predict', '.omp/agent/predict', 'Prediction data', 'safe', 'clean'),
  def('omp', 'cache', 'agent-cache', '.omp/agent/cache', 'Regenerable caches', 'safe', 'clean'),
  def('omp', 'log', 'logs', '.omp/logs', 'Runtime logs', 'safe', 'clean'),
  def('omp', 'backup', 'settings-backup', '.omp/agent/settings.json.bak', 'Previous settings', 'safe', 'clean'),
  def('omp', 'session', 'sessions', '.omp/agent/sessions', 'Conversation sessions', 'caution', 'keep'),
  def('omp', 'session', 'terminal-sessions', '.omp/agent/terminal-sessions', 'Persisted terminals', 'caution', 'keep'),
  def('omp', 'storage', 'agent-db', '.omp/agent/agent.db', 'Agent runtime database', 'caution', 'keep'),
  def('omp', 'storage', 'history-db', '.omp/agent/history.db', 'Conversation history database', 'caution', 'keep'),
  def('omp', 'storage', 'models-db', '.omp/agent/models.db', 'Model registry cache', 'caution', 'keep'),
  def('omp', 'storage', 'blobs', '.omp/agent/blobs', 'Stored binary payloads', 'caution', 'keep'),
  def('omp', 'storage', 'memories', '.omp/agent/memories', 'Learned project memories', 'caution', 'keep'),
  def('omp', 'storage', 'stats-db', '.omp/stats.db', 'Usage statistics', 'caution', 'keep'),
  def('omp', 'storage', 'autoqa-db', '.omp/autoqa.db', 'Self-check records', 'caution', 'keep'),
  def('omp', 'storage', 'natives', '.omp/natives', 'Downloaded native modules', 'caution', 'keep'),
  def('omp', 'config', 'settings', '.omp/agent/settings.json', 'Agent settings', 'critical', 'keep'),
  def('omp', 'config', 'config', '.omp/agent/config.yml', 'Agent config', 'critical', 'keep'),
  def('omp', 'config', 'skills', '.omp/agent/skills', 'Installed skills', 'critical', 'keep'),

  // ---------------------------------------------------------------- Gemini --
  def('gemini', 'cache', 'tmp', '.gemini/tmp', 'Scratch files', 'safe', 'clean'),
  def('gemini', 'cache', 'browser-profile', '.gemini/antigravity-browser-profile', 'Browser automation profile', 'safe', 'clean'),
  def('gemini', 'session', 'history', '.gemini/history', 'Conversation history', 'caution', 'keep'),
  def('gemini', 'storage', 'config', '.gemini/config', 'Runtime data', 'caution', 'keep'),
  def('gemini', 'storage', 'antigravity', '.gemini/antigravity', 'Antigravity runtime data', 'caution', 'keep'),
  def('gemini', 'storage', 'antigravity-cli', '.gemini/antigravity-cli', 'Antigravity CLI install', 'caution', 'keep'),
  def('gemini', 'config', 'settings', '.gemini/settings.json', 'Settings', 'critical', 'keep'),
  def('gemini', 'config', 'oauth', '.gemini/oauth_creds.json', 'Credentials', 'critical', 'keep'),
  def('gemini', 'config', 'skills', '.gemini/skills', 'Installed skills', 'critical', 'keep'),

  // --------------------------------------------------------------- Copilot --
  def('copilot', 'log', 'logs', '.copilot/logs', 'Runtime logs', 'safe', 'clean'),
  def('copilot', 'session', 'session-state', '.copilot/session-state', 'Session state', 'caution', 'keep'),
  def('copilot', 'session', 'command-history', '.copilot/command-history-state.json', 'Command history', 'caution', 'keep'),
  def('copilot', 'storage', 'session-store', '.copilot/session-store.db', 'Session database', 'caution', 'keep'),
  def('copilot', 'config', 'mcp-config', '.copilot/mcp-config.json', 'MCP server list', 'critical', 'keep'),
  def('copilot', 'config', 'settings', '.copilot/settings.json', 'Settings', 'critical', 'keep'),
  def('copilot', 'config', 'skills', '.copilot/skills', 'Installed skills', 'critical', 'keep'),
  // --------------------------------------------------------------- Cursor --
  def('cursor', 'cache', 'cache', 'AppData/Roaming/Cursor/Cache', 'Editor webview cache', 'safe', 'clean'),
  def('cursor', 'cache', 'code-cache', 'AppData/Roaming/Cursor/Code Cache', 'Compiled script cache', 'safe', 'clean'),
  def('cursor', 'log', 'logs', 'AppData/Roaming/Cursor/logs', 'Editor and agent logs', 'safe', 'clean'),
  def('cursor', 'session', 'workspace-storage', 'AppData/Roaming/Cursor/User/workspaceStorage', 'Chat trajectories and workspace state', 'caution', 'keep'),
  def('cursor', 'config', 'mcp', '.cursor/mcp.json', 'MCP server definitions', 'critical', 'keep'),
  def('cursor', 'config', 'skills', '.cursor/skills', 'Cursor skills', 'critical', 'keep'),

  // ---------------------------------------------------------------- Cline --
  def('cline', 'cache', 'cache', 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/cache', 'Model and prompt caches', 'safe', 'clean'),
  def('cline', 'session', 'tasks', 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/tasks', 'Task trajectories and screenshots', 'caution', 'keep'),
  def('cline', 'session', 'checkpoints', 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/checkpoints', 'Git diff rewind snapshots', 'caution', 'keep'),
  def('cline', 'config', 'mcp-settings', 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json', 'MCP server settings', 'critical', 'keep'),

  // ------------------------------------------------------------- Roo Code --
  def('roo', 'cache', 'cache', 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/cache', 'Model response cache', 'safe', 'clean'),
  def('roo', 'session', 'tasks', 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks', 'Task trajectories and tool outputs', 'caution', 'keep'),
  def('roo', 'session', 'checkpoints', 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/checkpoints', 'Shadow repository diff snapshots', 'caution', 'keep'),
  def('roo', 'config', 'mcp-settings', 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json', 'MCP server definitions', 'critical', 'keep'),
  def('roo', 'config', 'custom-modes', 'AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/custom_modes.json', 'Custom mode definitions', 'critical', 'keep'),

  // ------------------------------------------------------------------ Zed --
  def('zed', 'log', 'logs', 'AppData/Local/Zed/logs', 'Runtime editor and agent logs', 'safe', 'clean'),
  def('zed', 'log', 'hang-traces', 'AppData/Local/Zed/hang_traces', 'Hang and crash trace dumps', 'safe', 'clean'),
  def('zed', 'session', 'threads', 'AppData/Local/Zed/threads', 'Agent conversation threads', 'caution', 'keep'),
  def('zed', 'storage', 'languages', 'AppData/Local/Zed/languages', 'Installed language servers and LSPs', 'caution', 'keep'),
  def('zed', 'storage', 'external-agents', 'AppData/Local/Zed/external_agents', 'Downloaded agent binaries', 'caution', 'keep'),
  def('zed', 'storage', 'node', 'AppData/Local/Zed/node', 'Node runtime binaries', 'caution', 'keep'),
  def('zed', 'storage', 'extensions', 'AppData/Local/Zed/extensions', 'Installed extensions and plugins', 'caution', 'keep'),
  def('zed', 'storage', 'db', 'AppData/Local/Zed/db', 'Editor SQLite index database', 'caution', 'keep'),
  def('zed', 'config', 'settings-roaming', 'AppData/Roaming/Zed/settings.json', 'User settings', 'critical', 'keep'),
  def('zed', 'config', 'settings-config', '.config/zed/settings.json', 'User settings', 'critical', 'keep'),

  // ---------------------------------------------------------------- Goose --
  def('goose', 'cache', 'cache', 'AppData/Roaming/Goose/Cache', 'Application cache', 'safe', 'clean'),
  def('goose', 'cache', 'code-cache', 'AppData/Roaming/Goose/Code Cache', 'Compiled script cache', 'safe', 'clean'),
  def('goose', 'cache', 'blob-storage', 'AppData/Roaming/Goose/blob_storage', 'Binary payload cache', 'safe', 'clean'),
  def('goose', 'log', 'logs', 'AppData/Roaming/Goose/logs', 'Execution trace logs', 'safe', 'clean'),
  def('goose', 'session', 'sessions', 'AppData/Roaming/Goose/sessions', 'Agent task rollouts and history', 'caution', 'keep'),
  def('goose', 'config', 'settings', 'AppData/Roaming/Goose/settings.json', 'Model, tool, and MCP settings', 'critical', 'keep'),

  // ---------------------------------------------------------- Antigravity --
  def('antigravity', 'storage', 'extensions', '.antigravity/extensions', 'Installed agent extensions', 'caution', 'keep'),
  def('antigravity', 'config', 'skills', '.antigravity/skills', 'Installed agent skills', 'critical', 'keep'),
  def('antigravity', 'config', 'argv', '.antigravity/argv.json', 'Runtime launch arguments', 'critical', 'keep'),

  // ------------------------------------------------------------- Kilocode --
  def('kilocode', 'session', 'workspace-storage', '.kilocode/workspaceStorage', 'Workspace AST indexes and chat history', 'caution', 'keep'),
  def('kilocode', 'storage', 'global-storage', '.kilocode/globalStorage', 'Models and extension state', 'caution', 'keep'),
  def('kilocode', 'storage', 'node-modules', '.kilocode/node_modules', 'Tool dependencies', 'caution', 'keep'),
  def('kilocode', 'config', 'skills', '.kilocode/skills', 'Installed skills', 'critical', 'keep'),
  def('kilocode', 'storage', 'kilo-modules', '.kilo/node_modules', 'Kilo dependencies', 'caution', 'keep'),
  def('kilocode', 'config', 'kilo-skills', '.kilo/skills', 'Kilo skills', 'critical', 'keep'),
  def('kilocode', 'session', 'code-storage', 'AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code', 'Kilocode VSCode extension state', 'caution', 'keep'),

  // ----------------------------------------------------------------- Kimi --
  def('kimi', 'cache', 'cache', '.kimi/cache', 'Web fetch and context cache', 'safe', 'clean'),
  def('kimi', 'session', 'history', '.kimi/history', 'Prompt history and sessions', 'caution', 'keep'),
  def('kimi', 'config', 'config', '.kimi/config.toml', 'Configuration and credentials', 'critical', 'keep'),

  // ------------------------------------------------------------- DeepSeek --
  def('deepseek', 'cache', 'cache', '.deepseek/cache', 'Tokenizer and KV caches', 'safe', 'clean'),
  def('deepseek', 'log', 'logs', '.deepseek/logs', 'Evaluation and tool call logs', 'safe', 'clean'),
  def('deepseek', 'session', 'runs', '.deepseek/runs', 'Evaluation trajectory runs', 'caution', 'keep'),
  def('deepseek', 'config', 'config', '.deepseek/config.json', 'Model configuration', 'critical', 'keep'),

  // ------------------------------------------------------------ OpenHands --
  def('openhands', 'log', 'logs', '.openhands/logs', 'Container runtime and agent logs', 'safe', 'clean'),
  def('openhands', 'cache', 'cache', '.openhands/cache', 'Repository embeddings and cache', 'safe', 'clean'),
  def('openhands', 'session', 'sessions', '.openhands/sessions', 'Workspace conversation checkpoints', 'caution', 'keep'),
  def('openhands', 'config', 'config', '.openhands/config.toml', 'Sandbox security policies and keys', 'critical', 'keep'),

  // --------------------------------------------------------------- Hermes --
  def('hermes', 'cache', 'cache', '.hermes/cache', 'Function definition and context cache', 'safe', 'clean'),
  def('hermes', 'session', 'trajectories', '.hermes/trajectories', 'Function call trajectories', 'caution', 'keep'),
  def('hermes', 'config', 'tools', '.hermes/tools', 'Dynamic tool definitions', 'critical', 'keep'),

  // ------------------------------------------------------------- OpenClaw --
  def('openclaw', 'cache', 'cache', '.openclaw/cache', 'Temporary scrapes and selector maps', 'safe', 'clean'),
  def('openclaw', 'session', 'sessions', '.openclaw/sessions', 'Task runs and crawling logs', 'caution', 'keep'),
  def('openclaw', 'config', 'config', '.openclaw/config.json', 'Crawler configuration', 'critical', 'keep'),

  // ------------------------------------------------------------ Qwen Code --
  def('qwen', 'cache', 'cache', '.qwen/cache', 'Response and vector cache', 'safe', 'clean'),
  def('qwen', 'log', 'logs', '.qwen/logs', 'Tool dispatch logs', 'safe', 'clean'),
  def('qwen', 'session', 'workspace', '.qwen/workspace', 'Sandbox code outputs', 'caution', 'keep'),
  def('qwen', 'config', 'config', '.qwen/config.yaml', 'Agent credentials and definitions', 'critical', 'keep'),
];

/** Artifact id, stable across runs and unique per definition. */
function artifactId(d: ArtifactDefinition): string {
  return `${d.agent}:${d.category}:${d.name}`;
}

interface Measured {
  sizeBytes: number;
  fileCount: number;
  lastModified?: Date;
}

const MAX_DEPTH = 16;

export async function measurePath(target: string, depth = 0): Promise<Measured> {
  if (depth > MAX_DEPTH) return { sizeBytes: 0, fileCount: 0 };

  let stat;
  try {
    stat = await lstat(target);
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }

  if (!stat.isDirectory()) {
    return {
      sizeBytes: stat.size,
      fileCount: 1,
      lastModified: stat.mtime,
    };
  }

  const result: Measured = { sizeBytes: 0, fileCount: 0, lastModified: stat.mtime };
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const child = path.join(target, entry.name);
    let childStat;
    try {
      childStat = await lstat(child);
    } catch {
      continue;
    }
    if (childStat.isSymbolicLink()) continue;

    const sub = await measurePath(child, depth + 1);
    result.sizeBytes += sub.sizeBytes;
    result.fileCount += sub.fileCount;
    if (sub.lastModified && (!result.lastModified || sub.lastModified > result.lastModified)) {
      result.lastModified = sub.lastModified;
    }
  }

  return result;
}

/** Expand a glob-free definition path that may contain a `*` segment. */
async function expandPath(relativePath: string): Promise<string[]> {
  const absolute = path.join(HOME, relativePath);
  if (!relativePath.includes('*')) return [absolute];

  const dir = path.dirname(absolute);
  const pattern = path.basename(absolute);
  if (!/^[^*]*\*[^*]*$/.test(pattern)) return [];

  const prefix = pattern.slice(0, pattern.indexOf('*'));
  const suffix = pattern.slice(pattern.lastIndexOf('*') + 1);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(dir, name));
}

export interface ScanFilter {
  agents?: AgentName[];
  categories?: ArtifactDefinition['category'][];
}

export async function scanArtifacts(filter: ScanFilter = {}): Promise<ArtifactRecord[]> {
  const definitions = ARTIFACT_DEFINITIONS.filter((d) => {
    if (filter.agents && !filter.agents.includes(d.agent)) return false;
    if (filter.categories && !filter.categories.includes(d.category)) return false;
    return true;
  });

  const records: ArtifactRecord[] = [];

  for (const definition of definitions) {
    const candidates = await expandPath(definition.relativePath);
    if (candidates.length === 0) {
      records.push(emptyRecord(definition, path.join(HOME, definition.relativePath)));
      continue;
    }

    for (const absolutePath of candidates) {
      const measured = await measurePath(absolutePath);
      records.push({
        ...definition,
        id: artifactId(definition),
        absolutePath,
        exists: measured.fileCount > 0 || measured.sizeBytes > 0,
        sizeBytes: measured.sizeBytes,
        fileCount: measured.fileCount,
        lastModified: measured.lastModified,
      });
    }
  }

  return records.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function emptyRecord(definition: ArtifactDefinition, absolutePath: string): ArtifactRecord {
  return {
    ...definition,
    id: artifactId(definition),
    absolutePath,
    exists: false,
    sizeBytes: 0,
    fileCount: 0,
  };
}

export function agentTotal(records: ArtifactRecord[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const record of records) {
    totals[record.agent] = (totals[record.agent] ?? 0) + record.sizeBytes;
  }
  return totals;
}

export { HOME };
