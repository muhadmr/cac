import type { ArtifactRecord, McpServerStatus, SafetyLevel } from '../types';
import type { SkillRecord } from '../skills';
import type { ProjectEntry } from '../projects';

export type Screen = 'artifacts' | 'skills' | 'mcp';

export interface McpData {
  statuses: McpServerStatus[];
  configFiles: Array<{ path: string; found: boolean; serverCount: number }>;
}

export interface ScopePicker {
  cursor: number;
  input: string | null;
  error?: string;
}

export type Effect =
  | { type: 'loadArtifacts'; announce?: boolean }
  | { type: 'loadSkills'; announce?: boolean; cwd?: string }
  | { type: 'loadMcp'; probe: boolean; announce?: boolean }
  | { type: 'loadProject'; path: string; announce?: boolean }
  | { type: 'clean'; records: ArtifactRecord[]; safetyLevels: SafetyLevel[] }
  | { type: 'cleanProject'; entries: ProjectEntry[]; safetyLevels: SafetyLevel[]; project: string }
  | { type: 'toggleSkill'; skill: SkillRecord; enabled: boolean }
  | { type: 'removeSkill'; skill: SkillRecord }
  | { type: 'quit' };

export interface ConfirmState {
  prompt: string;
  effect: Effect;
}

export interface TuiState {
  screen: Screen;
  cursors: Record<Screen, number>;
  artifacts: ArtifactRecord[];
  artifactsLoaded: boolean;
  artifactsBusy: boolean;
  /** Non-null when the artifacts tab shows one project instead of the home tree. */
  scope: string | null;
  projectEntries: ProjectEntry[];
  projectBusy: boolean;
  picker: ScopePicker | null;
  /** Set of absolutePaths marked for multi-selection. */
  marked: Set<string>;
  skills: SkillRecord[];
  skillsLoaded: boolean;
  skillsBusy: boolean;
  mcp: McpData | null;
  mcpBusy: boolean;
  probe: boolean;
  filter: string;
  filterInput: string | null;
  issuesOnly: boolean;
  allowCaution: boolean;
  confirm: ConfirmState | null;
  status: string;
  error?: string;
}

export type TuiEvent =
  | { type: 'key'; key: string }
  | { type: 'artifacts'; records: ArtifactRecord[]; announce?: boolean }
  | { type: 'skills'; records: SkillRecord[]; announce?: boolean }
  | { type: 'mcp'; data: McpData; announce?: boolean }
  | { type: 'project'; entries: ProjectEntry[]; announce?: boolean }
  | { type: 'projectBusy'; busy: boolean }
  | { type: 'busy'; screen: Screen; busy: boolean }
  | { type: 'openScope' }
  | { type: 'status'; message: string }
  | { type: 'error'; message: string };

export const SCREENS: Screen[] = ['artifacts', 'skills', 'mcp'];

export const initialTuiState: TuiState = {
  screen: 'artifacts',
  cursors: { artifacts: 0, skills: 0, mcp: 0 },
  artifacts: [],
  artifactsLoaded: false,
  artifactsBusy: false,
  scope: null,
  projectEntries: [],
  projectBusy: false,
  picker: null,
  marked: new Set<string>(),
  skills: [],
  skillsLoaded: false,
  skillsBusy: false,
  mcp: null,
  mcpBusy: false,
  probe: true,
  filter: '',
  filterInput: null,
  issuesOnly: false,
  allowCaution: false,
  confirm: null,
  status: 'Loading artifacts…',
};

function matches(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle);
}

export function visibleArtifacts(state: TuiState): ArtifactRecord[] {
  const needle = state.filter.toLowerCase();
  if (!needle) return state.artifacts;
  return state.artifacts.filter((record) =>
    [record.agent, record.category, record.name, record.absolutePath, record.description].some((field) =>
      matches(field, needle),
    ),
  );
}

