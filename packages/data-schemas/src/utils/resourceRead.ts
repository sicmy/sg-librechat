import type { PipelineStage } from 'mongoose';
import { SG_UPLOAD_TTL_GRACE_MS } from './uploadExpiry';

/** Join before pagination so hidden rows cannot consume a visible page or leak a cursor. */
export function excludeDeletedConversations(includeFiles = false): PipelineStage[] {
  return [
    ...(includeFiles
      ? [
          {
            $match: {
              $or: [
                { source: { $ne: 'sg_gateway' } },
                {
                  $and: [
                    { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
                    {
                      $or: [
                        { sgUploadExpiresAt: null },
                        {
                          sgUploadExpiresAt: { $gt: new Date(Date.now() - SG_UPLOAD_TTL_GRACE_MS) },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ]
      : []),
    {
      $lookup: {
        from: 'resource_deletions',
        let: {
          owner: { $toString: '$user' },
          conversation: '$conversationId',
          draft: includeFiles ? { $ifNull: ['$metadata.sgGateway.conversationId', ''] } : '',
          endpoint: includeFiles ? { $ifNull: ['$metadata.sgGateway.endpoint', ''] } : '',
          file: includeFiles ? '$file_id' : '',
          sourceFile: includeFiles ? { $ifNull: ['$metadata.sgGateway.sourceFileId', ''] } : '',
          request: includeFiles ? { $ifNull: ['$metadata.sgGateway.requestMessageId', ''] } : '',
          tenant: { $ifNull: ['$tenantId', null] },
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$userId', '$$owner'] },
                  { $eq: [{ $ifNull: ['$tenantId', null] }, '$$tenant'] },
                  {
                    $or: [
                      {
                        $and: [
                          { $eq: ['$kind', 'conversation'] },
                          ...(includeFiles
                            ? [
                                {
                                  $not: [
                                    { $in: ['$$file', { $ifNull: ['$protectedFileIds', []] }] },
                                  ],
                                },
                              ]
                            : []),
                          {
                            $or: [
                              { $in: ['$$conversation', { $ifNull: ['$resourceIds', []] }] },
                              ...(includeFiles
                                ? [
                                    {
                                      $anyElementTrue: [
                                        {
                                          $map: {
                                            input: { $ifNull: ['$gateways', []] },
                                            as: 'gateway',
                                            in: {
                                              $and: [
                                                { $eq: ['$$gateway.endpoint', '$$endpoint'] },
                                                { $eq: ['$$gateway.conversationId', '$$draft'] },
                                              ],
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  ]
                                : [
                                    {
                                      $in: [
                                        '$$conversation',
                                        { $ifNull: ['$gateways.conversationId', []] },
                                      ],
                                    },
                                  ]),
                            ],
                          },
                        ],
                      },
                      ...(includeFiles
                        ? [
                            { $in: ['$$file', { $ifNull: ['$fileIds', []] }] },
                            { $in: ['$$sourceFile', { $ifNull: ['$fileIds', []] }] },
                            {
                              $and: [
                                { $in: ['$$request', { $ifNull: ['$requestMessageIds', []] }] },
                                {
                                  $anyElementTrue: [
                                    {
                                      $map: {
                                        input: { $ifNull: ['$gateways', []] },
                                        as: 'gateway',
                                        in: {
                                          $and: [
                                            { $eq: ['$$gateway.endpoint', '$$endpoint'] },
                                            { $eq: ['$$gateway.conversationId', '$$draft'] },
                                          ],
                                        },
                                      },
                                    },
                                  ],
                                },
                              ],
                            },
                          ]
                        : []),
                    ],
                  },
                ],
              },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: '_sgDeletion',
      },
    },
    { $match: { '_sgDeletion.0': { $exists: false } } },
    { $unset: '_sgDeletion' },
  ];
}
