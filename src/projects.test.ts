import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ompSlug, projectSlug, scanProject } from './projects';

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('project slugs', () => {
  test('replaces every separator with a dash', () => {
    const value = 'D:\\00-WORKSPACE\\personal-projects\\cac';
    if (process.platform === 'win32') {
      expect(projectSlug(value)).toBe('D--00-WORKSPACE-personal-projects-cac');
      expect(ompSlug(value)).toBe('--D--00-WORKSPACE-personal-projects-cac--');
    } else {
      expect(projectSlug('/repo/cac')).toBe('-repo-cac');
      expect(ompSlug('/repo/cac')).toBe('---repo-cac--');
    }
  });
});

describe('scanProject', () => {
  test('finds local files and per-agent session state', async () => {
    const project = await tempDir('cac-project-');
    const home = await tempDir('cac-home-');
    const slug = projectSlug(project);

    await writeFile(path.join(project, '.mcp.json'), '{"mcpServers":{}}');
    await mkdir(path.join(project, '.agents', 'skills', 'demo'), { recursive: true });
    await writeFile(
      path.join(project, '.agents', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: demo skill body lives here for the test.\n---\nbody text long enough.\n',
    );

    await mkdir(path.join(home, '.claude', 'projects', slug.toLowerCase()), { recursive: true });
    await writeFile(path.join(home, '.claude', 'projects', slug.toLowerCase(), 'session.jsonl'), '{}');

    await mkdir(path.join(home, '.omp', 'agent', 'sessions', `--${slug}--`), { recursive: true });
    await writeFile(path.join(home, '.omp', 'agent', 'sessions', `--${slug}--`, 'a.jsonl'), '{}');

    const codexSessionDir = path.join(home, '.codex', 'sessions', '2026', '01', '02');
    await mkdir(codexSessionDir, { recursive: true });
    const matchFile = path.join(codexSessionDir, 'rollout-match.jsonl');
    await writeFile(
      matchFile,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { cwd: project, base_instructions: { text: 'x'.repeat(200_000) } },
      })}\n{"type":"other"}\n`,
    );
    await writeFile(
      path.join(codexSessionDir, 'rollout-other.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: path.join(project, 'other') } })}\n`,
    );
    const brokenFile = path.join(codexSessionDir, 'rollout-broken.jsonl');
    await writeFile(brokenFile, `{"type":"session_meta","payload":{"cwd":${JSON.stringify(project)}\n`);

    const copilotSession = path.join(home, '.copilot', 'session-state', 'abc');
    await mkdir(copilotSession, { recursive: true });
    await writeFile(path.join(copilotSession, 'workspace.yaml'), `cwd: ${project}\n`);

    const scan = await scanProject(project, home);
    const labels = scan.entries.map((entry) => entry.label);

    expect(labels).toContain('project MCP config');
    expect(labels).toContain('shared skills');
    expect(labels).toContain('claude transcripts');
    expect(labels).toContain('omp sessions');
    expect(labels).toContain('copilot session');

    const rollouts = scan.entries.filter((entry) => entry.label === 'codex rollout');
    expect(rollouts.map((entry) => entry.absolutePath).sort()).toEqual([brokenFile, matchFile].sort());
    expect(rollouts.every((entry) => entry.fileCount === 1)).toBe(true);

    const copilot = scan.entries.find((entry) => entry.label === 'copilot session');
    expect(copilot?.absolutePath).toBe(copilotSession);

    for (const entry of scan.entries) expect(entry.sizeBytes).toBeGreaterThan(0);
  });

  test('returns only local entries for an unknown project', async () => {
    const project = await tempDir('cac-empty-');
    const home = await tempDir('cac-home-empty-');
    const scan = await scanProject(project, home);
    expect(scan.entries).toEqual([]);
  });
});
