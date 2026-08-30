import { useEffect } from 'react';
import { useToastContext } from '@librechat/client';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { EToolResources, FileSources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { useDeleteFilesMutation, useFilePreview, useRetrySGFileMutation } from '~/data-provider';
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

function SGFileContainer({
  file,
  setFiles,
  onDelete,
}: {
  file: ExtendedFile;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
  onDelete: () => void;
}) {
  const localize = useLocalize();
  const baseStatus = file.status ?? 'pending';
  const statusQuery = useFilePreview(file.file_id, { enabled: baseStatus === 'pending' });
  const retryMutation = useRetrySGFileMutation();
  const status = retryMutation.isLoading ? 'pending' : (statusQuery.data?.status ?? baseStatus);

  useEffect(() => {
    if (!statusQuery.data || statusQuery.data.status === 'pending') {
      return;
    }
    setFiles((current) => {
      const existing = current.get(file.file_id);
      if (
        !existing ||
        (existing.status === statusQuery.data?.status &&
          existing.previewError === statusQuery.data?.previewError)
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(file.file_id, {
        ...existing,
        status: statusQuery.data.status,
        previewError: statusQuery.data.previewError,
        progress: 1,
      });
      return next;
    });
  }, [file.file_id, setFiles, statusQuery.data]);

  const retry = () => {
    if (status !== 'failed' || retryMutation.isLoading) {
      return;
    }
    retryMutation.mutate(file.file_id, {
      onSuccess: (result) => {
        setFiles((current) => {
          const existing = current.get(file.file_id);
          if (!existing) {
            return current;
          }
          const next = new Map(current);
          next.set(file.file_id, {
            ...existing,
            status: result.status,
            previewError: result.previewError,
            progress: result.status === 'pending' ? 0.9 : 1,
          });
          return next;
        });
      },
    });
  };

  const subtitle = (() => {
    if (status === 'ready') {
      return (
        <div className="flex items-center gap-1 text-status-success">
          <CircleCheck className="size-3.5" aria-hidden="true" />
          <span>{localize('com_ui_analyzing_finished')}</span>
        </div>
      );
    }
    if (status === 'failed') {
      return (
        <div className="flex items-center gap-1 text-text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          <span>{localize('com_agents_error_retry')}</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1 text-text-secondary">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        <span>{localize('com_ui_analyzing')}</span>
      </div>
    );
  })();

  return (
    <FileContainer
      file={file}
      subtitle={subtitle}
      onClick={status === 'failed' ? retry : undefined}
      onDelete={onDelete}
    />
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
            const handleDelete = () => {
              if (abortUpload && file.progress < 1) {
                abortUpload();
              }
              if (file.progress >= 1 && !file.attached) {
                showToast({
                  message: localize('com_ui_deleting_file'),
                  status: 'info',
                });
              }
              deleteFile({ file, setFiles });
            };
            const isImage = file.type?.startsWith('image') ?? false;
            const isSGFile = file.source === FileSources.sg_gateway;
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
