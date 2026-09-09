import type { PipelineStage } from 'mongoose';

const array = (path: string) => ({ $cond: [{ $isArray: path }, path, []] });

/** Redact structured file references only; never rewrite the user's conversation text. */
export function redactDeletedFileReferences(): PipelineStage[] {
  const artifacts = array('$metadata.sgArtifacts.artifacts');
  const citations = array('$metadata.sgCitations.citations');
  const files = array('$files');
  const retainedArtifacts = {
    $filter: {
      input: artifacts,
      as: 'artifact',
      cond: {
        $and: [
          { $not: [{ $in: ['$$artifact.file_id', '$_sgDeletedIds'] }] },
          { $not: [{ $in: ['$$artifact.source_file_id', '$_sgDeletedIds'] }] },
        ],
      },
    },
  };
  const retainedCitations = {
    $filter: {
      input: citations,
      as: 'citation',
      cond: { $not: [{ $in: ['$$citation.file_id', '$_sgDeletedIds'] }] },
    },
  };
  const cancelled = {
    $or: ['$_sgCancelledRequest', { $lt: [{ $size: retainedArtifacts }, { $size: artifacts }] }],
  };
  return [
    {
      $lookup: {
        from: 'resource_deletions',
        let: {
          owner: { $toString: '$user' },
          tenant: { $ifNull: ['$tenantId', null] },
          conversation: '$conversationId',
          request: '$metadata.sgGeneration.requestMessageId',
          refs: {
            $setUnion: [
              { $map: { input: files, as: 'file', in: '$$file.file_id' } },
              { $map: { input: artifacts, as: 'artifact', in: '$$artifact.file_id' } },
              { $map: { input: artifacts, as: 'artifact', in: '$$artifact.source_file_id' } },
              { $map: { input: citations, as: 'citation', in: '$$citation.file_id' } },
            ],
          },
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
                      { $gt: [{ $size: { $setIntersection: ['$$refs', '$fileIds'] } }, 0] },
                      {
                        $and: [
                          { $in: ['$$request', '$requestMessageIds'] },
                          { $in: ['$$conversation', '$gateways.conversationId'] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            $project: {
              fileIds: 1,
              cancelled: {
                $and: [
                  { $in: ['$$request', '$requestMessageIds'] },
                  { $in: ['$$conversation', '$gateways.conversationId'] },
                ],
              },
            },
          },
        ],
        as: '_sgReferenceDeletes',
      },
    },
    {
      $set: {
        _sgDeletedIds: {
          $reduce: {
            input: '$_sgReferenceDeletes',
            initialValue: [],
            in: { $setUnion: ['$$value', '$$this.fileIds'] },
          },
        },
        _sgCancelledRequest: {
          $anyElementTrue: [
            { $map: { input: '$_sgReferenceDeletes', as: 'job', in: '$$job.cancelled' } },
          ],
        },
      },
    },
    {
      $set: {
        _sgDeletedIds: {
          $setUnion: [
            '$_sgDeletedIds',
            {
              $map: {
                input: {
                  $filter: {
                    input: artifacts,
                    as: 'artifact',
                    cond: {
                      $or: [
                        '$_sgCancelledRequest',
                        { $in: ['$$artifact.file_id', '$_sgDeletedIds'] },
                        { $in: ['$$artifact.source_file_id', '$_sgDeletedIds'] },
                      ],
                    },
                  },
                },
                as: 'artifact',
                in: '$$artifact.file_id',
              },
            },
          ],
        },
      },
    },
    {
      $replaceWith: {
        $cond: [
          { $gt: [{ $size: '$_sgReferenceDeletes' }, 0] },
          {
            $mergeObjects: [
              '$$ROOT',
              {
                files: {
                  $filter: {
                    input: files,
                    as: 'file',
                    cond: { $not: [{ $in: ['$$file.file_id', '$_sgDeletedIds'] }] },
                  },
                },
                metadata: {
                  $arrayToObject: {
                    $filter: {
                      input: {
                        $map: {
                          input: {
                            $objectToArray: {
                              $cond: [{ $eq: [{ $type: '$metadata' }, 'object'] }, '$metadata', {}],
                            },
                          },
                          as: 'entry',
                          in: {
                            k: '$$entry.k',
                            v: {
                              $switch: {
                                branches: [
                                  {
                                    case: { $eq: ['$$entry.k', 'sgArtifacts'] },
                                    then: {
                                      $cond: [
                                        {
                                          $and: [
                                            { $not: ['$_sgCancelledRequest'] },
                                            { $gt: [{ $size: retainedArtifacts }, 0] },
                                          ],
                                        },
                                        {
                                          $mergeObjects: [
                                            '$$entry.v',
                                            { artifacts: retainedArtifacts },
                                          ],
                                        },
                                        null,
                                      ],
                                    },
                                  },
                                  {
                                    case: { $eq: ['$$entry.k', 'sgCitations'] },
                                    then: {
                                      $cond: [
                                        { $gt: [{ $size: retainedCitations }, 0] },
                                        {
                                          $mergeObjects: [
                                            '$$entry.v',
                                            { citations: retainedCitations },
                                          ],
                                        },
                                        null,
                                      ],
                                    },
                                  },
                                  {
                                    case: { $eq: ['$$entry.k', 'sgGeneration'] },
                                    then: {
                                      $cond: [
                                        cancelled,
                                        {
                                          $cond: [
                                            { $eq: [{ $type: '$$entry.v' }, 'object'] },
                                            {
                                              $mergeObjects: ['$$entry.v', { state: 'cancelled' }],
                                            },
                                            null,
                                          ],
                                        },
                                        '$$entry.v',
                                      ],
                                    },
                                  },
                                ],
                                default: '$$entry.v',
                              },
                            },
                          },
                        },
                      },
                      as: 'entry',
                      cond: {
                        $or: [
                          {
                            $not: [
                              {
                                $in: ['$$entry.k', ['sgArtifacts', 'sgCitations', 'sgGeneration']],
                              },
                            ],
                          },
                          { $ne: ['$$entry.v', null] },
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
          '$$ROOT',
        ],
      },
    },
    { $unset: ['_sgReferenceDeletes', '_sgDeletedIds', '_sgCancelledRequest'] },
  ];
}
