import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { AgentName } from './types';
import { HOME } from './scanner';

export type SkillScope = 'global' | AgentName | 'project';

export interface SkillIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface SkillRecord {
  name: string;
  declaredName?: string;
  description?: string;
  scope: SkillScope;
  /** Directory the agent scans for this skill. */
  rootDir: string;
  directory: string;
  skillFile: string;
  isSymlink: boolean;
  linkTarget?: string;
  /** True when the skill sits in the `-disabled` stash beside its root. */
  stashed: boolean;
  /** `plugin@marketplace` when the skill ships inside an installed plugin. */
  pluginKey?: string;
  enabled: boolean;
  toggleMechanism?: string;
  issues: SkillIssue[];
}

interface SkillRoot {
  scope: SkillScope;
  dir: string;
  stashed?: boolean;
  origin?: string;
  pluginKey?: string;
}

const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Depth-limited search for directories with a fixed name, e.g. plugin `skills` folders. */
async function collectNamedDirs(root: string, name: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  let level = [root];

  for (let current = 0; current <= depth; current += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const child = path.join(dir, entry.name);
        if (entry.name === name) found.push(child);
        else next.push(child);
      }
    }
    level = next;
  }

  return found;
}

async function skillRoots(cwd: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [
    { scope: 'global', dir: path.join(HOME, '.agents', 'skills') },
    { scope: 'claude', dir: path.join(HOME, '.claude', 'skills') },
    { scope: 'codex', dir: path.join(HOME, '.codex', 'skills') },
    { scope: 'codex', dir: path.join(HOME, '.agents', 'skills') },
    { scope: 'pi', dir: path.join(HOME, '.pi', 'agent', 'skills') },
    { scope: 'omp', dir: path.join(HOME, '.omp', 'agent', 'skills') },
    { scope: 'omp', dir: path.join(HOME, '.omp', 'agent', 'managed-skills') },
    { scope: 'gemini', dir: path.join(HOME, '.gemini', 'skills') },
    { scope: 'copilot', dir: path.join(HOME, '.copilot', 'skills') },
    { scope: 'antigravity', dir: path.join(HOME, '.antigravity', 'skills') },
    { scope: 'kilocode', dir: path.join(HOME, '.kilocode', 'skills') },
    { scope: 'kilocode', dir: path.join(HOME, '.kilo', 'skills') },
    { scope: 'cursor', dir: path.join(HOME, '.cursor', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.claude', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.agents', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.codex', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.omp', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.gemini', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.copilot', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.cursor', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.antigravity', 'skills') },
    { scope: 'project', dir: path.join(cwd, '.kilocode', 'skills') },
  ];

  for (const pluginSkills of await collectNamedDirs(
    path.join(HOME, '.codex', 'plugins', 'cache'),
    'skills',
    3,
  )) {
    roots.push({ scope: 'codex', dir: pluginSkills });
  }

  const claudeCache = path.join(HOME, '.claude', 'plugins', 'cache');
  for (const pluginSkills of await collectNamedDirs(claudeCache, 'skills', 3)) {
    const relative = path.relative(claudeCache, pluginSkills).split(path.sep);
    const marketplace = relative[0];
    const plugin = relative[1];
    roots.push({
      scope: 'claude',
      dir: pluginSkills,
      pluginKey: marketplace && plugin ? `${plugin}@${marketplace}` : undefined,
    });
  }

  const configToggleScopes: SkillScope[] = ['codex'];
  const stashes = roots
    .filter((root) => !configToggleScopes.includes(root.scope) && !root.pluginKey)
    .map((root) => ({
      scope: root.scope,
      dir: path.join(path.dirname(root.dir), `${path.basename(root.dir)}-disabled`),
      stashed: true,
      origin: root.dir,
    }));

  return [...roots, ...stashes];
}

/** Read a top-level `key: value` map from SKILL.md frontmatter. */
function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }

  return { fields, body: text.slice(match[0].length) };
}

