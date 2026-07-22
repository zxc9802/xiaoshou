import { useState } from 'react';
import { analysisApi } from '../services/analysisApi';
import { CheckIcon } from './Icons';

type Outcome = 'adopted' | 'rejected' | 'edited_adopted' | 'saved_review';

export function FeedbackActions({ analysisId }: { analysisId?: string }) {
  const [choice, setChoice] = useState<Outcome>();
  const [sending, setSending] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('不符合当前客户场景');
  const [status, setStatus] = useState('');
  const choose = async (outcome: Outcome, feedbackReason?: string) => {
    setChoice(outcome);
    setRejectOpen(false);
    if (!analysisId) return;
    setSending(true);
    try { await analysisApi.feedback(analysisId, outcome, feedbackReason); setStatus('反馈已保存'); } catch { setStatus('反馈保存失败，请稍后重试'); } finally { setSending(false); }
  };
  return <footer className="feedback-actions"><div><p>这条建议对你有帮助吗？</p><span>{sending ? '正在保存反馈…' : status || '你的反馈会帮助优化后续策略'}</span></div><div className="feedback-buttons"><button className={choice === 'adopted' ? 'selected' : ''} onClick={() => void choose('adopted')}>✓ 已采用</button><button className={choice === 'edited_adopted' ? 'selected' : ''} onClick={() => void choose('edited_adopted')}>修改后采用</button><button className={choice === 'rejected' ? 'selected' : ''} onClick={() => { setChoice('rejected'); setRejectOpen(true); }}>× 不适用</button><button className={choice === 'saved_review' ? 'save selected' : 'save'} onClick={() => void choose('saved_review')}>{choice === 'saved_review' && <CheckIcon />} {choice === 'saved_review' ? '已保存到复盘' : '保存到复盘'}</button>{rejectOpen && <div className="feedback-reason"><label><span>不适用原因</span><select value={reason} onChange={(event) => setReason(event.target.value)}><option>不符合当前客户场景</option><option>事实或资料不准确</option><option>口吻不适合我</option><option>推进目标不合适</option><option>已经自行处理</option></select></label><button disabled={sending} onClick={() => void choose('rejected', reason)}>确认提交</button></div>}</div></footer>;
}
