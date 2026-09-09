import { ImagePlus, Pencil, Volume2 } from 'lucide-react';
import { Button } from '@librechat/client';
import { useChatContext, useChatFormContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { mainTextareaId } from '~/common';

const actions = {
  create: {
    label: 'com_sg_generate_image',
    prefix: 'com_sg_generate_image_prefix',
    Icon: ImagePlus,
  },
  edit: { label: 'com_sg_edit_image', prefix: 'com_sg_edit_image_prefix', Icon: Pencil },
  speech: { label: 'com_sg_create_speech', prefix: 'com_sg_create_speech_prefix', Icon: Volume2 },
} as const;

export default function GenerateMediaButton({
  disabled,
  operation = 'create',
}: {
  disabled: boolean;
  operation?: 'create' | 'edit' | 'speech';
}) {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const methods = useChatFormContext();
  if (conversation?.endpoint !== 'SG AI Gateway') {
    return null;
  }
  const { label, prefix: prefixKey, Icon } = actions[operation];
  const select = () => {
    const text = methods.getValues('text') ?? '';
    const prefix = localize(prefixKey);
    if (!text.startsWith(prefix)) {
      methods.setValue('text', `${prefix}${text}`, { shouldDirty: true });
    }
    document.getElementById(mainTextareaId)?.focus();
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={disabled}
      onClick={select}
      aria-label={localize(label)}
      title={localize(label)}
    >
      <Icon className="size-5" aria-hidden="true" />
    </Button>
  );
}