export function validateSkill(
  name: string,
  text: string | null,
  isBroken: boolean,
): { declaredName?: string; description?: string; issues: SkillIssue[] } {
  const issues: SkillIssue[] = [];

  if (isBroken) {
    return { issues: [{ severity: 'error', message: 'broken symlink' }] };
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    issues.push({ severity: 'warning', message: 'directory name should be lowercase kebab-case' });
  }

  if (text === null) {
    return { issues: [...issues, { severity: 'error', message: 'SKILL.md is missing or unreadable' }] };
  }

  const parsed = parseFrontmatter(text);
  if (!parsed) {
    const escaped = /^\\---/.test(text);
    return {
      issues: [
        ...issues,
        {
          severity: 'error',
          message: escaped
            ? 'frontmatter delimiters are escaped with a leading backslash'
            : 'missing frontmatter block',
        },
      ],
    };
  }

  const declaredName = parsed.fields.name?.trim();
  const description = parsed.fields.description?.trim();

  if (!declaredName) {
    issues.push({ severity: 'error', message: 'frontmatter name is missing' });
  } else if (declaredName !== name) {
    const caseOnly = declaredName.toLowerCase() === name.toLowerCase();
    issues.push({
      severity: caseOnly ? 'warning' : 'error',
      message: caseOnly
        ? `frontmatter name "${declaredName}" differs from directory only by case`
        : `frontmatter name "${declaredName}" does not match directory "${name}"`,
    });
  }

  if (!description) {
    issues.push({ severity: 'error', message: 'frontmatter description is missing' });
  } else if (description.length > 1024) {
    issues.push({ severity: 'warning', message: `description is ${description.length} chars, limit 1024` });
  }

  if (parsed.body.trim().length < 50) {
    issues.push({ severity: 'warning', message: 'skill body is nearly empty' });
  }

  return { declaredName, description, issues };
}

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

async function readEnabledPlugins(): Promise<Record<string, boolean>> {
  try {
    const settings = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings;
    return settings.enabledPlugins ?? {};
  } catch {
    return {};
  }
}

