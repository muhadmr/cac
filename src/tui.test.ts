import { describe, expect, test } from 'bun:test';
import type { ArtifactRecord } from './types';
import type { SkillRecord } from './skills';
import type { ProjectEntry } from './projects';
import { parseKeys } from './tui/app';
import {
  applyEvent,
  initialTuiState,
  visibleArtifacts,
  visibleServers,
  visibleSkills,
  type TuiState,
} from './tui/model';
import { renderFrame } from './tui/view';

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    agent: 'claude',
    category: 'cache',
    name: 'cache',
    relativePath: '.claude/cache',
    description: 'Regenerable caches',
    safetyLevel: 'safe',
    recommendedAction: 'clean',
    id: 'claude:cache:cache',
    absolutePath: 'C:/tmp/home/.claude/cache',
    exists: true,
    sizeBytes: 2048,
    fileCount: 5,
    ...overrides,
  };
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    name: 'demo',
    declaredName: 'demo',
    description: 'A demo skill used by the tests.',
    scope: 'claude',
    rootDir: 'C:/tmp/home/.claude/skills',
    directory: 'C:/tmp/home/.claude/skills/demo',
    skillFile: 'C:/tmp/home/.claude/skills/demo/SKILL.md',
    isSymlink: false,
    stashed: false,
    enabled: true,
    issues: [],
    ...overrides,
  };
}

function loaded(): TuiState {
  const withArtifacts = applyEvent(initialTuiState, {
    type: 'artifacts',
    records: [
      artifact(),
      artifact({ name: 'big', absolutePath: 'C:/tmp/home/.claude/transcripts', sizeBytes: 4096 }),
    ],
  }).state;
  return applyEvent(withArtifacts, { type: 'skills', records: [skill()] }).state;
}

function press(state: TuiState, key: string): { state: TuiState; effects: ReturnType<typeof applyEvent>['effects'] } {
  return applyEvent(state, { type: 'key', key });
}

describe('parseKeys', () => {
  test('maps arrows, tab, enter and ctrl-c', () => {
    expect(parseKeys('\x1b[A\x1b[B\t\r\x03')).toEqual(['up', 'down', 'tab', 'enter', 'ctrl-c']);
  });

  test('keeps printable characters separate', () => {
    expect(parseKeys('ab')).toEqual(['a', 'b']);
  });
});

describe('cursor and screens', () => {
  test('down moves, up clamps at zero', () => {
    let state = loaded().artifacts.length ? loaded() : loaded();
    state = press(state, 'down').state;
    expect(state.cursors.artifacts).toBe(1);
    state = press(state, 'down').state;
    expect(state.cursors.artifacts).toBe(1);
    state = press(state, 'up').state;
    expect(state.cursors.artifacts).toBe(0);
  });

  test('tab cycles through the three screens', () => {
    let state = loaded();
    state = press(state, 'tab').state;
    expect(state.screen).toBe('skills');
    state = press(state, 'tab').state;
    expect(state.screen).toBe('mcp');
    state = press(state, 'tab').state;
    expect(state.screen).toBe('artifacts');
  });

  test('digit jumps to a screen', () => {
    expect(press(loaded(), '2').state.screen).toBe('skills');
    expect(press(loaded(), '3').state.screen).toBe('mcp');
  });

  test('quit emits the quit effect', () => {
    expect(press(loaded(), 'q').effects).toEqual([{ type: 'quit' }]);
  });
});

describe('filter', () => {
  test('typing filters artifacts and enter applies', () => {
    let state = press(loaded(), '/').state;
    expect(state.filterInput).toBe('');
    state = press(state, 'b').state;
    state = press(state, 'i').state;
    state = press(state, 'g').state;
    state = press(state, 'enter').state;
    expect(state.filter).toBe('big');
    expect(visibleArtifacts(state).map((record) => record.name)).toEqual(['big']);
  });

  test('escape clears an applied filter', () => {
    const filtered = { ...loaded(), filter: 'big' };
    expect(press(filtered, 'esc').state.filter).toBe('');
  });

  test('issues-only hides clean skills', () => {
    const withIssues = applyEvent(loaded(), {
      type: 'skills',
      records: [
        skill({ name: 'ok' }),
        skill({ name: 'bad', issues: [{ severity: 'error', message: 'broken' }] }),
      ],
    }).state;
    const state = { ...withIssues, screen: 'skills' as const };
    const filtered = press(state, 'i').state;
    expect(visibleSkills(filtered).map((record) => record.name)).toEqual(['bad']);
  });
});

