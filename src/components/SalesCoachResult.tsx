import { useState } from 'react';
import type { AnalysisJobStatus, SalesAnalysisResult } from '../types/analysis';
import { AlternativeReplies } from './AlternativeReplies';
import { FeedbackActions } from './FeedbackActions';
import { NextActionList } from './NextActionList';
import { RecommendedReply } from './RecommendedReply';
import { SourceReferenceList } from './SourceReferenceList';
import { TextFlowStep } from './TextFlowStep';
import { ChevronIcon, SparkIcon } from './Icons';

export function SalesCoachResult({ result, embedded = false, jobStatus, analysisId, analysisKnowledgeEnabled = false }: { result: SalesAnalysisResult | null; embedded?: boolean; jobStatus?: AnalysisJobStatus; analysisId?: string; analysisKnowledgeEnabled?: boolean }) {
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  if (!result) return <section className="result-card empty-result"><div className="empty-visual"><span><SparkIcon /></span><i /><i /></div><h2>分析结果将在这里显示</h2><p>AI会按照销售判断流程，逐步给出建议。</p></section>;
  const detailsId = `analysis-details-${analysisId ?? 'current'}`;
  return (
    <section className={`result-card${embedded ? ' embedded-result' : ''}`}>
      {(jobStatus === 'handoff' || result.handoffRequired) && <div className="result-risk-banner high"><strong>建议升级人工处理</strong><span>该场景涉及合同、退款、投诉或大额承诺，AI仅提供缓冲话术。</span></div>}
      {!embedded && <header className="result-header"><div><span className="result-kicker"><SparkIcon /> AI 销管建议</span><h2>建议这样回复客户</h2><p>建议先确认客户真实顾虑，再推进下一步</p></div><span className="complete-badge">{result.generationMode === 'ai' ? '真实AI生成' : '规则分析'}</span></header>}
      <div className="reply-priority">
        <div className="situation-summary"><span>局面分析</span><p>{result.situationAnalysis}</p><div><em>{result.deadlockType}</em><em>{result.intentTemperature}</em><em>{result.decisionStage}</em><em>{result.objectionType}</em></div></div>
        {result.salesStrategy && <div className="sales-strategy-summary"><div><span>本轮销售策略</span><strong>{result.salesStrategy.name}</strong></div><p>{result.salesStrategy.reason}</p><div className="sales-technique-tags">{result.salesStrategy.techniques.map((technique) => <em key={technique}>{technique}</em>)}</div><small><b>成交推进目标</b>{result.salesStrategy.conversionGoal}</small></div>}
        <RecommendedReply content={result.recommendedReply} />
        <div className="followup-summary"><span>后续动作</span><p>{result.followupAction}</p></div>
        <AlternativeReplies replies={result.alternativeReplies} />
        <p className="fixed-disclaimer">⚠ {result.fixedDisclaimer}</p>
      </div>
      <div className="analysis-section-title"><div><strong>销管判断与下一步</strong><div className="analysis-section-actions"><span>{analysisKnowledgeEnabled ? '依据企业规则及已审核资料生成' : '依据客户对话与销售判断生成'}</span><button type="button" className="analysis-collapse-button" onClick={() => setDetailsCollapsed((collapsed) => !collapsed)} aria-expanded={!detailsCollapsed} aria-controls={detailsId}>{detailsCollapsed ? '展开详情' : '收起详情'}<ChevronIcon /></button></div></div></div>
      <div id={detailsId} className="analysis-details" hidden={detailsCollapsed}>
        <div className="flow-list">
          <TextFlowStep number="01" title="客户当前所处阶段"><div className="stage-row"><strong>{result.stage}</strong><span className="confidence">置信度 {result.stageConfidence}%</span></div><div className="evidence"><span>判断依据</span><p>{result.stageEvidence}</p></div></TextFlowStep>
          <TextFlowStep number="02" title="客户显性需求"><ul className="check-list">{result.explicitNeeds.map((need) => <li key={need}>{need}</li>)}</ul></TextFlowStep>
          <TextFlowStep number="03" title="客户深层需求假设">{result.implicitNeedHypotheses.map((hypothesis) => <div className="hypothesis" key={hypothesis.statement}><div className="hypothesis-title"><span>假设</span><strong>{hypothesis.statement}</strong><em>置信度 {hypothesis.confidence}%</em></div><dl><div><dt>判断依据</dt><dd>{hypothesis.evidence}</dd></div><div><dt>建议验证问题</dt><dd>“{hypothesis.validationQuestion}”</dd></div></dl></div>)}</TextFlowStep>
          <TextFlowStep number="04" title="销售陷入死循环的原因"><div className="loop-type">{result.salesLoopIssue.type}</div><p className="body-copy">{result.salesLoopIssue.problem}</p><div className="why-box"><span>为什么无法继续推进</span><p>{result.salesLoopIssue.reason}</p></div></TextFlowStep>
          <TextFlowStep number="05" title="本轮沟通目标"><div className="goal-box"><span>唯一目标</span><strong>{result.replyGoal}</strong></div></TextFlowStep>
          <TextFlowStep number="06" title="客户可能回应及下一步" last={!analysisKnowledgeEnabled}><NextActionList branches={result.nextBranches} /></TextFlowStep>
          {analysisKnowledgeEnabled && <TextFlowStep number="07" title="依据来源和风险提醒" last><SourceReferenceList sources={result.sourceReferences} warnings={result.warnings} /></TextFlowStep>}
        </div>
        <FeedbackActions analysisId={analysisId} />
      </div>
    </section>
  );
}
