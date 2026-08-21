import { useEffect, useState } from 'react';
import { getTokenHeader } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

let assetPromise: Promise<void> | undefined;
const companyKnowledgeAssetVersion = '0.1.2';

type KnowledgeElement = HTMLElement & {
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

function knowledgeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
  const url = new URL(raw, window.location.origin);
  const authorization = getTokenHeader();
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/company/knowledge/') || !authorization) {
    return Promise.reject(new Error('COMPANY_KNOWLEDGE_REQUEST_DENIED'));
  }
  const headers = new Headers(init?.headers);
  headers.set('Authorization', authorization);
  return fetch(url, { ...init, headers, credentials: 'same-origin', redirect: 'error' });
}

function loadAssets(): Promise<void> {
  if (assetPromise) return assetPromise;
  const scriptUrl = new URL('company-knowledge/company-knowledge.js', document.baseURI);
  const stylesheetUrl = new URL('company-knowledge/style.css', document.baseURI);
  scriptUrl.searchParams.set('v', companyKnowledgeAssetVersion);
  stylesheetUrl.searchParams.set('v', companyKnowledgeAssetVersion);
  const script = scriptUrl.href;
  const stylesheet = stylesheetUrl.href;
  if (!document.querySelector(`link[href="${stylesheet}"]`)) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = stylesheet; document.head.append(link);
  }
  assetPromise = import(/* @vite-ignore */ script).then(() => undefined);
  return assetPromise;
}

export default function KnowledgeRoute() {
  const localize = useLocalize();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => { let active = true; void loadAssets().then(() => { if (active) setState('ready'); }).catch(() => { if (active) setState('error'); }); return () => { active = false; }; }, []);
  if (state === 'error') return <main className="p-6" role="alert">{localize('com_ui_company_knowledge_unavailable')}</main>;
  return <main className="h-full overflow-y-auto p-3 md:p-6" aria-label={localize('com_ui_company_knowledge')}>{state === 'loading' ? <p role="status">{localize('com_ui_loading')}</p> : <div ref={(node) => { if (node && node.childElementCount === 0) { const workspace = document.createElement('sg-knowledge-workspace') as KnowledgeElement; workspace.request = knowledgeRequest; node.append(workspace); } }} />}</main>;
}
