import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { parseCodexToml } from './mcp';
import { rewriteCodexBlock, validateSkill } from './skills';
import { selectProjectTargets, selectTargets } from './cleaner';
import type { ProjectEntry } from './projects';
import { HOME } from './scanner';
import type { ArtifactRecord } from './types';

const CODEX_SNIPPET = `
model = "gpt-6.1-sol"

[mcp_servers.semble]
command = "uvx"
args = ["--from", "semble[mcp]", "semble"]

[mcp_servers.semble.tools.search]
approval_mode = "approve"

[mcp_servers.node_repl]
args = []
command = 'C:\\Users\\tester\\node_repl.exe'
env_vars = ["CODEX_WINDOWS_REGISTERED_CORE"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = 'C:\\Users\\tester\\node.exe'
NODE_REPL_TIMEOUT_MS = "1000"

[features]
web_search = true
`;

describe('parseCodexToml', () => {
  test('reads servers and ignores nested tool tables', () => {
    const servers = parseCodexToml(CODEX_SNIPPET);
    expect(servers.map((server) => server.name).sort()).toEqual(['node_repl', 'semble']);
    expect(servers.find((server) => server.name === 'semble')?.args).toEqual([
      '--from',
      'semble[mcp]',
      'semble',
    ]);
  });

  test('keeps backslashes in literal command strings', () => {
    const node = parseCodexToml(CODEX_SNIPPET).find((server) => server.name === 'node_repl');
    expect(node?.command).toBe('C:\\Users\\tester\\node_repl.exe');
  });

  test('reads env tables under a server', () => {
    const node = parseCodexToml(CODEX_SNIPPET).find((server) => server.name === 'node_repl');
    expect(node?.env).toEqual({
      NODE_REPL_NODE_PATH: 'C:\\Users\\tester\\node.exe',
      NODE_REPL_TIMEOUT_MS: '1000',
    });
  });

  test('ignores sections outside mcp_servers', () => {
    expect(parseCodexToml('[features]\nweb_search = true\n')).toEqual([]);
  });
});

describe('rewriteCodexBlock', () => {
  const skillFile = 'C:\\Users\\tester\\.agents\\skills\\ask-docs\\SKILL.md';

  test('appends a disabled block when the skill has no entry', () => {
    const result = rewriteCodexBlock('model = "x"\n', skillFile, false).text;
    expect(result).toContain('[[skills.config]]');
    expect(result).toContain('enabled = false');
    expect(result).toContain('ask-docs');
    expect(result.startsWith('model = "x"')).toBe(true);
  });

  test('leaves the file untouched when enabling an absent entry', () => {
    const original = 'model = "x"\n';
    expect(rewriteCodexBlock(original, skillFile, true).text).toBe(original);
  });

  test('removes a disable-only block when enabling', () => {
    const original = [
      '[[skills.config]]',
      `path = '${skillFile}'`,
      'enabled = false',
      '',
      '[features]',
      'web_search = true',
      '',
    ].join('\n');
    const result = rewriteCodexBlock(original, skillFile, true).text;
    expect(result).not.toContain('[[skills.config]]');
    expect(result).toContain('[features]');
  });

  test('keeps a block that carries extra keys', () => {
    const original = [
      '[[skills.config]]',
      `path = '${skillFile}'`,
      'enabled = false',
      'note = "custom"',
      '',
    ].join('\n');
    const result = rewriteCodexBlock(original, skillFile, true).text;
    expect(result).toContain('enabled = true');
    expect(result).toContain('note = "custom"');
  });

  test('matches escaped double-quoted paths', () => {
    const original = [
      '[[skills.config]]',
      `path = "${skillFile.replace(/\\/g, '\\\\')}"`,
      'enabled = false',
      '',
    ].join('\n');
    expect(rewriteCodexBlock(original, skillFile, true).text).not.toContain('SKILL.md');
  });

  test('keeps CRLF line endings', () => {
    const original = `model = "x"\r\n`;
    const result = rewriteCodexBlock(original, skillFile, false).text;
    expect(result.includes('\r\n')).toBe(true);
    expect(result.includes('\n\n')).toBe(false);
  });
});

