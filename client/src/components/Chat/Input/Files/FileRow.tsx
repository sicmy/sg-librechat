import { useCallback, useEffect } from 'react';
import { Button, useToastContext } from '@librechat/client';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { EToolResources, FileSources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import type { TFilePreview } from 'librechat-data-provider';
import {
  useDeleteFilesMutation,
  useFilePreview,
  useRetrySGFileMutation,
  useCancelSGFileMutation,
} from '~/data-provider';
import { logger, getCachedPreview, isBlockingFileUpload } from '~/utils';
import { useFileDeletion } from '~/hooks/Files';
import FileContainer from './FileContainer';
import { useLocalize } from '~/hooks';
import Image from './Image';

/**
 * Shared wrapper with a stable module-scope identity. Passing an inline arrow as
 * `Wrapper` makes it a new component type on every render, so React remounts the
 * whole row and any focused control inside it loses focus.
 */
export const FileRowWrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap gap-2">{children}</div>
);

export function SGFileContainer({
  file,
  setFiles,
  onDelete,
}: {
  file: ExtendedFile;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
  onDelete: (status?: ExtendedFile['status']) => void;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const baseStatus = file.status ?? 'pending';
  const statusQuery = useFilePreview(file.file_id, {
    enabled: baseStatus !== 'ready',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const retryMutation = useRetrySGFileMutation();
  const cancelMutation = useCancelSGFileMutation();
  const busy = retryMutation.isLoading || cancelMutation.isLoading;
  const status = retryMutation.isLoading ? 'pending' : (statusQuery.data?.status ?? baseStatus);
  const gateway = statusQuery.data?.sgGateway ?? file.metadata?.sgGateway;
  const canRetry = status === 'failed' && gateway?.retryable === true;
  const errorCode = statusQuery.data?.previewError ?? file.previewError;

  const applyStatus = useCallback(
    (result: TFilePreview) => {
      setFiles((current) => {
        const existing = current.get(file.file_id);
        if (
          !existing ||
          (existing.status === result.status &&
            existing.previewError === result.previewError &&
            existing.metadata?.sgGateway?.state === result.sgGateway?.state &&
            existing.metadata?.sgGateway?.retryable === result.sgGateway?.retryable &&
            existing.progress === (result.status === 'pending' ? 0.9 : 1))
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(file.file_id, {
          ...existing,
          status: result.status,
          previewError: result.previewError,
          metadata: {
            ...existing.metadata,
            sgGateway: result.sgGateway ?? existing.metadata?.sgGateway,
          },
          progress: result.status === 'pending' ? 0.9 : 1,
        });
        return next;
      });
    },
    [file.file_id, setFiles],
  );

  useEffect(() => {
    if (statusQuery.data) {
      applyStatus(statusQuery.data);
    }
  }, [applyStatus, statusQuery.data]);

  const changeStatus = (action: 'retry' | 'cancel') => {
    if (busy || (action === 'retry' ? !canRetry : status !== 'pending')) {
      return;
    }
    (action === 'retry' ? retryMutation : cancelMutation).mutate(file.file_id, {
      onSuccess: applyStatus,
      onError: () => {
        showToast({ message: localize('com_ui_sg_file_action_failed'), status: 'error' });
        void statusQuery.refetch();
      },
    });
  };

  const subtitle = (() => {
    if (statusQuery.isError) {
      return <span>{localize('com_ui_sg_file_status_unavailable')}</span>;
    }
    if (status === 'ready') {
      return (
        <div className="flex items-center gap-1 text-status-success">
          <CircleCheck className="size-3.5" aria-hidden="true" />
          <span>{localize('com_ui_analyzing_finished')}</span>
        </div>
      );
    }
    if (status === 'failed') {
      const failureKey = canRetry ? 'com_agents_error_retry' : 'com_ui_sg_file_unprocessable';
      return (
        <div className="flex items-center gap-1 text-text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          <span>
            {localize(errorCode === 'job_cancelled' ? 'com_ui_sg_file_cancelled' : failureKey)}
          </span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1 text-text-secondary">
        <LoaderCircle
          className="size-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>{localize('com_ui_analyzing')}</span>
      </div>
    );
  })();

  return (
    <div className="flex flex-col items-start gap-1">
      <FileContainer
        file={file}
        subtitle={
          <div role="status" aria-live="polite">
            {subtitle}
          </div>
        }
        onClick={canRetry && !busy ? () => changeStatus('retry') : undefined}
        onDelete={busy ? undefined : () => onDelete(status)}
      />
      {status === 'pending' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => changeStatus('cancel')}
        >
          {localize('com_ui_sg_file_cancel')}
        </Button>
      )}
      {canRetry && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => changeStatus('retry')}
        >
          {localize('com_ui_sg_file_retry')}
        </Button>
      )}
      {statusQuery.isError && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}
        >
          {localize('com_ui_sg_file_check_status')}
        </Button>
      )}
    </div>
  );
}

