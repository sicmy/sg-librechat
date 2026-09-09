import { useEffect, useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { sgArtifactMetadataSchema } from 'librechat-data-provider';
import type { SGArtifactMetadata, TMessage } from 'librechat-data-provider';
import { useSGCitationDownload } from '~/data-provider/Files/queries';
import { triggerDownload } from '~/utils';
import { useLocalize } from '~/hooks';
import Image from './Image';

function AudioPreview({ fileId, text }: { fileId: string; text?: string | null }) {
  const localize = useLocalize();
  const { data, isError } = useSGCitationDownload(fileId, true);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!data) {
      setUrl('');
      return;
    }
    const nextUrl = URL.createObjectURL(data);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [data]);
  if (isError) {
    return <p role="alert">{localize('com_sg_audio_load_error')}</p>;
  }
  const escapedText = (text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const captions = `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n${escapedText}\n`)}`;
  return url ? (
    <audio controls preload="metadata" src={url} aria-label={localize('com_sg_generated_speech')}>
      <track
        kind="captions"
        src={captions}
        srcLang="und"
        label={localize('com_sg_speech_transcript')}
        default
      />
    </audio>
  ) : (
    <span>{localize('com_ui_loading')}</span>
  );
}

function Artifact({ artifact }: { artifact: SGArtifactMetadata['artifacts'][number] }) {
  const localize = useLocalize();
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const download = useSGCitationDownload(artifact.file_id);
  const save = async () => {
    setFailed(false);
    try {
      const result = await download.refetch();
      if (!result.data) {
        setFailed(true);
        return;
      }
      triggerDownload(URL.createObjectURL(result.data), artifact.display_name);
    } catch {
      setFailed(true);
    }
  };
  return (
    <figure className="flex max-w-full flex-col gap-2">
      {artifact.mime_type === 'audio/wav' ? (
        <AudioPreview fileId={artifact.file_id} text={artifact.spoken_text} />
      ) : (
        <Image
          imagePath={`/api/files/sg-image/${encodeURIComponent(artifact.file_id)}`}
          altText={localize(
            artifact.source_file_id ? 'com_sg_edited_image' : 'com_sg_generated_image',
          )}
        />
      )}
      <figcaption className="flex items-center gap-3 text-sm text-text-secondary">
        <span>{artifact.display_name}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={download.isFetching}
          onClick={save}
        >
          {localize('com_ui_download')}
        </Button>
      </figcaption>
      {artifact.spoken_text && (
        <p className="text-sm text-text-secondary">{artifact.spoken_text}</p>
      )}
      {artifact.source_file_id && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={showSource}
          onClick={() => setShowSource((value) => !value)}
        >
          {localize('com_sg_source_image')}
        </Button>
      )}
      {showSource && artifact.source_file_id && (
        <Image
          imagePath={`/api/files/sg-image/${encodeURIComponent(artifact.source_file_id)}`}
          altText={localize('com_sg_source_image')}
        />
      )}
      {failed && (
        <p role="alert" className="text-sm text-text-secondary">
          {localize('com_sg_citation_download_error')}
        </p>
      )}
    </figure>
  );
}

export default function GeneratedArtifacts({ message }: { message: TMessage }) {
  const metadata = useMemo(
    () => sgArtifactMetadataSchema.safeParse(message.metadata?.sgArtifacts),
    [message.metadata?.sgArtifacts],
  );
  if (!metadata.success) {
    return null;
  }
  return (
    <>
      {metadata.data.artifacts.map((artifact) => (
        <Artifact key={artifact.file_id} artifact={artifact} />
      ))}
    </>
  );
}