describe('validateSkill', () => {
  const valid = [
    '---',
    'name: demo',
    'description: A skill used to test validation of skill files.',
    '---',
    '',
    'This body is long enough to avoid the nearly empty warning from the validator.',
  ].join('\n');

  test('accepts a complete skill file', () => {
    expect(validateSkill('demo', valid, false).issues).toEqual([]);
  });

  test('reports escaped frontmatter delimiters', () => {
    const escaped = valid.replace(/^---\n/, '\\---\n');
    const messages = validateSkill('demo', escaped, false).issues.map((issue) => issue.message);
    expect(messages).toContain('frontmatter delimiters are escaped with a leading backslash');
  });

  test('reports a name mismatch as an error', () => {
    const issues = validateSkill('other', valid, false).issues;
    expect(issues.some((issue) => issue.severity === 'error' && issue.message.includes('does not match'))).toBe(true);
  });

  test('reports a case-only name mismatch as a warning', () => {
    const issues = validateSkill('Demo', valid, false).issues;
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  test('reports a missing description', () => {
    const noDescription = valid.replace(/^description:.*\n/m, '');
    const issues = validateSkill('demo', noDescription, false).issues;
    expect(issues.some((issue) => issue.message === 'frontmatter description is missing')).toBe(true);
  });

  test('reports a broken symlink', () => {
    const issues = validateSkill('demo', null, true).issues;
    expect(issues).toEqual([{ severity: 'error', message: 'broken symlink' }]);
  });
});

describe('selectProjectTargets', () => {
  const entry = (overrides: Partial<ProjectEntry> = {}): ProjectEntry => ({
    agent: 'claude',
    kind: 'session',
    label: 'claude transcripts',
    absolutePath: path.join('C:/tmp/proj', '.claude', 'session'),
    exists: true,
    sizeBytes: 1024,
    fileCount: 1,
    safetyLevel: 'caution',
    recommendedAction: 'clean',
    ...overrides,
  });

  test('selects session rows when caution is allowed', () => {
    const targets = selectProjectTargets([entry()], {
      projectRoot: 'C:/tmp/proj',
      safetyLevels: ['safe', 'caution'],
    });
    expect(targets).toHaveLength(1);
  });

  test('rejects caution rows when only safe is allowed', () => {
    expect(
      selectProjectTargets([entry()], { projectRoot: 'C:/tmp/proj', safetyLevels: ['safe'] }),
    ).toHaveLength(0);
  });

  test('rejects local config marked keep', () => {
    const local = entry({
      kind: 'local',
      safetyLevel: 'critical',
      recommendedAction: 'keep',
      absolutePath: path.join('C:/tmp/proj', '.mcp.json'),
    });
    expect(
      selectProjectTargets([local], {
        projectRoot: 'C:/tmp/proj',
        safetyLevels: ['safe', 'caution'],
      }),
    ).toHaveLength(0);
  });

  test('rejects paths outside the project and home roots', () => {
    const outside = entry({ absolutePath: path.join(path.parse(HOME).root, 'other', 'session') });
    expect(
      selectProjectTargets([outside], {
        projectRoot: 'C:/tmp/proj',
        safetyLevels: ['safe', 'caution'],
      }),
    ).toHaveLength(0);
  });

  test('rejects sidecars', () => {
    const wal = entry({ absolutePath: path.join('C:/tmp/proj', '.claude', 'x.db-wal') });
    expect(
      selectProjectTargets([wal], {
        projectRoot: 'C:/tmp/proj',
        safetyLevels: ['safe', 'caution'],
      }),
    ).toHaveLength(0);
  });
});

function record(overrides: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    agent: 'claude',
    category: 'cache',
    name: 'cache',
    relativePath: '.claude/cache',
    description: '',
    safetyLevel: 'safe',
    recommendedAction: 'clean',
    id: 'claude:cache:cache',
    absolutePath: path.join(HOME, '.claude', 'cache'),
    exists: true,
    sizeBytes: 1024,
    fileCount: 4,
    ...overrides,
  };
}

describe('selectTargets', () => {
  test('accepts safe artifacts inside home', () => {
    expect(selectTargets([record({})])).toHaveLength(1);
  });

  test('rejects caution artifacts unless allowed', () => {
    const caution = record({ safetyLevel: 'caution' });
    expect(selectTargets([caution])).toHaveLength(0);
    expect(selectTargets([caution], { safetyLevels: ['safe', 'caution'] })).toHaveLength(1);
  });

  test('rejects artifacts marked keep or critical', () => {
    const kept = record({ recommendedAction: 'keep' });
    const critical = record({ safetyLevel: 'critical' });
    expect(selectTargets([kept, critical])).toHaveLength(0);
  });

  test('rejects paths outside the home directory', () => {
    const outside = record({
      absolutePath: path.join(path.parse(HOME).root, 'tmp', 'agent-cache'),
    });
    expect(selectTargets([outside])).toHaveLength(0);
  });

  test('rejects the home directory itself', () => {
    expect(selectTargets([record({ absolutePath: HOME })])).toHaveLength(0);
  });

  test('accepts a file directly under home', () => {
    const direct = record({
      category: 'backup',
      absolutePath: path.join(HOME, '.claude.json.backup'),
    });
    expect(selectTargets([direct])).toHaveLength(1);
  });

  test('rejects sqlite sidecars and lock files', () => {
    const wal = record({ absolutePath: path.join(HOME, '.codex', 'logs_2.sqlite-wal') });
    const shm = record({ absolutePath: path.join(HOME, '.omp', 'stats.db-shm') });
    const lock = record({ absolutePath: path.join(HOME, '.codex', '.sqlite-maintenance.lock') });
    expect(selectTargets([wal, shm, lock])).toHaveLength(0);
  });

  test('ignores artifacts that hold no files', () => {
    expect(selectTargets([record({ exists: false, sizeBytes: 0, fileCount: 0 })])).toHaveLength(0);
  });
});
