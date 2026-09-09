import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createResourceDeletionModel } from '../models/resourceDeletion';
import { createResourceDeletionMethods } from './resourceDeletion';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';

const Model = createResourceDeletionModel(mongoose);
const methods = createResourceDeletionMethods(mongoose);
let server: MongoMemoryServer;
const target = {
  kind: 'file' as const,
  resourceIds: ['file_root'],
  gateways: [{ endpoint: 'SG AI Gateway', conversationId: 'conversation' }],
};
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Model.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await Model.deleteMany({});
  });
});

test('persists one idempotent deletion intent and rejects target changes', async () => {
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => methods.beginResourceDeletion('owner', target)),
  );
  const original = concurrent[0];
  expect(new Set(concurrent.map((job) => job._id)).size).toBe(1);
  expect((await methods.beginResourceDeletion('owner', target))._id).toBe(original._id);
  expect(await Model.countDocuments()).toBe(1);
  await expect(
    methods.beginResourceDeletion('owner', {
      ...target,
      gateways: [{ endpoint: 'other', conversationId: 'conversation' }],
    }),
  ).rejects.toThrow('resource_deletion_target_conflict');
  expect((await Model.findById(original._id))?.gateways[0].endpoint).toBe('SG AI Gateway');
});

test('only one worker can hold a lease and an expired worker cannot complete it', async () => {
  const job = await methods.beginResourceDeletion('owner', target);
  const claims = await Promise.all([
    methods.claimResourceDeletion('owner', job._id),
    methods.claimResourceDeletion('owner', job._id),
  ]);
  const active = claims.find((value) => value !== null)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await methods.claimResourceDeletion('other', job._id)).toBeNull();
  await Model.updateOne({ _id: job._id }, { leaseUntil: new Date(0) });
  expect(await methods.finishResourceDeletion('owner', job._id, active.leaseToken!)).toBe(false);
  const resumed = await methods.claimResourceDeletion('owner', job._id);
  expect(resumed?.attempts).toBe(2);
  expect(resumed?.leaseToken).not.toBe(active.leaseToken);
  expect(
    await methods.recordResourceDeletionTargets(
      'owner',
      job._id,
      active.leaseToken!,
      ['file_late'],
      [],
    ),
  ).toBe(false);
  expect(await methods.finishResourceDeletion('owner', job._id, resumed!.leaseToken!)).toBe(false);
  await methods.recordResourceDeletionTargets(
    'owner',
    job._id,
    resumed!.leaseToken!,
    ['file_root'],
    [],
  );
  expect(await methods.finishResourceDeletion('owner', job._id, resumed!.leaseToken!)).toBe(true);
  expect(await methods.claimResourceDeletion('owner', job._id)).toBeNull();
});

test('reopened methods resume persisted targets and completed tombstones remain a write barrier', async () => {
  const job = await methods.beginResourceDeletion('owner', target);
  const active = await methods.claimResourceDeletion('owner', job._id);
  expect(
    await methods.recordResourceDeletionTargets(
      'owner',
      job._id,
      active!.leaseToken!,
      ['file_child', 'file_root'],
      ['request'],
    ),
  ).toBe(true);
  expect(
    await methods.releaseResourceDeletion(
      'owner',
      job._id,
      active!.leaseToken!,
      'storage_unavailable',
    ),
  ).toBe(true);
  const reopened = createResourceDeletionMethods(mongoose);
  const pending = await runAsSystem(async () => reopened.listPendingResourceDeletions());
  expect(pending).toHaveLength(1);
  expect(new Set(pending[0].fileIds)).toEqual(new Set(['file_root', 'file_child']));
  expect(pending[0].errorCode).toBe('storage_unavailable');
  expect(await reopened.isResourceWriteBlocked('owner', [], ['file_child'])).toBe(true);
  expect(await reopened.isResourceWriteBlocked('owner', [], [], 'request')).toBe(true);
  expect(await reopened.isResourceWriteBlocked('other', [], ['file_child'])).toBe(false);
  expect(await reopened.isResourceWriteBlocked('owner', ['conversation'], ['file_other'])).toBe(
    false,
  );
  const resumed = await reopened.claimResourceDeletion('owner', job._id);
  await reopened.finishResourceDeletion('owner', job._id, resumed!.leaseToken!);
  expect(await runAsSystem(async () => reopened.listPendingResourceDeletions())).toEqual([]);
  expect(await reopened.isResourceWriteBlocked('owner', [], ['file_root'])).toBe(true);
});

test('conversation intents close selected logical and draft scopes only', async () => {
  await methods.beginResourceDeletion('owner', {
    kind: 'conversation',
    resourceIds: ['conversation'],
    gateways: [{ endpoint: 'SG AI Gateway', conversationId: 'draft-old' }],
  });
  expect(await methods.isResourceWriteBlocked('owner', ['conversation'])).toBe(true);
  expect(await methods.isResourceWriteBlocked('owner', ['draft-old'])).toBe(true);
  expect(await methods.isResourceWriteBlocked('owner', ['another'])).toBe(false);
  expect(await methods.isResourceWriteBlocked('other', ['conversation'])).toBe(false);
});

