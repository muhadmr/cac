import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactAction, SafetyLevel } from './types';
import { HOME, measurePath } from './scanner';

export interface ProjectEntry {
  agent: string;
  kind: 'local' | 'session';
  label: string;
  absolutePath: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  safetyLevel: SafetyLevel;
  recommendedAction: ArtifactAction;
  lastModified?: Date;
}

export interface ProjectScan {
  project: string;
  entries: ProjectEntry[];
}

interface LocalDefinition {
  agent: string;
  label: string;
  relativePath: string;
}

const LOCAL_DEFINITIONS: LocalDefinition[] = [
  { agent: 'claude', label: 'project settings', relativePath: '.claude/settings.local.json' },
  { agent: 'claude', label: 'project skills', relativePath: '.claude/skills' },
  { agent: 'claude', label: 'project agents', relativePath: '.claude/agents' },
  { agent: 'claude', label: 'project commands', relativePath: '.claude/commands' },
  { agent: 'shared', label: 'shared skills', relativePath: '.agents/skills' },
  { agent: 'shared', label: 'project MCP config', relativePath: '.mcp.json' },
  { agent: 'codex', label: 'codex project dir', relativePath: '.codex' },
  { agent: 'pi', label: 'pi project dir', relativePath: '.pi' },
  { agent: 'omp', label: 'omp project dir', relativePath: '.omp' },
  { agent: 'gemini', label: 'gemini project dir', relativePath: '.gemini' },
  { agent: 'copilot', label: 'copilot project dir', relativePath: '.copilot' },
  { agent: 'cursor', label: 'cursor project dir', relativePath: '.cursor' },
  { agent: 'cursor', label: 'cursor rules', relativePath: '.cursorrules' },
  { agent: 'cline', label: 'cline rules', relativePath: '.clinerules' },
  { agent: 'roo', label: 'roo modes', relativePath: '.roomodes' },
  { agent: 'roo', label: 'roo project dir', relativePath: '.roo' },
  { agent: 'goose', label: 'goose hints', relativePath: '.goosehints' },
  { agent: 'antigravity', label: 'antigravity project dir', relativePath: '.antigravity' },
  { agent: 'kilocode', label: 'kilocode project dir', relativePath: '.kilocode' },
  { agent: 'kilocode', label: 'kilo project dir', relativePath: '.kilo' },
  { agent: 'deepseek', label: 'deepseek project dir', relativePath: '.deepseek' },
  { agent: 'openhands', label: 'openhands project dir', relativePath: '.openhands' },
  { agent: 'hermes', label: 'hermes project dir', relativePath: '.hermes' },
  { agent: 'openclaw', label: 'openclaw project dir', relativePath: '.openclaw' },
  { agent: 'qwen', label: 'qwen project dir', relativePath: '.qwen' },
];

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Claude encodes a project path by replacing each separator with a dash. */
export function projectSlug(projectPath: string): string {
  return path.resolve(projectPath).replace(/[:\\/]/g, '-');
}

/** OMP wraps the same slug in double dashes. */
export function ompSlug(projectPath: string): string {
  return `--${projectSlug(projectPath)}--`;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return isWindows() ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function entryFor(
  agent: string,
  kind: ProjectEntry['kind'],
  label: string,
  absolutePath: string,
): Promise<ProjectEntry> {
  const measured = await measurePath(absolutePath);
  const session = kind === 'session';
  return {
    agent,
    kind,
    label,
    absolutePath,
    exists: measured.fileCount > 0 || measured.sizeBytes > 0,
    sizeBytes: measured.sizeBytes,
    fileCount: measured.fileCount,
    safetyLevel: session ? 'caution' : 'critical',
    recommendedAction: session ? 'clean' : 'keep',
    lastModified: measured.lastModified,
  };
}

async function claudeProjectEntry(projectPath: string, home: string): Promise<ProjectEntry | null> {
  const root = path.join(home, '.claude', 'projects');
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const wanted = projectSlug(projectPath).toLowerCase();
  const match = names.find((name) => name.toLowerCase() === wanted);
  if (!match) return null;
  return entryFor('claude', 'session', 'claude transcripts', path.join(root, match));
}

async function slugSessionEntry(
  agent: string,
  label: string,
  root: string,
  slug: string,
): Promise<ProjectEntry | null> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const wanted = slug.toLowerCase();
  const match = names.find((name) => name.toLowerCase() === wanted);
  if (!match) return null;
  return entryFor(agent, 'session', label, path.join(root, match));
}

