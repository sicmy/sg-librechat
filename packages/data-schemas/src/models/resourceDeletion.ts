import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export interface ResourceDeletionTarget {
  protectedFileIds?: string[];
  kind: 'file' | 'conversation';
  resourceIds: string[];
  gateways: Array<{ endpoint: string; conversationId: string }>;
}

export interface ResourceDeletionRecord extends ResourceDeletionTarget {
  _id: string;
  userId: string;
  tenantId?: string;
  state: 'pending' | 'complete';
  fileIds: string[];
  requestMessageIds: string[];
  attempts: number;
  remoteComplete: boolean;
  reconciledAt?: Date | null;
  reconcileAttempts?: number;
  reconcileFailed?: boolean;
  leaseToken?: string | null;
  leaseUntil?: Date | null;
  errorCode?: 'cleanup_failed' | 'gateway_unavailable' | 'storage_unavailable' | null;
  createdAt: Date;
  updatedAt: Date;
}

export function createResourceDeletionModel(
  mongoose: typeof import('mongoose'),
): Model<ResourceDeletionRecord> {
  const schema = new Schema<ResourceDeletionRecord>(
    {
      _id: { type: String, required: true },
      userId: { type: String, required: true, index: true },
      tenantId: { type: String, index: true },
      kind: { type: String, enum: ['file', 'conversation'], required: true },
      resourceIds: { type: [String], required: true },
      protectedFileIds: { type: [String], default: [] },
      gateways: [
        {
          _id: false,
          endpoint: { type: String, required: true },
          conversationId: { type: String, required: true },
        },
      ],
      state: { type: String, enum: ['pending', 'complete'], default: 'pending', required: true },
      fileIds: { type: [String], default: [] },
      requestMessageIds: { type: [String], default: [] },
      attempts: { type: Number, default: 0, min: 0 },
      remoteComplete: { type: Boolean, default: false },
      reconciledAt: { type: Date, default: null },
      reconcileAttempts: { type: Number, default: 0, min: 0 },
      reconcileFailed: { type: Boolean, default: false },
      leaseToken: { type: String, default: null },
      leaseUntil: { type: Date, default: null },
      errorCode: {
        type: String,
        enum: ['cleanup_failed', 'gateway_unavailable', 'storage_unavailable', null],
        default: null,
      },
    },
    { timestamps: true, strict: 'throw', collection: 'resource_deletions' },
  );
  applyTenantIsolation(schema);
  schema.index({ userId: 1, kind: 1, resourceIds: 1 });
  schema.index({ state: 1, leaseUntil: 1, createdAt: 1 });
  schema.index({ state: 1, reconciledAt: 1, _id: 1 });
  return (
    (mongoose.models.ResourceDeletion as Model<ResourceDeletionRecord>) ||
    mongoose.model<ResourceDeletionRecord>('ResourceDeletion', schema)
  );
}
