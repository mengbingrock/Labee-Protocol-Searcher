import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AttemptRecord,
  DeepSearchSpec,
  FindingRecord,
  JobProgress,
  JobStore,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertJobId(id: string): void {
  if (!UUID.test(id)) throw new Error(`Invalid job id: ${id}`);
}

function defaultRoot(): string {
  if (process.env.PROTOCOLS_AGENT_DATA_DIR?.trim()) return process.env.PROTOCOLS_AGENT_DATA_DIR.trim();
  const state = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(state, "labee-protocol-searcher", "jobs");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter((line) => line.trim());
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]!) as T);
    } catch {
      if (i !== lines.length - 1) throw new Error(`Corrupt JSONL at ${path}:${i + 1}`);
    }
  }
  return out;
}

export class FileJobStore implements JobStore {
  readonly root: string;

  constructor(root = defaultRoot()) {
    this.root = root;
  }

  private jobDir(id: string): string {
    assertJobId(id);
    return join(this.root, id);
  }

  async create(spec: DeepSearchSpec): Promise<JobProgress> {
    const id = randomUUID();
    const now = spec.createdAt;
    const progress: JobProgress = {
      id,
      status: "queued",
      iteration: 0,
      staleCount: 0,
      searchedKeywords: [],
      resultOccurrences: 0,
      uniqueResults: 0,
      nativeFetchAttempts: 0,
      backendAttempts: 0,
      fetchedResults: 0,
      verifiedResults: 0,
      browserPages: 0,
      browserSearchPages: 0,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    const dir = this.jobDir(id);
    await mkdir(join(dir, "state"), { recursive: true, mode: 0o700 });
    await mkdir(join(dir, "logs"), { recursive: true, mode: 0o700 });
    await atomicJson(join(dir, "state", "task_spec.json"), spec);
    await atomicJson(join(dir, "state", "progress.json"), progress);
    await atomicJson(join(dir, "state", "directions_tried.json"), { directions: [] });
    return progress;
  }

  readSpec(id: string): Promise<DeepSearchSpec> {
    return readJson(join(this.jobDir(id), "state", "task_spec.json"));
  }

  readProgress(id: string): Promise<JobProgress> {
    return readJson(join(this.jobDir(id), "state", "progress.json"));
  }

  writeProgress(id: string, progress: JobProgress): Promise<void> {
    return atomicJson(join(this.jobDir(id), "state", "progress.json"), progress);
  }

  appendFinding(id: string, finding: FindingRecord): Promise<void> {
    return appendFile(
      join(this.jobDir(id), "state", "findings.jsonl"),
      `${JSON.stringify(finding)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  appendAttempt(id: string, attempt: AttemptRecord): Promise<void> {
    return appendFile(
      join(this.jobDir(id), "logs", "attempts.jsonl"),
      `${JSON.stringify(attempt)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  readFindings(id: string): Promise<FindingRecord[]> {
    return readJsonl(join(this.jobDir(id), "state", "findings.jsonl"));
  }

  readAttempts(id: string): Promise<AttemptRecord[]> {
    return readJsonl(join(this.jobDir(id), "logs", "attempts.jsonl"));
  }

  async listIncomplete(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const progress = await this.readProgress(entry.name);
        if (progress.status === "queued" || progress.status === "running") ids.push(entry.name);
      } catch {
        // Ignore incomplete/corrupt directories; they are not resumable jobs.
      }
    }
    return ids.sort();
  }
}
