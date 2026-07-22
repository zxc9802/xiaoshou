import { useEffect, useMemo, useState } from 'react';
import type { ConversationReview, ReviewMetrics, ReviewOutcome } from '../types/analysis';
import { reviewApi } from '../services/analysisApi';
import { CheckIcon, SparkIcon } from './Icons';

const outcomeLabels: Record<ReviewOutcome, string> = {
  progressed: '有效推进', unchanged: '暂未推进', regressed: '意向后退', won: '已成交', lost: '已流失', unknown: '待判断',
};
const adoptionLabels: Record<ConversationReview['adoption'], string> = {
  adopted: '已采用', edited_adopted: '修改后采用', rejected: '不适用', saved_review: '保存复盘', unreported: '未反馈',
};
const diagnosisOptions = ['客户判断错误', '销售策略不合适', '回复表达不合适', '产品或价格资料不足', '缺少案例或证据', '客户没有真实需求', '跟进时机不合适'];

export function ReviewCenterPage({ onBack }: { onBack: () => void }) {
  const [reviews, setReviews] = useState<ConversationReview[]>([]);
  const [metrics, setMetrics] = useState<ReviewMetrics | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'effective' | 'stalled'>('pending');
  const [period, setPeriod] = useState<'7' | '30' | 'all'>('30');
  const [stageFilter, setStageFilter] = useState('all');
  const [objectionFilter, setObjectionFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [items, summary] = await Promise.all([reviewApi.list(), reviewApi.metrics()]);
      setReviews(items); setMetrics(summary); setError('');
      setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? '');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '复盘数据加载失败'); }
  };
  useEffect(() => { void load(); }, []);

  const periodReviews = useMemo(() => reviews.filter((review) => period === 'all' || new Date(review.createdAt).getTime() >= Date.now() - Number(period) * 86400000), [reviews, period]);
  const visible = useMemo(() => periodReviews.filter((review) => {
    const result = review.confirmedOutcome ?? review.aiOutcome;
    const matchesFilter = filter === 'all' || filter === 'pending' && review.status === 'pending' || filter === 'effective' && ['progressed', 'won'].includes(result) || filter === 'stalled' && ['unchanged', 'regressed', 'lost'].includes(result);
    const keyword = search.trim().toLowerCase();
    return matchesFilter && (stageFilter === 'all' || review.stageBefore === stageFilter || review.stageAfter === stageFilter) && (objectionFilter === 'all' || review.objectionType === objectionFilter) && (!keyword || [review.customerName, review.problem, review.strategyName, review.product, review.stageBefore, review.stageAfter].join(' ').toLowerCase().includes(keyword));
  }), [periodReviews, filter, search, stageFilter, objectionFilter]);
  const selected = visible.find((review) => review.id === selectedId) ?? visible[0];
  const stages = useMemo(() => [...new Set(periodReviews.flatMap((review) => [review.stageBefore, review.stageAfter]).filter(Boolean) as string[])], [periodReviews]);
  const objections = useMemo(() => [...new Set(periodReviews.map((review) => review.objectionType).filter(Boolean))], [periodReviews]);
  const displayMetrics = useMemo<ReviewMetrics>(() => {
    const judged = periodReviews.filter((review) => (review.confirmedOutcome ?? review.aiOutcome) !== 'unknown');
    const effective = judged.filter((review) => ['progressed','won'].includes(review.confirmedOutcome ?? review.aiOutcome));
    const feedback = periodReviews.filter((review) => !['unreported','saved_review'].includes(review.adoption));
    const adopted = feedback.filter((review) => ['adopted','edited_adopted'].includes(review.adoption));
    return { pendingCount: periodReviews.filter((review) => review.status === 'pending').length, effectiveProgressRate: judged.length ? Math.round(effective.length / judged.length * 100) : 0, rescuedCustomers: new Set(effective.filter((review) => /犹豫|流失|沉默/.test(review.stageBefore)).map((review) => review.customerProfileId)).size, adoptionRate: feedback.length ? Math.round(adopted.length / feedback.length * 100) : 0, knowledgeGapCount: periodReviews.filter((review) => review.knowledgeGap).length, totalReviews: periodReviews.length };
  }, [periodReviews]);

  const replaceReview = (updated: ConversationReview) => setReviews((items) => items.map((item) => item.id === updated.id ? updated : item));
  const confirm = async (outcome: ReviewOutcome, actualReply?: string) => {
    if (!selected) return; setBusy(true);
    try { replaceReview(await reviewApi.confirmOutcome(selected.id, outcome, actualReply)); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); }
    finally { setBusy(false); }
  };

  return <main className="review-page review-workbench">
    <header className="review-header"><div><span><SparkIcon /> CONVERSION REVIEW</span><h1>成交复盘中心</h1><p>看清客户为什么推进或流失，把有效沟通沉淀为下一次可复用的销售能力。</p></div><button className="secondary-button" onClick={onBack}>返回工作台</button></header>
    {error && <div className="workspace-error">{error}</div>}
    <section className="review-metrics">
      <Metric label="待复盘" value={metrics ? displayMetrics.pendingCount : undefined} note="等待确认效果的关键对话" accent />
      <Metric label="有效推进率" value={metrics ? `${displayMetrics.effectiveProgressRate}%` : undefined} note="阶段前进或确认成交" />
      <Metric label="挽回客户" value={metrics ? displayMetrics.rescuedCustomers : undefined} note="从犹豫或流失边缘重新推进" />
      <Metric label="建议采用率" value={metrics ? `${displayMetrics.adoptionRate}%` : undefined} note="直接采用与修改后采用" />
      <Metric label="知识缺口" value={metrics ? displayMetrics.knowledgeGapCount : undefined} note="缺少已审核依据的复盘" warning />
    </section>

    <section className="review-toolbar">
      <div className="review-filter-tabs">
        <button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>待复盘 <span>{reviews.filter((item) => item.status === 'pending').length}</span></button>
        <button className={filter === 'effective' ? 'active' : ''} onClick={() => setFilter('effective')}>有效推进</button>
        <button className={filter === 'stalled' ? 'active' : ''} onClick={() => setFilter('stalled')}>未推进</button>
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
      </div>
      <div className="review-filter-controls"><select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="7">近7天</option><option value="30">近30天</option><option value="all">全部时间</option></select><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="all">全部阶段</option>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select><select value={objectionFilter} onChange={(event) => setObjectionFilter(event.target.value)}><option value="all">全部异议</option>{objections.map((item) => <option key={item}>{item}</option>)}</select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索客户、产品、卡点或销售策略…" /></div>
    </section>

    <section className="review-board">
      <aside className="review-queue">
        <header><strong>{filter === 'pending' ? '优先处理' : '复盘记录'}</strong><span>{visible.length} 条</span></header>
        {visible.length ? visible.map((review) => <ReviewQueueItem key={review.id} review={review} active={review.id === selected?.id} onClick={() => setSelectedId(review.id)} />) : <div className="review-queue-empty"><SparkIcon /><strong>当前没有记录</strong><span>后续客户回复或反馈出现后会自动进入这里。</span></div>}
      </aside>
      <div className="review-detail">
        {selected ? <ReviewDetail review={selected} busy={busy} onConfirm={confirm} onSaveDiagnosis={async (diagnosis, note) => { setBusy(true); try { replaceReview(await reviewApi.saveDiagnosis(selected.id, diagnosis, note)); } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); } finally { setBusy(false); } }} onPromote={async () => { setBusy(true); try { replaceReview(await reviewApi.promote(selected.id)); } catch (caught) { setError(caught instanceof Error ? caught.message : '生成技巧候选失败'); } finally { setBusy(false); } }} /> : <div className="review-detail-empty"><SparkIcon /><h2>选择一条对话开始复盘</h2><p>系统会把前后两次沟通关联起来，帮助判断策略是否真正推动客户。</p></div>}
      </div>
    </section>
  </main>;
}

