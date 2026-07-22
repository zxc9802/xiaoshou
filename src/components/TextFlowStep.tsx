import type { ReactNode } from 'react';

export function TextFlowStep({ number, title, children, last = false }: { number: string; title: string; children: ReactNode; last?: boolean }) {
  return (
    <section className={`flow-step${last ? ' last' : ''}`}>
      <div className="step-rail"><span>{number}</span></div>
      <div className="step-content"><h3>{title}</h3>{children}</div>
    </section>
  );
}