describe('artifact actions', () => {
  test('clean on a safe artifact asks for confirmation', () => {
    const state = press(loaded(), 'c').state;
    expect(state.confirm?.prompt).toContain('cache');
    expect(state.confirm?.effect.type).toBe('clean');
  });

  test('confirming emits the clean effect, cancelling does not', () => {
    const armed = press(loaded(), 'c').state;
    expect(press(armed, 'y').effects[0]?.type).toBe('clean');
    expect(press(armed, 'n').effects).toEqual([]);
    expect(press(armed, 'n').state.confirm).toBeNull();
  });

  test('caution artifacts need the unlock key', () => {
    const cautionState = {
      ...loaded(),
      artifacts: [artifact({ safetyLevel: 'caution' as const })],
    };
    const blocked = press(cautionState, 'c').state;
    expect(blocked.confirm).toBeNull();
    expect(blocked.status).toContain('press u');

    const unlocked = press(cautionState, 'u').state;
    expect(press(unlocked, 'c').state.confirm).not.toBeNull();
  });

  test('u reports the state it just set', () => {
    const on = press(loaded(), 'u').state;
    expect(on.allowCaution).toBe(true);
    expect(on.status).toBe('Caution artifacts enabled');

    const off = press(on, 'u').state;
    expect(off.allowCaution).toBe(false);
    expect(off.status).toBe('Only safe artifacts');
  });

  test('C arms a bulk clean of every safe artifact', () => {
    const state = press(loaded(), 'C').state;
    expect(state.confirm?.prompt).toContain('2 artifacts');
    expect(state.confirm?.effect).toMatchObject({
      type: 'clean',
      safetyLevels: ['safe'],
    });
    const effect = state.confirm?.effect;
    expect(effect?.type === 'clean' ? effect.records.length : 0).toBe(2);
  });

  test('C includes caution artifacts only after u', () => {
    const cautionState: TuiState = {
      ...loaded(),
      artifacts: [artifact(), artifact({ safetyLevel: 'caution' as const })],
    };
    const safeOnly = press(cautionState, 'C').state.confirm?.effect;
    expect(safeOnly?.type === 'clean' ? safeOnly.records.length : 0).toBe(1);

    const unlocked = press(press(cautionState, 'u').state, 'C').state.confirm?.effect;
    expect(unlocked?.type === 'clean' ? unlocked.records.length : 0).toBe(2);
  });

  test('C reports when nothing is cleanable', () => {
    const emptyState: TuiState = { ...loaded(), artifacts: [] };
    const result = press(emptyState, 'C').state;
    expect(result.confirm).toBeNull();
    expect(result.status).toBe('no cleanable artifacts');
  });

  test('keep artifacts never arm a clean', () => {
    const keepState = {
      ...loaded(),
      artifacts: [artifact({ safetyLevel: 'caution' as const, recommendedAction: 'keep' as const })],
    };
    const result = press(press(keepState, 'u').state, 'c').state;
    expect(result.confirm).toBeNull();
    expect(result.status).toContain('keep');
  });
  test('space marks cleanable artifacts and advances cursor', () => {
    let state = loaded();
    expect(state.marked.size).toBe(0);

    state = press(state, ' ').state;
    expect(state.marked.size).toBe(1);
    expect(state.status).toBe('1 marked');
    expect(state.cursors.artifacts).toBe(1);

    state = press(state, ' ').state;
    expect(state.marked.size).toBe(2);
    expect(state.status).toBe('2 marked');

    const armed = press(state, 'c').state;
    expect(armed.confirm?.prompt).toContain('Clean 2 marked artifacts');
    const effect = armed.confirm?.effect;
    expect(effect?.type === 'clean' ? effect.records.length : 0).toBe(2);
  });

  test('space on a marked artifact unmarks it', () => {
    let state = press(loaded(), ' ').state;
    expect(state.marked.size).toBe(1);

    state = press(state, 'up').state;
    state = press(state, ' ').state;
    expect(state.marked.size).toBe(0);
    expect(state.status).toBe('Unmarked');
  });

  test('esc clears all marks', () => {
    let state = press(loaded(), ' ').state;
    expect(state.marked.size).toBe(1);
    state = press(state, 'esc').state;
    expect(state.marked.size).toBe(0);
    expect(state.status).toBe('Marks cleared');
  });

  test('space refuses to mark keep or locked caution artifacts', () => {
    const keepState: TuiState = {
      ...loaded(),
      artifacts: [artifact({ safetyLevel: 'caution', recommendedAction: 'keep' })],
    };
    const keepResult = press(keepState, ' ').state;
    expect(keepResult.marked.size).toBe(0);
    expect(keepResult.status).toContain('keep');

    const cautionState: TuiState = {
      ...loaded(),
      artifacts: [artifact({ safetyLevel: 'caution' })],
    };
    const cautionResult = press(cautionState, ' ').state;
    expect(cautionResult.marked.size).toBe(0);
    expect(cautionResult.status).toContain('press u');

    const allowed = press(press(cautionState, 'u').state, ' ').state;
    expect(allowed.marked.size).toBe(1);
  });
});

