import type { Backend, BackendId, ModelDescriptor } from "./types.js";

export interface ProbeResult {
  backendId: BackendId;
  models: ModelDescriptor[];
}

export interface ProbeFailure {
  backendId: BackendId;
  error: Error;
}

export interface ProbeOutcome {
  successes: ProbeResult[];
  failures: ProbeFailure[];
}

export interface ProbeStatus {
  ok: boolean;
  lastProbedAt: Date;
  error?: string;
}

export type PriorityMap = Record<BackendId, number>;

export class BackendRegistry {
  private readonly backends = new Map<BackendId, Backend>();
  private modelMap = new Map<string, BackendId>();
  private probeStatus = new Map<BackendId, ProbeStatus>();
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly priorities: PriorityMap) {}

  register(backend: Backend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: BackendId): Backend | undefined {
    return this.backends.get(id);
  }

  enabledBackends(): Backend[] {
    return Array.from(this.backends.values());
  }

  resolveModel(modelId: string): Backend | undefined {
    const id = this.modelMap.get(modelId);
    return id ? this.backends.get(id) : undefined;
  }

  lastProbeStatus(id: BackendId): ProbeStatus | undefined {
    return this.probeStatus.get(id);
  }

  async probe(): Promise<ProbeOutcome> {
    const successes: ProbeResult[] = [];
    const failures: ProbeFailure[] = [];

    await Promise.all(
      Array.from(this.backends.values()).map(async (backend) => {
        try {
          const models = await backend.listModels();
          successes.push({ backendId: backend.id, models });
          this.probeStatus.set(backend.id, { ok: true, lastProbedAt: new Date() });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          failures.push({ backendId: backend.id, error });
          this.probeStatus.set(backend.id, {
            ok: false,
            lastProbedAt: new Date(),
            error: error.message
          });
        }
      })
    );

    this.rebuildModelMap(successes);
    return { successes, failures };
  }

  startPeriodicProbe(intervalMs: number): void {
    void this.probe();
    this.intervalHandle = setInterval(() => {
      void this.probe();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  private rebuildModelMap(successes: ProbeResult[]): void {
    const next = new Map<string, BackendId>();
    // Sort backends by ascending priority so winners (high priority) overwrite losers (low priority).
    const sorted = [...successes].sort(
      (a, b) =>
        (this.priorities[a.backendId] ?? 0) -
        (this.priorities[b.backendId] ?? 0)
    );
    for (const { backendId, models } of sorted) {
      for (const m of models) next.set(m.id, backendId);
    }
    this.modelMap = next;
  }
}
