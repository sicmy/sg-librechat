import type { TMessage } from 'librechat-data-provider';
import { EffortBadge } from '../../EffortSelector';
import CitationBadges from './Citations/Badges';
import GeneratedArtifacts from './GeneratedArtifacts';
import MessageQuotes from './MessageQuotes';
import SkillPills from './SkillPills';
import Files from './Files';

const Container = ({ children, message }: { children: React.ReactNode; message?: TMessage }) => (
  <div
    className="text-message flex min-h-[20px] flex-col items-start gap-3 overflow-visible [.text-message+&]:mt-5"
    dir="auto"
  >
    {message?.isCreatedByUser === true && (
      <>
        <MessageQuotes quotes={message.quotes} />
        <Files message={message} />
        <SkillPills skills={message.alwaysAppliedSkills} source="always-apply" />
        <SkillPills skills={message.manualSkills} source="manual" />
        <EffortBadge effort={message.metadata?.sgEffort} />
      </>
    )}
    {children}
    {message?.isCreatedByUser === false && <CitationBadges message={message} />}
    {message?.isCreatedByUser === false && <GeneratedArtifacts message={message} />}
  </div>
);

export default Container;