describe('skill actions', () => {
  test('d toggles the selected skill', () => {
    const state = press(loaded(), '2').state;
    expect(press(state, 'd').effects).toEqual([
      { type: 'toggleSkill', skill: skill(), enabled: false },
    ]);
  });

  test('x asks before removing', () => {
    const state = press(loaded(), '2').state;
    const armed = press(state, 'x').state;
    expect(armed.confirm?.effect.type).toBe('removeSkill');
    expect(press(armed, 'y').effects[0]?.type).toBe('removeSkill');
  });
});

describe('scope picker', () => {
  const picker = () => applyEvent(loaded(), { type: 'openScope' }).state;

  test('opens with home highlighted and renders the options', () => {
    const state = picker();
    expect(state.picker).toEqual({ cursor: 0, input: null });
    const frame = renderFrame(state, 110, 14).join('\n');
    expect(frame).toContain('choose scope');
    expect(frame).toContain('Home-wide (all agents)');
    expect(frame).toContain('Type a path…');
  });

  test('home is the default selection', () => {
    const result = press(picker(), 'enter').state;
    expect(result.picker).toBeNull();
    expect(result.scope).toBeNull();
  });

  test('choosing the current directory loads that project', () => {
    const moved = press(picker(), 'down').state;
    const result = press(moved, 'enter');
    expect(result.state.scope).toBe(process.cwd());
    expect(result.state.picker).toBeNull();
    expect(result.effects[0]).toMatchObject({ type: 'loadProject', path: process.cwd() });
  });

  test('digit 2 selects the current directory directly', () => {
    expect(press(picker(), '2').state.scope).toBe(process.cwd());
  });

  test('typing a path selects it', () => {
    const typing = press(picker(), '3').state;
    expect(typing.picker?.input).toBe('');
    let typed = typing;
    for (const char of 'D:/work/repo') typed = press(typed, char).state;
    const applied = press(typed, 'enter');
    expect(applied.state.scope).toBe('D:/work/repo');
    expect(applied.effects[0]).toMatchObject({ type: 'loadProject', path: 'D:/work/repo' });
  });

  test('empty path reports an error instead of loading', () => {
    const typing = press(picker(), '3').state;
    const result = press(typing, 'enter');
    expect(result.effects).toEqual([]);
    expect(result.state.picker?.error).toBe('path required');
  });

  test('q quits from the picker', () => {
    expect(press(picker(), 'q').effects).toEqual([{ type: 'quit' }]);
  });

  test('escape closes the picker without changing scope', () => {
    const result = press(picker(), 'esc').state;
    expect(result.picker).toBeNull();
    expect(result.scope).toBeNull();
  });

  const sessionEntry: ProjectEntry = {
    agent: 'claude',
    kind: 'session',
    label: 'claude transcripts',
    absolutePath: 'C:/tmp/home/.claude/projects/x',
    exists: true,
    sizeBytes: 2048,
    fileCount: 4,
    safetyLevel: 'caution',
    recommendedAction: 'clean',
  };

  const localEntry: ProjectEntry = {
    agent: 'shared',
    kind: 'local',
    label: 'shared skills',
    absolutePath: 'C:/tmp/proj/.agents/skills',
    exists: true,
    sizeBytes: 512,
    fileCount: 3,
    safetyLevel: 'critical',
    recommendedAction: 'keep',
  };

  test('s reopens the picker and renders project rows', () => {
    const project: TuiState = { ...loaded(), scope: 'C:/tmp/proj', projectEntries: [sessionEntry] };
    const frame = renderFrame(project, 120, 12).join('\n');
    expect(frame).toContain('claude transcripts');
    expect(frame).toContain('project:proj');
    expect(frame).toContain('LABEL');
    expect(frame).toContain('caution');

    expect(press(project, 's').state.picker?.cursor).toBe(0);
  });

  test('project session rows clean after u, local config never', () => {
    const project: TuiState = {
      ...loaded(),
      scope: 'C:/tmp/proj',
      projectEntries: [sessionEntry, localEntry],
    };

    const blocked = press(project, 'c').state;
    expect(blocked.confirm).toBeNull();
    expect(blocked.status).toContain('press u');

    const unlocked = press(project, 'u').state;
    const armed = press(unlocked, 'c').state;
    expect(armed.confirm?.effect).toMatchObject({
      type: 'cleanProject',
      project: 'C:/tmp/proj',
      safetyLevels: ['caution'],
    });
    expect(press(armed, 'y').effects[0]?.type).toBe('cleanProject');

    const locked = press(project, 'c').state;
    expect(locked.confirm).toBeNull();
  });

  test('local config rows are refused with a keep message', () => {
    const project: TuiState = {
      ...loaded(),
      scope: 'C:/tmp/proj',
      projectEntries: [localEntry],
    };
    const result = press(press(project, 'u').state, 'c').state;
    expect(result.confirm).toBeNull();
    expect(result.status).toContain('keep');
  });

  test('C cleans every cleanable project entry', () => {
    const project: TuiState = {
      ...loaded(),
      scope: 'C:/tmp/proj',
      projectEntries: [sessionEntry, localEntry],
    };
    const armed = press(press(project, 'u').state, 'C').state;
    expect(armed.confirm?.prompt).toContain('1 project entries');
    const effect = armed.confirm?.effect;
    expect(effect?.type === 'cleanProject' ? effect.entries.length : 0).toBe(1);

    const empty = press({ ...project, projectEntries: [localEntry] }, 'C').state;
    expect(empty.confirm).toBeNull();
    expect(empty.status).toContain('no cleanable');
  });

  test('r reloads the project scope', () => {
    const project: TuiState = { ...loaded(), scope: 'C:/tmp/proj' };
    expect(press(project, 'r').effects[0]).toMatchObject({ type: 'loadProject', path: 'C:/tmp/proj' });
  });

  test('choosing a project reloads skills for that path', () => {
    const applied = press(picker(), '2');
    expect(applied.effects).toContainEqual(
      expect.objectContaining({ type: 'loadSkills', cwd: process.cwd(), announce: false }),
    );
  });

  test('returning home reloads skills from the current directory', () => {
    const project: TuiState = { ...loaded(), scope: 'C:/tmp/other' };
    const back = press(project, 's').state;
    const result = press(back, '1');
    expect(result.state.scope).toBeNull();
    expect(result.effects).toContainEqual(
      expect.objectContaining({ type: 'loadSkills', announce: false }),
    );
  });

  test('r on the skills tab keeps the chosen scope', () => {
    const project: TuiState = { ...loaded(), screen: 'skills', scope: 'C:/tmp/proj' };
    expect(press(project, 'r').effects[0]).toMatchObject({ type: 'loadSkills', cwd: 'C:/tmp/proj' });
  });

  test('project event fills rows without clearing the home scan flag', () => {
    const base = applyEvent(loaded(), { type: 'busy', screen: 'artifacts', busy: true }).state;
    const state = applyEvent(base, { type: 'projectBusy', busy: true }).state;
    const done = applyEvent(state, { type: 'project', entries: [] }).state;
    expect(done.projectBusy).toBe(false);
    expect(done.artifactsBusy).toBe(true);
  });

  test('project event fills rows without overwriting an action status', () => {
    const base = applyEvent(loaded(), { type: 'status', message: 'kept' }).state;
    const entries: ProjectEntry[] = [];
    const quiet = applyEvent(base, { type: 'project', entries }).state;
    expect(quiet.status).toBe('kept');
    const loud = applyEvent(base, { type: 'project', entries, announce: true }).state;
    expect(loud.status).toContain('project');
  });
});

