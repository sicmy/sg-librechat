import { useEffect, useRef } from 'react';
import { useRecoilValue, useResetRecoilState } from 'recoil';
import store from '~/store';

export default function useResetCitationPanel(): void {
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));
  const resetCitationPanel = useResetRecoilState(store.sgCitationPanel);
  const previousConversationId = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousConversationId.current;
    const next = conversationId ?? null;
    previousConversationId.current = next;
    if (previous == null || previous === next) {
      return;
    }
    resetCitationPanel();
  }, [conversationId, resetCitationPanel]);
}