export function visibleSkills(state: TuiState): SkillRecord[] {
  const needle = state.filter.toLowerCase();
  return state.skills.filter((record) => {
    if (state.issuesOnly && record.issues.length === 0) return false;
    if (!needle) return true;
    return [record.scope, record.name, record.directory, record.toggleMechanism ?? ''].some((field) =>
      matches(field, needle),
    );
  });
}

export function visibleServers(state: TuiState): McpServerStatus[] {
  const servers = state.mcp?.statuses ?? [];
  const needle = state.filter.toLowerCase();
  if (!needle) return servers;
  return servers.filter((server) =>
    [server.name, server.type, server.source, server.statusMessage].some((field) =>
      matches(field, needle),
    ),
  );
}

export function visibleProjectEntries(state: TuiState): ProjectEntry[] {
  const needle = state.filter.toLowerCase();
  if (!needle) return state.projectEntries;
  return state.projectEntries.filter((entry) =>
    [entry.agent, entry.kind, entry.label, entry.absolutePath].some((field) => matches(field, needle)),
  );
}

export function visibleCount(state: TuiState): number {
  if (state.screen === 'artifacts') {
    return state.scope ? visibleProjectEntries(state).length : visibleArtifacts(state).length;
  }
  if (state.screen === 'skills') return visibleSkills(state).length;
  return visibleServers(state).length;
}

export function cursorIndex(state: TuiState): number {
  const length = visibleCount(state);
  if (length === 0) return 0;
  return Math.min(state.cursors[state.screen], length - 1);
}

export function currentArtifact(state: TuiState): ArtifactRecord | undefined {
  return visibleArtifacts(state)[cursorIndex(state)];
}

export function currentProjectEntry(state: TuiState): ProjectEntry | undefined {
  return visibleProjectEntries(state)[cursorIndex(state)];
}

export function currentSkill(state: TuiState): SkillRecord | undefined {
  return visibleSkills(state)[cursorIndex(state)];
}

export function currentServer(state: TuiState): McpServerStatus | undefined {
  return visibleServers(state)[cursorIndex(state)];
}

function cleanable(record: ArtifactRecord, allowCaution: boolean): boolean {
  if (!record.exists || record.sizeBytes === 0) return false;
  if (record.recommendedAction !== 'clean') return false;
  if (record.safetyLevel === 'safe') return true;
  return allowCaution && record.safetyLevel === 'caution';
}