describe('renderFrame', () => {
  test('fills the requested height and width', () => {
    const frame = renderFrame(loaded(), 100, 12);
    expect(frame).toHaveLength(12);
    for (const line of frame) expect(line.length).toBeLessThanOrEqual(100);
  });

  test('shows tabs, the cursor marker and the selected path', () => {
    const frame = renderFrame(loaded(), 120, 12).join('\n');
    expect(frame).toContain('artifacts');
    expect(frame).toContain('skills');
    expect(frame).toContain('mcp');
    expect(frame).toContain('›');
    expect(frame).toContain('.claude/cache');
  });

  test('renders the confirmation prompt on the detail line', () => {
    const armed = press(loaded(), 'c').state;
    expect(renderFrame(armed, 120, 12).join('\n')).toContain('Clean cache');
  });

  test('shows the absolute path on its own line, with both ends visible', () => {
    const longPath =
      'C:/very/long/path/that/keeps/going/and/going/until/it/is/definitely/wider/than/the/terminal/width/session.jsonl';
    const project: TuiState = {
      ...loaded(),
      scope: 'C:/tmp/proj',
      projectEntries: [
        {
          agent: 'claude',
          kind: 'session',
          label: 'claude transcripts',
          absolutePath: longPath,
          exists: true,
          sizeBytes: 2048,
          fileCount: 4,
          safetyLevel: 'caution',
          recommendedAction: 'clean',
        },
      ],
    };
    const frame = renderFrame(project, 60, 14).join('\n');
    expect(frame).toContain('C:/very');
    expect(frame).toContain('session.jsonl');
  });

  test('shows the home artifact path line', () => {
    const frame = renderFrame(loaded(), 120, 12).join('\n');
    expect(frame).toContain('C:/tmp/home/.claude/cache');
  });

  test('shows the filter buffer while typing', () => {
    const state = press(press(loaded(), '/').state, 'a').state;
    expect(renderFrame(state, 120, 12).join('\n')).toContain('filter: a');
  });
  test('renders marked row indicator and detail prefix', () => {
    let state = loaded();
    state = press(state, ' ').state; // marks first row and moves cursor to row 1
    const frame = renderFrame(state, 120, 14).join('\n');
    expect(frame).toContain(' *'); // row 0 marked, non-cursor
    expect(frame).toContain('› '); // row 1 cursor, unmarked
    expect(frame).toContain('1 marked');

    // Move cursor back to marked row
    state = press(state, 'up').state;
    const frameSelected = renderFrame(state, 120, 14).join('\n');
    expect(frameSelected).toContain('›*');
    expect(frameSelected).toContain('[marked]');
  });

  test('filters server rows by name', () => {
    const withServers: TuiState = {
      ...loaded(),
      screen: 'mcp',
      filter: 'semble',
      mcp: {
        configFiles: [],
        statuses: [
          {
            name: 'semble',
            source: 'claude',
            type: 'stdio',
            available: true,
            statusMessage: 'ok',
          },
          {
            name: 'node_repl',
            source: 'codex',
            type: 'stdio',
            available: true,
            statusMessage: 'ok',
          },
        ],
      },
    };
    expect(visibleServers(withServers).map((server) => server.name)).toEqual(['semble']);
  });

  test('a refresh keeps the action status message', () => {
    const acted = applyEvent(loaded(), { type: 'status', message: 'demo: moved' }).state;
    const refreshed = applyEvent(acted, {
      type: 'skills',
      records: [skill()],
    }).state;
    expect(refreshed.status).toBe('demo: moved');

    const announced = applyEvent(acted, {
      type: 'skills',
      records: [skill()],
      announce: true,
    }).state;
    expect(announced.status).toBe('1 skills');
  });
});
