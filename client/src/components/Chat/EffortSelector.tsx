import { ReasoningEffort } from 'librechat-data-provider';
import { useChatContext } from '~/Providers';
import { useLocalize, useSetIndexOptions } from '~/hooks';

const effortValues = [ReasoningEffort.low, ReasoningEffort.high, ReasoningEffort.max] as const;
type EffortValue = (typeof effortValues)[number];

const effortLabels = {
  [ReasoningEffort.low]: 'com_ui_low',
  [ReasoningEffort.high]: 'com_ui_high',
  [ReasoningEffort.max]: 'com_ui_max',
} as const;

export function EffortControl({
  value,
  onChange,
}: {
  value: EffortValue;
  onChange: (value: EffortValue) => void;
}) {
  const localize = useLocalize();

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-text-secondary">
        {localize('com_endpoint_reasoning_effort')}
      </span>
      <div
        role="radiogroup"
        aria-label={localize('com_endpoint_reasoning_effort')}
        className="flex items-center gap-1 rounded-xl border border-border-light bg-presentation p-1"
      >
        {effortValues.map((effort) => {
          const selected = effort === value;
          return (
            <button
              key={effort}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(effort)}
              className={
                selected
                  ? 'rounded-lg bg-surface-active-alt px-2.5 py-1.5 text-xs font-semibold text-text-primary shadow-sm'
                  : 'rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-tertiary hover:text-text-primary'
              }
            >
              {localize(effortLabels[effort])}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function EffortSelector() {
  const { conversation } = useChatContext();
  const { setOption } = useSetIndexOptions();

  if (conversation?.endpoint !== 'SG AI Gateway' || conversation.model !== 'default') {
    return null;
  }

  const configuredEffort = conversation.reasoning_effort as EffortValue | undefined;
  const value = effortValues.includes(configuredEffort ?? ReasoningEffort.high)
    ? (configuredEffort ?? ReasoningEffort.high)
    : ReasoningEffort.high;

  return (
    <EffortControl value={value} onChange={(effort) => setOption('reasoning_effort')(effort)} />
  );
}