test('normalizes duplicate IDs and scope order without reopening completed work', async () => {
  const gateways = [
    { endpoint: 'B', conversationId: 'two' },
    { endpoint: 'A', conversationId: 'one' },
  ];
  const first = await methods.beginResourceDeletion('owner', {
    kind: 'conversation',
    resourceIds: ['two', 'one', 'two'],
    gateways,
  });
  const lease = await methods.claimResourceDeletion('owner', first._id);
  await methods.recordResourceDeletionTargets('owner', first._id, lease!.leaseToken!, [], []);
  await methods.finishResourceDeletion('owner', first._id, lease!.leaseToken!);
  const repeated = await methods.beginResourceDeletion('owner', {
    kind: 'conversation',
    resourceIds: ['one', 'two'],
    gateways: [...gateways].reverse(),
  });
  expect(repeated._id).toBe(first._id);
  expect(repeated.state).toBe('complete');
  expect(repeated.attempts).toBe(1);
});

test('tenant-scoped identities cannot claim or block another tenant resources', async () => {
  const first = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
    methods.beginResourceDeletion('owner', target),
  );
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    expect(await methods.claimResourceDeletion('owner', first._id)).toBeNull();
    expect(await methods.isResourceWriteBlocked('owner', [], ['file_root'])).toBe(false);
    expect((await methods.beginResourceDeletion('owner', target))._id).not.toBe(first._id);
  });
  await expect(methods.listPendingResourceDeletions()).rejects.toThrow('system_scope_required');
  expect(await runAsSystem(async () => methods.listPendingResourceDeletions())).toHaveLength(2);
});

test('does not record free-form input and refuses a different authenticated owner', async () => {
  const input = {
    ...target,
    body: 'private document content',
    apiKey: 'private-test-key',
    gateways: [{ ...target.gateways[0], secret: 'private-provider-key' }],
  };
  const stored = await methods.beginResourceDeletion('owner', input);
  expect(JSON.stringify(stored)).not.toContain('private-');
  expect(JSON.stringify(stored)).not.toContain('private document');
  await expect(
    tenantStorage.run({ userId: 'different' }, async () =>
      methods.beginResourceDeletion('owner', target),
    ),
  ).rejects.toThrow('resource_deletion_owner_mismatch');
});

async function completedTarget(resourceId = 'file_root') {
  const job = await methods.beginResourceDeletion('owner', {
    ...target,
    resourceIds: [resourceId],
  });
  const lease = await methods.claimResourceDeletion('owner', job._id);
  await methods.recordResourceDeletionTargets(
    'owner',
    job._id,
    lease!.leaseToken!,
    [resourceId],
    [],
  );
  await methods.finishResourceDeletion('owner', job._id, lease!.leaseToken!);
  return job;
}

test('reconciliation leases never reopen a completed deletion and reject stale workers', async () => {
  const job = await completedTarget();
  const claims = await Promise.all([
    methods.claimResourceReconciliation('owner', job._id),
    methods.claimResourceReconciliation('owner', job._id),
  ]);
  const active = claims.find(Boolean)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(active).toMatchObject({ state: 'complete', attempts: 1, reconcileAttempts: 1 });
  expect(await methods.claimResourceReconciliation('other', job._id)).toBeNull();
  await Model.updateOne({ _id: job._id }, { leaseUntil: new Date(0) });
  expect(await methods.finishResourceReconciliation('owner', job._id, active.leaseToken!)).toBe(
    false,
  );
  expect(
    await methods.recordReconciliationFiles('owner', job._id, active.leaseToken!, ['file_stale']),
  ).toBe(false);
  const resumed = await methods.claimResourceReconciliation('owner', job._id);
  expect(
    await methods.finishResourceReconciliation('owner', job._id, active.leaseToken!, true),
  ).toBe(false);
  expect(await methods.finishResourceReconciliation('owner', job._id, resumed!.leaseToken!)).toBe(
    true,
  );
  expect(await methods.getResourceDeletion('owner', job._id)).toMatchObject({
    state: 'complete',
    attempts: 1,
    reconcileAttempts: 2,
    reconcileFailed: false,
  });
  expect(await methods.isResourceWriteBlocked('owner', [], ['file_root'])).toBe(true);
});

test('completed reconciliation discovery is system-only and failed work rotates behind waiting records', async () => {
  await completedTarget('file_one');
  await completedTarget('file_two');
  await expect(methods.listResourceReconciliations()).rejects.toThrow('system_scope_required');
  const [first] = await runAsSystem(async () => methods.listResourceReconciliations(1));
  const lease = await methods.claimResourceReconciliation('owner', first._id);
  await methods.finishResourceReconciliation('owner', first._id, lease!.leaseToken!, true);
  const [next] = await runAsSystem(async () => methods.listResourceReconciliations(1));
  expect(next._id).not.toBe(first._id);
  expect(await methods.getResourceDeletion('owner', first._id)).toMatchObject({
    state: 'complete',
    reconcileFailed: true,
  });
});

test('deleted-file lookup returns only requested IDs across lookup batches and owner scopes', async () => {
  const job = await completedTarget();
  const lease = await methods.claimResourceReconciliation('owner', job._id);
  await methods.recordReconciliationFiles('owner', job._id, lease!.leaseToken!, [
    'file_204',
    'file_unrequested',
  ]);
  const ids = Array.from({ length: 205 }, (_, index) => `file_${index}`);
  expect(await methods.getDeletedFileIds('owner', ids)).toEqual(['file_204']);
  expect(await methods.getDeletedFileIds('other', ids)).toEqual([]);
  expect(await methods.getDeletedFileIds('owner', [])).toEqual([]);
});

test('deleted-file lookup cannot borrow another tenant tombstone', async () => {
  await tenantStorage.run({ tenantId: 'tenant-a' }, async () => completedTarget());
  await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
    expect(await methods.getDeletedFileIds('owner', ['file_root'])).toEqual([]);
  });
});
