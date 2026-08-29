import * as Ariakit from '@ariakit/react';
import { Brain } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import { ReasoningEffort, SystemRoles } from 'librechat-data-provider';
import type { SgEffort } from '~/utils/endpoints';
import { useChatContext } from '~/Providers';
import { useAuthContext, useLocalize, useSetIndexOptions } from '~/hooks';
import { getSgEffort } from '~/utils/endpoints';
import { cn } from '~/utils';

const effortValues = [ReasoningEffort.low, ReasoningEffort.high, ReasoningEffort.max] as const;

const effortLabels = {
  [ReasoningEffort.low]: 'com_ui_response_depth_quick',
  [ReasoningEffort.high]: 'com_ui_response_depth_balanced',
  [ReasoningEffort.max]: 'com_ui_response_depth_deep',
} as const;

export function EffortControl({
  value,
  onChange,
  disabled = false,
}: {
  value: SgEffort;
  onChange: (value: SgEffort) => void;
  disabled?: boolean;
}) {
  const localize = useLocalize();
  const controlLabel = localize('com_ui_response_depth');
  const selectedLabel = localize(effortLabels[value]);
  const accessibleLabel = `${controlLabel}: ${selectedLabel}`;
  const select = Ariakit.useSelectStore({
    value,
    placement: 'top-start',
    setValue: (nextValue) => {
      if (typeof nextValue === 'string' && effortValues.includes(nextValue as SgEffort)) {
        onChange(nextValue as SgEffort);
      }
    },
  });

  return (
    <div className="flex items-center">
      <Ariakit.SelectLabel store={select} className="sr-only">
        {controlLabel}
      </Ariakit.SelectLabel>
      <TooltipAnchor
        id="response-depth-select"
        description={accessibleLabel}
        disabled={disabled}
        render={
          <Ariakit.Select
            store={select}
            disabled={disabled}
            aria-label={accessibleLabel}
            className="flex size-theme-control items-center justify-center rounded-theme-control-round p-1 text-text-secondary transition-colors duration-theme-fast hover:bg-surface-composer-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-opacity-50"
          >
            <Brain className="size-5" aria-hidden="true" />
          </Ariakit.Select>
        }
      />
      <Ariakit.SelectPopover
        store={select}
        modal
        portal
        unmountOnHide
        gutter={8}
        className="animate-popover z-40 min-w-48 overflow-hidden rounded-xl border border-border-light bg-surface-secondary p-1.5 shadow-lg"
      >
        <div className="px-2 py-1.5 text-xs font-medium text-text-secondary">{controlLabel}</div>
        {effortValues.map((effort) => {
          const selected = effort === value;
          return (
            <Ariakit.SelectItem
              key={effort}
              value={effort}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-sm text-text-primary outline-none transition-colors',
                'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
                selected && 'bg-surface-active',
              )}
            >
              {localize(effortLabels[effort])}
              <Ariakit.SelectItemCheck />
            </Ariakit.SelectItem>
          );
        })}
      </Ariakit.SelectPopover>
    </div>
  );
}

export function EffortBadge({ effort }: { effort?: unknown }) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  if (user?.role !== SystemRoles.ADMIN || !effortValues.includes(effort as SgEffort)) {
    return null;
  }

  const value = effort as SgEffort;
  const label = `${localize('com_ui_response_depth')}: ${localize(effortLabels[value])}`;

  return (
    <span
      aria-label={label}
      data-effort={value}
      className="inline-flex rounded-full border border-border-light bg-surface-secondary px-2 py-1 text-xs font-medium text-text-secondary"
    >
      {label}
    </span>
  );
}

export default function EffortSelector({ disabled = false }: { disabled?: boolean }) {
  const { conversation } = useChatContext();
  const { setOption } = useSetIndexOptions();
  const value = getSgEffort(conversation);

  if (value == null) {
    return null;
  }

  return (
    <EffortControl
      value={value}
      disabled={disabled}
      onChange={(effort) => setOption('reasoning_effort')(effort)}
    />
  );
}