/** Read the first line of a file in chunks, without loading the whole file. */
async function readFirstLine(file: string, limit = 4 * 1024 * 1024): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = 0;

    while (position < limit) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;

      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(slice.subarray(0, newline));
        return Buffer.concat(chunks).toString('utf8');
      }

      chunks.push(slice);
      position += bytesRead;
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Extract `payload.cwd` from a rollout header, falling back to a regex scan. */
function rolloutCwd(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { payload?: { cwd?: unknown } };
    if (typeof parsed.payload?.cwd === 'string') return parsed.payload.cwd;
  } catch {
    // header may be truncated or contain a trailing fragment
  }

  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

async function codexProjectEntries(projectPath: string, home: string): Promise<ProjectEntry[]> {
  const root = path.join(home, '.codex', 'sessions');
  const files = await collectJsonl(root, 6);
  const entries: ProjectEntry[] = [];

  for (const file of files) {
    let cwd: string | undefined;
    try {
      cwd = rolloutCwd(await readFirstLine(file));
    } catch {
      continue;
    }
    if (!cwd || !samePath(cwd, projectPath)) continue;

    const measured = await measurePath(file);
    entries.push({
      agent: 'codex',
      kind: 'session',
      label: 'codex rollout',
      absolutePath: file,
      exists: true,
      sizeBytes: measured.sizeBytes,
      fileCount: measured.fileCount,
      safetyLevel: 'caution',
      recommendedAction: 'clean',
      lastModified: measured.lastModified,
    });
  }

  return entries;
}

async function collectJsonl(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJsonl(child, depth - 1)));
    else if (entry.name.endsWith('.jsonl')) files.push(child);
  }
  return files;
}

async function copilotProjectEntries(projectPath: string, home: string): Promise<ProjectEntry[]> {
  const root = path.join(home, '.copilot', 'session-state');
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return [];
  }

  const entries: ProjectEntry[] = [];
  for (const session of sessions) {
    const sessionDir = path.join(root, session);
    let text: string;
    try {
      text = await readFile(path.join(sessionDir, 'workspace.yaml'), 'utf8');
    } catch {
      continue;
    }
    const match = /^cwd:\s*(.+)$/m.exec(text);
    if (!match?.[1] || !samePath(match[1].trim(), projectPath)) continue;

    const measured = await measurePath(sessionDir);
    entries.push({
      agent: 'copilot',
      kind: 'session',
      label: 'copilot session',
      absolutePath: sessionDir,
      exists: true,
      sizeBytes: measured.sizeBytes,
      fileCount: measured.fileCount,
      safetyLevel: 'caution',
      recommendedAction: 'clean',
      lastModified: measured.lastModified,
    });
  }

  return entries;
}

/** List artifacts for one project: local agent files plus per-project home state. */
export async function scanProject(projectPath: string, home = HOME): Promise<ProjectScan> {
  const project = path.resolve(projectPath);
  const entries: ProjectEntry[] = [];

  for (const definition of LOCAL_DEFINITIONS) {
    const absolute = path.join(project, definition.relativePath);
    const entry = await entryFor(definition.agent, 'local', definition.label, absolute);
    if (entry.exists) entries.push(entry);
  }

  const slug = ompSlug(project);
  const single = [
    await claudeProjectEntry(project, home),
    await slugSessionEntry('omp', 'omp sessions', path.join(home, '.omp', 'agent', 'sessions'), slug),
    await slugSessionEntry('pi', 'pi sessions', path.join(home, '.pi', 'agent', 'sessions'), slug),
  ].filter((entry): entry is ProjectEntry => entry !== null);

  entries.push(
    ...single,
    ...(await codexProjectEntries(project, home)),
    ...(await copilotProjectEntries(project, home)),
  );

  return {
    project,
    entries: entries.sort((a, b) => b.sizeBytes - a.sizeBytes),
  };
}
