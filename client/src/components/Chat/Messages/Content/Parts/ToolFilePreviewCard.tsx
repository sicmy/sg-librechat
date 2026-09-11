import { useCallback, useState } from 'react';
import type { TAttachment, TAttachmentMetadata, TFile } from 'librechat-data-provider';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { displayFilename } from './attachmentTypes';

interface ToolFilePreviewCardProps {
  attachment: TAttachment;
}

/** Opens a locally persisted code-output file in the shared file preview dialog. */
export default function ToolFilePreviewCard({ attachment }: ToolFilePreviewCardProps) {
  const [open, setOpen] = useState(false);
  const file = attachment as TFile & TAttachmentMetadata;
  const fileName = file.filename ?? '';

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleOpenChange = useCallback((nextOpen: boolean) => setOpen(nextOpen), []);

  return (
    <>
      <FileContainer file={file} displayName={displayFilename(fileName)} onClick={handleOpen} />
      <FilePreviewDialog
        open={open}
        onOpenChange={handleOpenChange}
        fileName={fileName}
        fileId={file.file_id}
        filePath={file.filepath}
        fileSource={file.source}
        fileType={file.type}
        fileSize={file.bytes}
      />
    </>
  );
}
