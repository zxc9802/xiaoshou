import type { NextBranch } from '../types/analysis';
import { ArrowIcon } from './Icons';

export function NextActionList({ branches }: { branches: NextBranch[] }) {
  return <div className="branch-list">{branches.map((branch, index) => <article className="branch-item" key={branch.customerReply}><div className="branch-index">{index + 1}</div><div><strong>客户可能说：{branch.customerReply}</strong><p>{branch.nextAction}</p>{branch.suggestedLine && <div className="suggested-line"><ArrowIcon /><span><em>下一句建议</em>{branch.suggestedLine}</span></div>}</div></article>)}</div>;
}
