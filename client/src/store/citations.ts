import { atom } from 'recoil';
import type { SGCitationMetadata } from 'librechat-data-provider';

export type SGCitationPanel = {
  messageId: string;
  metadata: SGCitationMetadata;
  selectedCitationId: string;
};

export const sgCitationPanel = atom<SGCitationPanel | null>({
  key: 'sgCitationPanel',
  default: null,
});
