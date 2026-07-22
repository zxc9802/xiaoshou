import type { SourceReference } from '../types/analysis';
import { CheckIcon, ChevronIcon, ShieldIcon } from './Icons';

export function SourceReferenceList({ sources, warnings }: { sources: SourceReference[]; warnings: string[] }) {
  const reliable = sources.some((source) => source.verified);
  return (
    <div>
      <div className="source-list">{sources.map((source) => <details key={`${source.title}-${source.version}`}><summary><span className="source-type">{source.category}</span><strong>《{source.title}》</strong><span className="version">{source.version}</span>{source.verified && <span className="verified"><CheckIcon /> 已审核</span>}<ChevronIcon /></summary><p>{source.excerpt}</p></details>)}</div>
      {!reliable && <div className="risk-alert strong"><ShieldIcon /><p>资料库中未找到已审核依据，请勿直接向客户承诺，建议咨询产品或售前人员。</p></div>}
      {warnings.map((warning) => <div className="risk-alert" key={warning}><ShieldIcon /><p>{warning}</p></div>)}
    </div>
  );
}