function Metric({ label, value, note, accent, warning }: { label: string; value?: string | number; note: string; accent?: boolean; warning?: boolean }) {
  return <article className={`${accent ? 'accent' : ''} ${warning ? 'warning' : ''}`}><span>{label}</span><strong>{value ?? '—'}</strong><small>{note}</small></article>;
}

function ReviewQueueItem({ review, active, onClick }: { review: ConversationReview; active: boolean; onClick: () => void }) {
  const result = review.confirmedOutcome ?? review.aiOutcome;
  return <button className={active ? 'active' : ''} onClick={onClick}>
    <div><strong>{review.customerName}</strong><em className={`review-outcome ${result}`}>{outcomeLabels[result]}</em></div>
    <p>{review.problem}</p>
    <footer><span>{review.stageBefore}{review.stageAfter ? ` → ${review.stageAfter}` : ''}</span><time>{new Date(review.updatedAt).toLocaleDateString()}</time></footer>
  </button>;
}

function ReviewDetail({ review, busy, onConfirm, onSaveDiagnosis, onPromote }: { review: ConversationReview; busy: boolean; onConfirm: (outcome: ReviewOutcome, actualReply?: string) => Promise<void>; onSaveDiagnosis: (diagnosis: string[], note?: string) => Promise<void>; onPromote: () => Promise<void> }) {
  const [actualReply, setActualReply] = useState(review.actualReply ?? '');
  const [diagnosis, setDiagnosis] = useState(review.diagnosis);
  const [note, setNote] = useState(review.note ?? '');
  useEffect(() => { setActualReply(review.actualReply ?? ''); setDiagnosis(review.diagnosis); setNote(review.note ?? ''); }, [review.id, review.actualReply, review.diagnosis, review.note]);
  const effective = review.confirmedOutcome ?? review.aiOutcome;
  return <>
    <header className="review-detail-header"><div><span>{review.status === 'pending' ? '待确认复盘' : '已完成复盘'}</span><h2>{review.customerName}</h2><p>{review.stageBefore}{review.stageAfter ? ` → ${review.stageAfter}` : ' · 等待客户后续回复'}</p></div><em className={`review-outcome large ${effective}`}>{outcomeLabels[effective]}</em></header>
    <div className="review-story">
      <ReviewBlock step="01" title="原沟通卡点"><p>{review.problem}</p></ReviewBlock>
      <ReviewBlock step="02" title="AI当时采用的销售策略">
        <div className="review-strategy"><strong>{review.strategyName}</strong><p>{review.strategyReason}</p>{review.techniques.length > 0 && <div>{review.techniques.map((item) => <span key={item}>{item}</span>)}</div>}</div>
      </ReviewBlock>
      <ReviewBlock step="03" title="建议回复与采用情况">
        <div className="review-reply"><span>{adoptionLabels[review.adoption]}</span><p>{review.recommendedReply}</p></div>
        <label className="review-field"><span>实际使用的话术（选填）</span><textarea value={actualReply} onChange={(event) => setActualReply(event.target.value)} placeholder="如果销售修改后再发送，可在这里记录最终版本。" /></label>
      </ReviewBlock>
      <ReviewBlock step="04" title="客户后续真实回应"><blockquote>{review.customerResponse || '暂时还没有新的客户回复，结果保持待判断。'}</blockquote></ReviewBlock>
      <ReviewBlock step="05" title="确认本次沟通结果">
        <p className="review-ai-judgement">AI建议判断：<strong>{outcomeLabels[review.aiOutcome]}</strong>。请结合真实客户情况确认或修正。</p>
        <div className="review-outcome-actions">{(['progressed','unchanged','regressed','won','lost','unknown'] as ReviewOutcome[]).map((item) => <button key={item} disabled={busy} className={(review.confirmedOutcome ?? review.aiOutcome) === item ? 'active' : ''} onClick={() => void onConfirm(item, actualReply)}>{outcomeLabels[item]}</button>)}</div>
      </ReviewBlock>
      <ReviewBlock step="06" title="复盘归因与改进">
        <div className="review-diagnosis">{diagnosisOptions.map((item) => <button key={item} className={diagnosis.includes(item) ? 'active' : ''} onClick={() => setDiagnosis((items) => items.includes(item) ? items.filter((value) => value !== item) : [...items, item])}>{diagnosis.includes(item) && <CheckIcon />}{item}</button>)}</div>
        <label className="review-field"><span>复盘备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录本次沟通中做对了什么、下一次要调整什么。" /></label>
        <div className="review-save-row"><button className="secondary-button" disabled={busy} onClick={() => void onSaveDiagnosis(diagnosis, note)}>保存复盘</button><button className="primary-button" disabled={busy || !['progressed','won'].includes(effective) || Boolean(review.knowledgeCandidateId)} onClick={() => void onPromote()}>{review.knowledgeCandidateId ? '已生成技巧候选' : '沉淀为销售技巧'}</button></div>
        {review.knowledgeGap && <p className="review-gap">本次回复缺少可靠的已审核资料，可在资料库补充产品、价格、案例或销售依据。</p>}
      </ReviewBlock>
    </div>
  </>;
}

function ReviewBlock({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return <section className="review-block"><header><span>{step}</span><h3>{title}</h3></header><div>{children}</div></section>;
}