function cleanableEntry(entry: ProjectEntry, allowCaution: boolean): boolean {
  if (!entry.exists || entry.sizeBytes === 0) return false;
  if (entry.recommendedAction !== 'clean') return false;
  if (entry.safetyLevel === 'safe') return true;
  return allowCaution && entry.safetyLevel === 'caution';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function moveCursor(state: TuiState, delta: number): TuiState {
  const length = visibleCount(state);
  const next = Math.max(0, Math.min(Math.max(0, length - 1), cursorIndex(state) + delta));
  return { ...state, cursors: { ...state.cursors, [state.screen]: next } };
}

function switchScreen(state: TuiState, screen: Screen): TuiState {
  return { ...state, screen, filter: '', filterInput: null, marked: new Set(), confirm: null, status: '' };
}

function reloadEffect(state: TuiState): Effect {
  if (state.screen === 'artifacts') {
    if (state.scope) return { type: 'loadProject', path: state.scope, announce: true };
    return { type: 'loadArtifacts', announce: true };
  }
  if (state.screen === 'skills') return { type: 'loadSkills', announce: true, cwd: state.scope ?? undefined };
  return { type: 'loadMcp', probe: state.probe, announce: true };
}

const PICKER_OPTIONS = 3;

function chooseScope(
  state: TuiState,
  choice: number,
): { state: TuiState; effects: Effect[] } {
  if (choice === 0) {
    return {
      state: {
        ...state,
        picker: null,
        scope: null,
        cursors: { ...state.cursors, artifacts: 0 },
        filter: '',
        marked: new Set(),
        status: 'scope: home',
      },
      effects: state.scope ? [{ type: 'loadSkills', announce: false }] : [],
    };
  }

  if (choice === 1) return selectScope(state, process.cwd());

  return { state: { ...state, picker: { cursor: 2, input: '' } }, effects: [] };
}

function selectScope(state: TuiState, projectPath: string): { state: TuiState; effects: Effect[] } {
  return {
    state: {
      ...state,
      picker: null,
      scope: projectPath,
      projectEntries: [],
      projectBusy: true,
      cursors: { ...state.cursors, artifacts: 0 },
      filter: '',
      marked: new Set(),
      status: `loading ${projectPath}…`,
    },
    effects: [
      { type: 'loadProject', path: projectPath, announce: true },
      { type: 'loadSkills', cwd: projectPath, announce: false },
    ],
  };
}

function handlePicker(state: TuiState, key: string): { state: TuiState; effects: Effect[] } {
  const picker = state.picker;
  if (!picker) return { state, effects: [] };

  if (picker.input !== null) {
    if (key === 'enter') {
      const value = picker.input.trim();
      if (!value) return { state: { ...state, picker: { ...picker, error: 'path required' } }, effects: [] };
      return selectScope(state, value);
    }
    if (key === 'esc' || key === 'ctrl-c') {
      return { state: { ...state, picker: { cursor: 2, input: null } }, effects: [] };
    }
    if (key === 'backspace') {
      return {
        state: { ...state, picker: { ...picker, input: picker.input.slice(0, -1), error: undefined } },
        effects: [],
      };
    }
    if (key.length === 1 && key >= ' ') {
      return {
        state: { ...state, picker: { ...picker, input: picker.input + key, error: undefined } },
        effects: [],
      };
    }
    return { state, effects: [] };
  }

  if (key === 'up' || key === 'k') {
    return { state: { ...state, picker: { ...picker, cursor: Math.max(0, picker.cursor - 1) } }, effects: [] };
  }
  if (key === 'down' || key === 'j') {
    return {
      state: {
        ...state,
        picker: { ...picker, cursor: Math.min(PICKER_OPTIONS - 1, picker.cursor + 1) },
      },
      effects: [],
    };
  }
  if (key === 'enter') return chooseScope(state, picker.cursor);
  if (key === 'q') return { state, effects: [{ type: 'quit' }] };
  if (key === 'esc' || key === 'ctrl-c') return { state: { ...state, picker: null }, effects: [] };
  if (key >= '1' && key <= String(PICKER_OPTIONS)) {
    return chooseScope(state, Number(key) - 1);
  }
  return { state, effects: [] };
}

function handleKey(state: TuiState, key: string): { state: TuiState; effects: Effect[] } {
  if (state.picker) return handlePicker(state, key);

  if (state.confirm) {
    if (key === 'y' || key === 'Y') {
      return {
        state: { ...state, confirm: null, status: 'Working…' },
        effects: [state.confirm.effect],
      };
    }
    return { state: { ...state, confirm: null, status: 'Cancelled' }, effects: [] };
  }

  if (state.filterInput !== null) {
    if (key === 'enter') {
      return { state: { ...state, filter: state.filterInput, filterInput: null }, effects: [] };
    }
    if (key === 'esc' || key === 'ctrl-c') {
      return { state: { ...state, filterInput: null }, effects: [] };
    }
    if (key === 'backspace') {
      return { state: { ...state, filterInput: state.filterInput.slice(0, -1) }, effects: [] };
    }
    if (key.length === 1 && key >= ' ') {
      return { state: { ...state, filterInput: state.filterInput + key }, effects: [] };
    }
    return { state, effects: [] };
  }

  switch (key) {
    case 'q':
    case 'ctrl-c':
      return { state, effects: [{ type: 'quit' }] };
    case 'tab':
      return {
        state: switchScreen(state, SCREENS[(SCREENS.indexOf(state.screen) + 1) % SCREENS.length] ?? 'artifacts'),
        effects: [],
      };
    case '1':
    case '2':
    case '3':
      return { state: switchScreen(state, SCREENS[Number(key) - 1] ?? 'artifacts'), effects: [] };
    case 'up':
    case 'k':
      return { state: moveCursor(state, -1), effects: [] };
    case 'down':
    case 'j':
      return { state: moveCursor(state, 1), effects: [] };
    case 'pgup':
      return { state: moveCursor(state, -10), effects: [] };
    case 'pgdn':
      return { state: moveCursor(state, 10), effects: [] };
    case 'home':
      return { state: { ...state, cursors: { ...state.cursors, [state.screen]: 0 } }, effects: [] };
    case 'end':
      return { state: { ...state, cursors: { ...state.cursors, [state.screen]: Math.max(0, visibleCount(state) - 1) } }, effects: [] };
    case 'r':
      return { state: { ...state, status: 'Reloading…' }, effects: [reloadEffect(state)] };
    case 's':
      return { state: { ...state, picker: { cursor: 0, input: null }, status: '' }, effects: [] };
    case '/':
    case 'f':
      return { state: { ...state, filterInput: state.filter, status: '' }, effects: [] };
    case 'esc':
      if (state.filter) return { state: { ...state, filter: '' }, effects: [] };
      if (state.marked.size > 0) {
        return { state: { ...state, marked: new Set(), status: 'Marks cleared' }, effects: [] };
      }
      return { state: { ...state, status: '' }, effects: [] };
    case 'i':
      return state.screen === 'skills'
        ? { state: { ...state, issuesOnly: !state.issuesOnly }, effects: [] }
        : { state, effects: [] };
    case ' ': {
      if (state.screen !== 'artifacts') return { state, effects: [] };

      if (state.scope) {
        const entry = currentProjectEntry(state);
        if (!entry) return { state, effects: [] };

        const nextMarked = new Set(state.marked);
        if (nextMarked.has(entry.absolutePath)) {
          nextMarked.delete(entry.absolutePath);
          return {
            state: {
              ...state,
              marked: nextMarked,
              status: nextMarked.size > 0 ? `${nextMarked.size} marked` : 'Unmarked',
            },
            effects: [],
          };
        }

        if (!cleanableEntry(entry, state.allowCaution)) {
          return {
            state: {
              ...state,
              status:
                entry.recommendedAction === 'keep'
                  ? `${entry.label} is marked keep; cannot be cleaned`
                  : `${entry.label} is ${entry.safetyLevel}; press u first to allow caution`,
            },
            effects: [],
          };
        }

        nextMarked.add(entry.absolutePath);
        const moved = moveCursor(state, 1);
        return {
          state: {
            ...moved,
            marked: nextMarked,
            status: `${nextMarked.size} marked`,
          },
          effects: [],
        };
      }

      const record = currentArtifact(state);
      if (!record) return { state, effects: [] };

      const nextMarked = new Set(state.marked);
      if (nextMarked.has(record.absolutePath)) {
        nextMarked.delete(record.absolutePath);
        return {
          state: {
            ...state,
            marked: nextMarked,
            status: nextMarked.size > 0 ? `${nextMarked.size} marked` : 'Unmarked',
          },
          effects: [],
        };
      }

      if (!cleanable(record, state.allowCaution)) {
        return {
          state: {
            ...state,
            status:
              record.recommendedAction === 'keep'
                ? `${record.name} is marked keep; cannot be cleaned`
                : `${record.name} is ${record.safetyLevel}; press u first to allow caution`,
          },
          effects: [],
        };
      }

      nextMarked.add(record.absolutePath);
      const moved = moveCursor(state, 1);
      return {
        state: {
          ...moved,
          marked: nextMarked,
          status: `${nextMarked.size} marked`,
        },
        effects: [],
      };
    }
    case 'u': {
      if (state.screen !== 'artifacts') return { state, effects: [] };
      const next = !state.allowCaution;
      return {
        state: {
          ...state,
          allowCaution: next,
          status: next ? 'Caution artifacts enabled' : 'Only safe artifacts',
        },
        effects: [],
      };
    }
    case 'c': {
      if (state.screen !== 'artifacts') return { state, effects: [] };

      if (state.scope) {
        if (state.marked.size > 0) {
          const targets = state.projectEntries.filter(
            (entry) => state.marked.has(entry.absolutePath) && cleanableEntry(entry, state.allowCaution),
          );
          if (targets.length === 0) {
            return {
              state: { ...state, status: 'no cleanable marked entries; press u to allow caution' },
              effects: [],
            };
          }
          const bytes = targets.reduce((sum, entry) => sum + entry.sizeBytes, 0);
          return {
            state: {
              ...state,
              confirm: {
                prompt: `Clean ${targets.length} marked entries (${formatBytes(bytes)})?`,
                effect: {
                  type: 'cleanProject',
                  entries: targets,
                  safetyLevels: state.allowCaution ? ['safe', 'caution'] : ['safe'],
                  project: state.scope,
                },
              },
            },
            effects: [],
          };
        }

        const entry = currentProjectEntry(state);
        if (!entry) return { state, effects: [] };
        if (!cleanableEntry(entry, state.allowCaution)) {
          return {
            state: {
              ...state,
              status:
                entry.recommendedAction === 'keep'
                  ? `${entry.label} is marked keep`
                  : `${entry.label} is ${entry.safetyLevel}; press u to allow caution`,
            },
            effects: [],
          };
        }
        return {
          state: {
            ...state,
            confirm: {
              prompt: `Clean ${entry.label} (${formatBytes(entry.sizeBytes)}) at ${entry.absolutePath}?`,
              effect: {
                type: 'cleanProject',
                entries: [entry],
                safetyLevels: [entry.safetyLevel],
                project: state.scope,
              },
            },
          },
          effects: [],
        };
      }

      if (state.marked.size > 0) {
        const targets = state.artifacts.filter(
          (record) => state.marked.has(record.absolutePath) && cleanable(record, state.allowCaution),
        );
        if (targets.length === 0) {
          return {
            state: { ...state, status: 'no cleanable marked artifacts; press u to allow caution' },
            effects: [],
          };
        }
        const bytes = targets.reduce((sum, record) => sum + record.sizeBytes, 0);
        return {
          state: {
            ...state,
            confirm: {
              prompt: `Clean ${targets.length} marked artifacts (${formatBytes(bytes)})?`,
              effect: {
                type: 'clean',
                records: targets,
                safetyLevels: state.allowCaution ? ['safe', 'caution'] : ['safe'],
              },
            },
          },
          effects: [],
        };
      }

      const record = currentArtifact(state);
      if (!record) return { state, effects: [] };
      if (!cleanable(record, state.allowCaution)) {
        return {
          state: {
            ...state,
            status:
              record.recommendedAction === 'keep'
                ? `${record.name} is marked keep`
                : `${record.name} is ${record.safetyLevel}; press u to allow caution`,
          },
          effects: [],
        };
      }
      return {
        state: {
          ...state,
          confirm: {
            prompt: `Clean ${record.name} (${formatBytes(record.sizeBytes)}) at ${record.absolutePath}?`,
            effect: { type: 'clean', records: [record], safetyLevels: [record.safetyLevel] },
          },
        },
        effects: [],
      };
    }
    case 'C': {
      if (state.screen !== 'artifacts') return { state, effects: [] };

      if (state.scope) {
        const targets = state.projectEntries.filter((entry) => cleanableEntry(entry, state.allowCaution));
        if (targets.length === 0) {
          return { state: { ...state, status: 'no cleanable entries for this project' }, effects: [] };
        }
        const bytes = targets.reduce((sum, entry) => sum + entry.sizeBytes, 0);
        return {
          state: {
            ...state,
            confirm: {
              prompt: `Clean ${targets.length} project entries (${formatBytes(bytes)})?`,
              effect: {
                type: 'cleanProject',
                entries: targets,
                safetyLevels: state.allowCaution ? ['safe', 'caution'] : ['safe'],
                project: state.scope,
              },
            },
          },
          effects: [],
        };
      }

      const targets = state.artifacts.filter((record) => cleanable(record, state.allowCaution));
      if (targets.length === 0) {
        return { state: { ...state, status: 'no cleanable artifacts' }, effects: [] };
      }
      const bytes = targets.reduce((sum, record) => sum + record.sizeBytes, 0);
      return {
        state: {
          ...state,
          confirm: {
            prompt: `Clean ${targets.length} artifacts (${formatBytes(bytes)}) across all agents?`,
            effect: {
              type: 'clean',
              records: targets,
              safetyLevels: state.allowCaution ? ['safe', 'caution'] : ['safe'],
            },
          },
        },
        effects: [],
      };
    }
    case 'd': {
      if (state.screen !== 'skills') return { state, effects: [] };
      const skill = currentSkill(state);
      if (!skill) return { state, effects: [] };
      return {
        state: { ...state, status: 'Working…' },
        effects: [{ type: 'toggleSkill', skill, enabled: !skill.enabled }],
      };
    }
    case 'x': {
      if (state.screen !== 'skills') return { state, effects: [] };
      const skill = currentSkill(state);
      if (!skill) return { state, effects: [] };
      return {
        state: {
          ...state,
          confirm: {
            prompt: `Remove ${skill.name} from ${skill.scope}? Directory: ${skill.directory}`,
            effect: { type: 'removeSkill', skill },
          },
        },
        effects: [],
      };
    }
    case 'p': {
      if (state.screen !== 'mcp') return { state, effects: [] };
      const probe = !state.probe;
      return {
        state: { ...state, probe, status: probe ? 'Probing with handshake…' : 'Command check only' },
        effects: [{ type: 'loadMcp', probe, announce: true }],
      };
    }
    default:
      return { state, effects: [] };
  }
}

export function applyEvent(state: TuiState, event: TuiEvent): { state: TuiState; effects: Effect[] } {
  switch (event.type) {
    case 'key':
      return handleKey(state, event.key);
    case 'artifacts':
      return {
        state: {
          ...state,
          artifacts: event.records,
          artifactsLoaded: true,
          artifactsBusy: false,
          marked: new Set(),
          status: event.announce ? `${event.records.length} artifacts` : state.status,
        },
        effects: [],
      };
    case 'skills':
      return {
        state: {
          ...state,
          skills: event.records,
          skillsLoaded: true,
          skillsBusy: false,
          status: event.announce ? `${event.records.length} skills` : state.status,
        },
        effects: [],
      };
    case 'mcp':
      return {
        state: {
          ...state,
          mcp: event.data,
          mcpBusy: false,
          status: event.announce ? `${event.data.statuses.length} servers` : state.status,
        },
        effects: [],
      };
    case 'project':
      return {
        state: {
          ...state,
          projectEntries: event.entries,
          projectBusy: false,
          marked: new Set(),
          status: event.announce ? `${event.entries.length} entries for this project` : state.status,
        },
        effects: [],
      };
    case 'projectBusy':
      return { state: { ...state, projectBusy: event.busy }, effects: [] };
    case 'openScope':
      return { state: { ...state, picker: { cursor: 0, input: null }, status: '' }, effects: [] };
    case 'busy': {
      if (event.screen === 'artifacts') {
        return { state: { ...state, artifactsBusy: event.busy }, effects: [] };
      }
      if (event.screen === 'skills') {
        return { state: { ...state, skillsBusy: event.busy }, effects: [] };
      }
      return { state: { ...state, mcpBusy: event.busy }, effects: [] };
    }
    case 'status':
      return { state: { ...state, status: event.message }, effects: [] };
    case 'error':
      return { state: { ...state, error: event.message, status: event.message }, effects: [] };
  }
}