export default function FileRow({
  files: _files,
  setFiles,
  abortUpload,
  setFilesLoading,
  assistant_id,
  agent_id,
  tool_resource,
  fileFilter,
  isRTL = false,
  Wrapper,
}: {
  files: Map<string, ExtendedFile> | undefined;
  abortUpload?: () => void;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  fileFilter?: (file: ExtendedFile) => boolean;
  assistant_id?: string;
  agent_id?: string;
  tool_resource?: EToolResources;
  isRTL?: boolean;
  Wrapper?: React.FC<{ children: React.ReactNode }>;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const files = Array.from(_files?.values() ?? []).filter((file) =>
    fileFilter ? fileFilter(file) : true,
  );

  const { mutateAsync } = useDeleteFilesMutation({
    onMutate: async () =>
      logger.log(
        'agents',
        'Deleting files: agent_id, assistant_id, tool_resource',
        agent_id,
        assistant_id,
        tool_resource,
      ),
    onSuccess: () => {
      console.log('Files deleted');
    },
    onError: (error) => {
      console.log('Error deleting files:', error);
    },
  });

  const { deleteFile } = useFileDeletion({ mutateAsync, agent_id, assistant_id, tool_resource });

  useEffect(() => {
    if (!setFilesLoading) return;
    if (files.length === 0) {
      setFilesLoading(false);
      return;
    }

    if (files.some(isBlockingFileUpload)) {
      setFilesLoading(true);
      return;
    }

    setFilesLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  if (files.length === 0) {
    return null;
  }

  const renderFiles = () => {
    const rowStyle = isRTL
      ? {
          display: 'flex',
          flexDirection: 'row-reverse',
          flexWrap: 'wrap',
          gap: '4px',
          width: '100%',
          maxWidth: '100%',
        }
      : {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          width: '100%',
          maxWidth: '100%',
        };

    return (
      <div style={rowStyle as React.CSSProperties}>
        {files
          .reduce(
            (acc, current) => {
              if (!acc.map.has(current.file_id)) {
                acc.map.set(current.file_id, true);
                acc.uniqueFiles.push(current);
              }
              return acc;
            },
            { map: new Map(), uniqueFiles: [] as ExtendedFile[] },
          )
          .uniqueFiles.map((file: ExtendedFile) => {
            const isSGFile = file.source === FileSources.sg_gateway;
            const handleDelete = (sgStatus?: ExtendedFile['status']) => {
              const fileToDelete =
                isSGFile && sgStatus && sgStatus !== 'pending'
                  ? { ...file, status: sgStatus, progress: 1 }
                  : file;
              if (abortUpload && fileToDelete.progress < 1) {
                abortUpload();
              }
              if (fileToDelete.progress >= 1 && !fileToDelete.attached) {
                showToast({
                  message: localize('com_ui_deleting_file'),
                  status: 'info',
                });
              }
              deleteFile({ file: fileToDelete, setFiles });
            };
            const isImage = file.type?.startsWith('image') ?? false;
            let content: React.ReactNode;
            if (isSGFile) {
              content = <SGFileContainer file={file} setFiles={setFiles} onDelete={handleDelete} />;
            } else if (isImage) {
              content = (
                <Image
                  url={getCachedPreview(file.file_id) ?? file.preview ?? file.filepath}
                  onDelete={handleDelete}
                  progress={file.progress}
                  source={file.source}
                />
              );
            } else {
              content = <FileContainer file={file} onDelete={handleDelete} />;
            }

            return (
              <div
                key={file.file_id}
                style={{
                  flexBasis: '70px',
                  flexGrow: 0,
                  flexShrink: 0,
                }}
              >
                {content}
              </div>
            );
          })}
      </div>
    );
  };

  if (Wrapper) {
    return <Wrapper>{renderFiles()}</Wrapper>;
  }

  return renderFiles();
}
