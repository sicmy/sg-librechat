import { useEffect, useState } from 'react';
import { useLocalize } from '~/hooks';

let assetPromise: Promise<void> | undefined;
const companyKnowledgeAssetVersion = '0.1.1';

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
  return <main className="h-full overflow-y-auto p-3 md:p-6" aria-label={localize('com_ui_company_knowledge')}>{state === 'loading' ? <p role="status">{localize('com_ui_loading')}</p> : <div ref={(node) => { if (node && node.childElementCount === 0) node.append(document.createElement('sg-knowledge-workspace')); }} />}</main>;
}