function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function codexSkillStates(): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  let text = '';
  try {
    text = await readFile(CODEX_CONFIG, 'utf8');
  } catch {
    return states;
  }

  for (const block of text.split(/\[\[skills\.config\]\]/).slice(1)) {
    const pathMatch = /path\s*=\s*(['"])(.*?)\1/.exec(block);
    const enabledMatch = /enabled\s*=\s*(true|false)/.exec(block);
    if (!pathMatch?.[2]) continue;
    states.set(normalizePath(pathMatch[2]), enabledMatch ? enabledMatch[1] === 'true' : true);
  }

  return states;
}

/** Read every skill known to every installed agent. */
export async function discoverSkills(cwd = process.cwd()): Promise<SkillRecord[]> {
  const roots = await skillRoots(cwd);
  const plugins = await readEnabledPlugins();
  const codexStates = await codexSkillStates();
  const records: SkillRecord[] = [];

  for (const root of roots) {
    if (!(await exists(root.dir))) continue;

    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const candidates: Array<{ name: string; directory: string }> = [];
    for (const entry of entries) {
      const directory = path.join(root.dir, entry.name);
      const skillFile = path.join(directory, 'SKILL.md');
      if (await exists(skillFile)) {
        candidates.push({ name: entry.name, directory });
        continue;
      }
      if (!entry.name.startsWith('.')) {
        candidates.push({ name: entry.name, directory });
        continue;
      }

      // Dot-prefixed container such as ~/.codex/skills/.system: promote children.
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        const childDir = path.join(directory, child.name);
        if (await exists(path.join(childDir, 'SKILL.md'))) {
          candidates.push({ name: child.name, directory: childDir });
        }
      }
    }

    for (const candidate of candidates) {
      const { name, directory } = candidate;
      const directoryInfo = await lstat(directory).catch(() => null);
      if (!directoryInfo) continue;

      const isSymlink = directoryInfo.isSymbolicLink();
      if (!isSymlink && !directoryInfo.isDirectory()) continue;

      let linkTarget: string | undefined;
      let isBroken = false;
      if (isSymlink) {
        try {
          linkTarget = await readlink(directory);
        } catch {
          linkTarget = undefined;
        }
        try {
          await readdir(directory);
        } catch {
          isBroken = true;
        }
      }

      const skillFile = path.join(directory, 'SKILL.md');
      let text: string | null = null;
      try {
        text = await readFile(skillFile, 'utf8');
      } catch {
        text = null;
      }

      if (text === null && !isBroken) {
        let empty = true;
        try {
          empty = (await readdir(directory)).length === 0;
        } catch {
          empty = false;
        }
        if (empty) continue;
      }

      const validation = validateSkill(name, text, isBroken);

      let enabled = true;
      let toggleMechanism: string | undefined;

      if (root.pluginKey) {
        enabled = plugins[root.pluginKey] === true;
        toggleMechanism = `enabledPlugins["${root.pluginKey}"]`;
      } else if (root.scope === 'codex') {
        enabled = codexStates.get(normalizePath(skillFile)) ?? true;
        toggleMechanism = '~/.codex/config.toml skills.config';
      } else if (root.stashed) {
        enabled = false;
        toggleMechanism = `${path.basename(root.dir)} stash (filesystem)`;
      } else {
        enabled = true;
        toggleMechanism = `${path.basename(root.dir)}-disabled stash (filesystem)`;
      }

      records.push({
        name,
        declaredName: validation.declaredName,
        description: validation.description,
        scope: root.scope,
        rootDir: root.origin ?? root.dir,
        directory,
        skillFile,
        isSymlink,
        linkTarget,
        stashed: root.stashed === true,
        pluginKey: root.pluginKey,
        enabled,
        toggleMechanism,
        issues: validation.issues,
      });
    }
  }

  return records.sort((a, b) =>
    a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope),
  );
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function rewriteCodexBlock(
  text: string,
  skillFile: string,
  enabled: boolean,
): { text: string; pruned: boolean } {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const target = normalizePath(skillFile);
  const header = '[[skills.config]]';

  const blockEnd = (start: number): number => {
    for (let index = start + 1; index < lines.length; index += 1) {
      if ((lines[index] ?? '').trim().startsWith('[')) return index;
    }
    return lines.length;
  };

  let blockStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== header) continue;
    const end = blockEnd(index);
    const pathLine = lines.slice(index + 1, end).find((line) => /^\s*path\s*=/.test(line));
    const match = pathLine ? /path\s*=\s*(['"])(.*?)\1/.exec(pathLine) : null;
    if (!match?.[2]) continue;
    const rawPath = match[1] === '"' ? match[2].replace(/\\\\/g, '\\') : match[2];
    if (normalizePath(rawPath) !== target) continue;
    blockStart = index;
    break;
  }

  if (blockStart === -1) {
    if (enabled) return { text, pruned: false };
    const appended = [...lines];
    while (appended.length > 0 && appended[appended.length - 1] === '') appended.pop();
    appended.push('', header, `path = ${JSON.stringify(skillFile)}`, 'enabled = false', '');
    return { text: appended.join(newline), pruned: false };
  }

  const end = blockEnd(blockStart);
  const body = lines.slice(blockStart + 1, end);
  const keys = body.filter((line) => line.trim() !== '');
  const onlyPathAndEnabled = keys.every((line) => /^\s*(path|enabled)\s*=/.test(line));

  if (enabled && onlyPathAndEnabled) {
    let from = blockStart;
    if (from > 0 && (lines[from - 1] ?? '').trim() === '') from -= 1;
    const trimmed = [...lines.slice(0, from), ...lines.slice(end)];
    while (
      trimmed.length > 1 &&
      trimmed[trimmed.length - 1] === '' &&
      trimmed[trimmed.length - 2] === ''
    ) {
      trimmed.pop();
    }
    return { text: trimmed.join(newline), pruned: true };
  }

  const enabledIndex = body.findIndex((line) => /^\s*enabled\s*=/.test(line));
  if (enabledIndex === -1) {
    const pathIndex = body.findIndex((line) => /^\s*path\s*=/.test(line));
    body.splice(pathIndex === -1 ? 0 : pathIndex + 1, 0, `enabled = ${enabled}`);
  } else {
    body[enabledIndex] = `enabled = ${enabled}`;
  }

  const updated = [...lines.slice(0, blockStart + 1), ...body, ...lines.slice(end)];
  return { text: updated.join(newline), pruned: false };
}

export interface ToggleOutcome {
  skill: SkillRecord;
  changed: boolean;
  message: string;
}

