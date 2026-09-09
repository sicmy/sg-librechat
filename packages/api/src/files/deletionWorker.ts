import { logger, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type {
  AppConfig,
  ResourceDeletionRecord,
  SchemaWithMeiliMethods,
} from '@librechat/data-schemas';
import type { SGFileDeletionMethods } from './lifecycle';
import { resumeSGFileDeletion, resolveSGDeletionEndpoint } from './lifecycle';

type WorkerOptions = {
  methods: SGFileDeletionMethods;
  loadConfig: (tenantId?: string) => Promise<AppConfig | undefined>;
  batchSize?: number;
  resumeConversation?: (job: ResourceDeletionRecord) => Promise<void>;
  reconcile?: (job: ResourceDeletionRecord) => Promise<boolean>;
  expireConversations?: () => Promise<void>;
  cleanupSearch?: () => Promise<void>;
};

export async function runSGSearchCleanup(
  models: Array<Partial<Pick<SchemaWithMeiliMethods, 'sweepMeiliIndex'>>>,
): Promise<{ completed: number; failed: number }> {
  const results = await runAsSystem(async () =>
    Promise.allSettled(
      models
        .filter((model) => typeof model.sweepMeiliIndex === 'function')
        .map(async (model) => model.sweepMeiliIndex!()),
    ),
  );
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) logger.warn('SG search index cleanup deferred');
  return { completed: results.length - failed, failed };
}

export async function runSGReconciliationPass(
  options: WorkerOptions,
): Promise<{ reconciled: number; failed: number }> {
  if (!options.reconcile) return { reconciled: 0, failed: 0 };
  const jobs = await runAsSystem(async () =>
    options.methods.listResourceReconciliations(options.batchSize ?? 8),
  );
  let reconciled = 0,
    failed = 0;
  for (const job of jobs) {
    try {
      if (
        await tenantStorage.run({ tenantId: job.tenantId, userId: job.userId }, async () =>
          options.reconcile!(job),
        )
      )
        reconciled++;
    } catch {
      failed++;
      logger.warn('SG completed deletion reconciliation deferred');
    }
  }
  return { reconciled, failed };
}

export async function runSGFileDeletionPass({
  methods,
  loadConfig,
  batchSize = 8,
  resumeConversation,
}: WorkerOptions): Promise<{ completed: number; failed: number }> {
  const jobs = await runAsSystem(async () =>
    methods.listPendingResourceDeletions(batchSize, resumeConversation ? undefined : 'file'),
  );
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await tenantStorage.run({ tenantId: job.tenantId, userId: job.userId }, async () => {
        if (job.kind === 'conversation' && resumeConversation) {
          await resumeConversation(job);
          return;
        }
        await resumeSGFileDeletion({
          job,
          methods,
          configuration: async () => {
            const config = await loadConfig(job.tenantId);
            return {
              endpointConfig: resolveSGDeletionEndpoint(job.gateways[0].endpoint, config),
              allowedAddresses: config?.endpoints?.allowedAddresses,
            };
          },
        });
      });
      completed++;
    } catch {
      failed++;
      logger.warn('SG file deletion remains queued');
    }
  }
  return { completed, failed };
}

export function startSGFileDeletionWorker(
  options: WorkerOptions & { intervalMs?: number },
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1000)
    throw new Error('invalid_deletion_worker_interval');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    const deletionPass = options.expireConversations
      ? Promise.resolve()
          .then(() => options.expireConversations!())
          .catch(() => logger.warn('SG conversation expiry sweep deferred'))
          .then(() => runSGFileDeletionPass(options))
      : runSGFileDeletionPass(options);
    running = deletionPass
      .then(async () => {
        await runSGReconciliationPass(options);
        await options.cleanupSearch?.();
      })
      .catch(() => {
        logger.warn('SG file deletion sweep deferred');
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, intervalMs);
          timer.unref();
        }
      });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
