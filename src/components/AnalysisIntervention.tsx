import { useState } from 'react';
import type { ClarificationQuestion, ParsedConversation } from '../types/analysis';
import { CheckIcon, ShieldIcon } from './Icons';

export function TranscriptReview({ transcript, onConfirm }: { transcript: ParsedConversation; onConfirm: (transcript: ParsedConversation) => void }) {
  const [messages, setMessages] = useState(() => transcript.messages.map((message) => ({ ...message })));
  const update = (index: number, patch: Partial<(typeof messages)[number]>) => setMessages((current) => current.map((message, itemIndex) => itemIndex === index ? { ...message, ...patch } : message));
  const confirm = () => {
    const last = messages.at(-1);
    onConfirm({ ...transcript, messages: messages.map((message) => ({ ...message, confidence: 1 })), lastSpeaker: last?.role ?? 'unknown', lastMessage: last?.text ?? '', requiresConfirmation: false });
  };
  return <section className="intervention-card"><header><div><span className="intervention-icon">!</span><div><h2>请确认识别结果</h2><p>部分消息的角色或文字置信度较低，确认后再生成建议。</p></div></div></header>{transcript.containsSensitiveData && <div className="privacy-notice"><ShieldIcon /> 已识别并遮盖：{transcript.sensitiveDataTypes.join('、')}</div>}<div className="transcript-editor">{messages.map((message, index) => <div className={message.confidence < .7 ? 'transcript-row low-confidence' : 'transcript-row'} key={message.id}><select aria-label={`第${index + 1}条消息角色`} value={message.role} onChange={(event) => update(index, { role: event.target.value as typeof message.role })}><option value="customer">客户</option><option value="sales">销售</option><option value="unknown">待确认</option></select><textarea aria-label={`第${index + 1}条消息内容`} value={message.text} onChange={(event) => update(index, { text: event.target.value })} /><span>{Math.round(message.confidence * 100)}%</span></div>)}</div><button className="primary-button intervention-submit" disabled={messages.some((message) => message.role === 'unknown' || !message.text.trim())} onClick={confirm}><CheckIcon /> 确认并继续分析</button></section>;
}

export function ClarificationPanel({ questions, onSubmit }: { questions: ClarificationQuestion[]; onSubmit: (answers: Array<{ id: string; answer: string }>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <section className="intervention-card"><header><div><span className="intervention-icon">?</span><div><h2>还需要补充一点信息</h2><p>最多追问2个关键问题，提交后会立即给出建议。</p></div></div></header><div className="clarification-list">{questions.slice(0, 2).map((question) => <label key={question.id}><span>{question.question}</span><textarea value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="请输入你了解的情况；不确定可填写“不清楚”" /></label>)}</div><button className="primary-button intervention-submit" disabled={questions.some((question) => !(answers[question.id] ?? '').trim())} onClick={() => onSubmit(questions.map((question) => ({ id: question.id, answer: answers[question.id] ?? '' })))}><CheckIcon /> 提交并继续</button></section>;
}

export function AnalysisError({ message }: { message: string }) {
  return <section className="intervention-card error-state"><span className="intervention-icon">×</span><h2>本次分析未完成</h2><p>{message}</p><small>原始内容仍保留，可修改输入后重新提交。</small></section>;
}
