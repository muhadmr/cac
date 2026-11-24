import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord, CleanOptions, CleanResult, SafetyLevel } from './types';
import type { ProjectEntry } from './projects';
import { HOME } from './scanner';

/** Guard: target must sit at least one segment below one of the allowed roots. */
function isSafeTarget(absolutePath: string, roots: string[] = [HOME]): boolean {
  const resolved = path.resolve(absolutePath);
  return roots.some((root) => {
    const base = path.resolve(root);
    if (resolved === base) return false;
    if (!resolved.startsWith(base + path.sep)) return false;
    return resolved.split(path.sep).length > base.split(path.sep).length;
  });
}

/** SQLite sidecars and lock files belong to a live process. */
const PROTECTED_SUFFIXES = ['.db-wal', '.db-shm', '.sqlite-wal', '.sqlite-shm', '.lock'];

function isProtected(absolutePath: string): boolean {
  const lower = absolutePath.toLowerCase();
  return PROTECTED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function allowed(
  safetyLevel: SafetyLevel,
  recommendedAction: string,
  sizeBytes: number,
  safetyLevels: SafetyLevel[],
): boolean {
  if (sizeBytes === 0) return false;
  if (recommendedAction !== 'clean') return false;
  if (safetyLevel === 'critical') return false;
  return safetyLevels.includes(safetyLevel);
}

export function selectTargets(records: ArtifactRecord[], options: CleanOptions = {}): ArtifactRecord[] {
  const { agents, categories, safetyLevels = ['safe'] } = options;

  return records.filter((record) => {
    if (!record.exists || record.sizeBytes === 0) return false;
    if (record.recommendedAction !== 'clean') return false;
    if (record.safetyLevel === 'critical') return false;
    if (!safetyLevels.includes(record.safetyLevel)) return false;
    if (agents && !agents.includes(record.agent)) return false;
    if (categories && !categories.includes(record.category)) return false;
    if (isProtected(record.absolutePath)) return false;
    return isSafeTarget(record.absolutePath);
  });
}

export async function cleanArtifacts(
  records: ArtifactRecord[],
  options: CleanOptions = {},
): Promise<CleanResult[]> {
  const dryRun = options.dryRun ?? true;
  const targets = selectTargets(records, options);
  const results: CleanResult[] = [];

  for (const artifact of targets) {
    if (dryRun) {
      results.push({ artifact, cleaned: false, bytesFreed: 0 });
      continue;
    }

    try {
      await rm(artifact.absolutePath, { recursive: true, force: true });
      results.push({ artifact, cleaned: true, bytesFreed: artifact.sizeBytes });
    } catch (error) {
      results.push({
        artifact,
        cleaned: false,
        bytesFreed: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export interface ProjectCleanOptions {
  projectRoot: string;
  dryRun?: boolean;
  safetyLevels?: SafetyLevel[];
}

export interface ProjectCleanResult {
  entry: ProjectEntry;
  cleaned: boolean;
  bytesFreed: number;
  error?: string;
}

/** Targets inside the project tree or the home tree, same rules as home cleanup. */
export function selectProjectTargets(
  entries: ProjectEntry[],
  options: ProjectCleanOptions,
): ProjectEntry[] {
  const safetyLevels = options.safetyLevels ?? ['safe'];
  const roots = [path.resolve(options.projectRoot), path.resolve(HOME)];

  return entries.filter((entry) => {
    if (!entry.exists) return false;
    if (!allowed(entry.safetyLevel, entry.recommendedAction, entry.sizeBytes, safetyLevels)) return false;
    if (isProtected(entry.absolutePath)) return false;
    return isSafeTarget(entry.absolutePath, roots);
  });
}

export async function cleanProjectEntries(
  entries: ProjectEntry[],
  options: ProjectCleanOptions,
): Promise<ProjectCleanResult[]> {
  const dryRun = options.dryRun ?? true;
  const results: ProjectCleanResult[] = [];

  for (const entry of selectProjectTargets(entries, options)) {
    if (dryRun) {
      results.push({ entry, cleaned: false, bytesFreed: 0 });
      continue;
    }

    try {
      await rm(entry.absolutePath, { recursive: true, force: true });
      results.push({ entry, cleaned: true, bytesFreed: entry.sizeBytes });
    } catch (error) {
      results.push({
        entry,
        cleaned: false,
        bytesFreed: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