/** Enable or disable one skill through the owning agent's config. */
export async function setSkillEnabled(skill: SkillRecord, enabled: boolean): Promise<ToggleOutcome> {
  if (skill.pluginKey) {
    let settings: ClaudeSettings;
    try {
      settings = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings;
    } catch {
      settings = {};
    }
    settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [skill.pluginKey]: enabled };
    await writeJsonAtomic(CLAUDE_SETTINGS, settings);
    return {
      skill,
      changed: true,
      message: `enabledPlugins["${skill.pluginKey}"] = ${enabled}, affects every skill in the plugin`,
    };
  }

  if (skill.scope === 'codex') {
    let text = '';
    try {
      text = await readFile(CODEX_CONFIG, 'utf8');
    } catch {
      text = '';
    }
    const rewritten = rewriteCodexBlock(text, skill.skillFile, enabled);
    if (rewritten.text === text) {
      return { skill, changed: false, message: `already ${enabled ? 'enabled' : 'disabled'}` };
    }
    const temporary = `${CODEX_CONFIG}.tmp-${process.pid}`;
    await writeFile(temporary, rewritten.text, 'utf8');
    await rename(temporary, CODEX_CONFIG);
    return {
      skill,
      changed: true,
      message: rewritten.pruned
        ? 'removed skills.config block'
        : `skills.config enabled = ${enabled}`,
    };
  }

  if (enabled === !skill.stashed) {
    return { skill, changed: false, message: `already ${enabled ? 'enabled' : 'disabled'}` };
  }

  const stashDir = path.join(
    path.dirname(skill.rootDir),
    `${path.basename(skill.rootDir)}-disabled`,
  );
  const target = enabled
    ? path.join(skill.rootDir, skill.name)
    : path.join(stashDir, skill.name);

  try {
    if (enabled) await mkdir(skill.rootDir, { recursive: true });
    else await mkdir(stashDir, { recursive: true });
    await rename(skill.directory, target);
    if (enabled) await rmdir(stashDir).catch(() => undefined);
  } catch (error) {
    return {
      skill,
      changed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    skill,
    changed: true,
    message: enabled
      ? `moved back into ${path.basename(skill.rootDir)}`
      : `moved into ${path.basename(stashDir)}`,
  };
}

export interface RemoveOutcome {
  skill: SkillRecord;
  removed: boolean;
  error?: string;
}

function removalBlocker(skill: SkillRecord): string | null {
  const base = path.resolve(skill.directory);
  const guardRoots = [HOME, process.cwd()].map((root) => path.resolve(root));
  const inside = guardRoots.some((root) => base === root || base.startsWith(root + path.sep));
  if (!inside) return 'refusing to delete outside the home or project tree';

  if (skill.pluginKey) {
    return `plugin-managed skill; disable or remove ${skill.pluginKey} in the agent settings`;
  }

  if (base.includes(`${path.sep}plugins${path.sep}cache${path.sep}`)) {
    return 'plugin-managed skill inside plugins/cache; remove the plugin instead';
  }

  if (base.includes(`${path.sep}skills${path.sep}.system${path.sep}`)) {
    return 'agent-managed system skill; disable it instead of removing';
  }

  const sharedStore = path.resolve(HOME, '.agents', 'skills');
  if (base.startsWith(sharedStore + path.sep) && skill.scope !== 'global') {
    return 'this skill lives in the shared ~/.agents/skills store, remove it with --scope global';
  }

  if (base.split(path.sep).length < 3) return 'refusing to delete a top-level directory';
  return null;
}

/** Delete a skill directory. Symlinks are unlinked, never followed. */
export async function removeSkill(skill: SkillRecord, dryRun: boolean): Promise<RemoveOutcome> {
  const blocker = removalBlocker(skill);
  if (blocker) return { skill, removed: false, error: blocker };
  if (dryRun) return { skill, removed: false };

  try {
    await rm(skill.directory, { recursive: true, force: true });
    return { skill, removed: true };
  } catch (error) {
    return {
      skill,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeSkills(records: SkillRecord[]): {
  total: number;
  byScope: Record<string, number>;
  errors: number;
  warnings: number;
  disabled: number;
} {
  const byScope: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  let disabled = 0;

  for (const record of records) {
    byScope[record.scope] = (byScope[record.scope] ?? 0) + 1;
    for (const issue of record.issues) {
      if (issue.severity === 'error') errors += 1;
      else warnings += 1;
    }
    if (record.enabled === false) disabled += 1;
  }

  return { total: records.length, byScope, errors, warnings, disabled };
}
