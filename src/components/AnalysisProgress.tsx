import { CheckIcon, SparkIcon } from './Icons';

export function AnalysisProgress({ steps, activeIndex }: { steps: readonly string[]; activeIndex: number }) {
  return (
    <section className="progress-card" aria-live="polite" aria-label="分析进度">
      <div className="progress-orbit"><span><SparkIcon /></span><i /><i /></div>
      <div className="progress-content"><p className="progress-label">AI 正在分析</p><h2>{steps[Math.min(activeIndex, steps.length - 1)]}</h2><p>正在基于已审核内容形成建议，请稍候</p></div>
      <div className="progress-steps">{steps.map((step, index) => <div key={step} className={index < activeIndex ? 'progress-step complete' : index === activeIndex ? 'progress-step active' : 'progress-step'}><span>{index < activeIndex ? <CheckIcon /> : index + 1}</span><p>{step.replace('正在', '')}</p></div>)}</div>
    </section>
  );
}
