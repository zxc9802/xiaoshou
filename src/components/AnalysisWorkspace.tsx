import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { AnalysisHistoryItem, AnalysisJob, AnalysisRequest, ParsedConversation, SalesAnalysisResult } from '../types/analysis';
import { AnalysisProgress } from './AnalysisProgress';
import { AnalysisError, ClarificationPanel, TranscriptReview } from './AnalysisIntervention';
import { AttachmentPreview, type AttachmentItem } from './AttachmentPreview';
import { ArrowIcon, ChevronIcon, ImageIcon, PlusIcon, SparkIcon, TrashIcon, UploadIcon } from './Icons';
import { SalesCoachResult } from './SalesCoachResult';
import { ProductSelect } from './ProductSelect';

function parseConversation(conversation: string) {
  return conversation.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const customer = /^(客户|顾客|对方)[：:]/.test(line);
    const sales = /^(销售|我|我们)[：:]/.test(line);
    return { id: `${index}-${line}`, role: customer ? 'customer' : sales ? 'sales' : index % 2 === 0 ? 'customer' : 'sales', text: line.replace(/^(客户|顾客|对方|销售|我|我们)[：:]\s*/, '') };
  });
}

export function AnalysisWorkspace({ request, result, job, history, busy, progress, progressSteps, analysisKnowledgeEnabled, error, onAnalyze, onReset, onSelectHistory, onDeleteHistory, onConfirmTranscript, onClarify, onCancel, onRetry }: {
  request: AnalysisRequest | null;
  result: SalesAnalysisResult | null;
  job: AnalysisJob | null;
  history: AnalysisHistoryItem[];
  busy: boolean;
  progress: number;
  progressSteps: readonly string[];
  analysisKnowledgeEnabled: boolean;
  error: string;
  onAnalyze: (request: AnalysisRequest) => void;
  onReset: () => void;
  onSelectHistory: (id: string) => void;
  onDeleteHistory: (id: string) => void;
  onConfirmTranscript: (transcript: ParsedConversation) => void;
  onClarify: (answers: Array<{ id: string; answer: string }>) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [product, setProduct] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [conversationCollapsed, setConversationCollapsed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const historyText = request?.conversation ?? '';
  const previewText = [historyText, draft].filter(Boolean).join('\n');
  const messages = useMemo(() => parseConversation(previewText), [previewText]);
  const displayMessages = job?.transcript?.messages ?? messages;
  const attachmentNames = request?.attachmentNames.length ? request.attachmentNames : attachments.map(({ file }) => file.name);
  const canAnalyze = draft.trim().length > 0 || attachments.length > 0;

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const supported = Array.from(files).filter((file) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
    const accepted = supported.filter((file) => file.size <= 8 * 1024 * 1024).slice(0, Math.max(0, 10 - attachments.length));
    setFileError(supported.length !== files.length ? '仅支持 png、jpg、jpeg、webp 格式' : supported.length !== accepted.length ? '最多上传10张截图，且单张不能超过8MB' : '');
    setAttachments((current) => [...current, ...accepted.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    if (fileRef.current) fileRef.current.value = '';
  };
  const removeAttachment = (index: number) => setAttachments((items) => {
    URL.revokeObjectURL(items[index].url);
    return items.filter((_, itemIndex) => itemIndex !== index);
  });
  const submit = () => {
    if (!canAnalyze || busy) return;
    onAnalyze({
      conversation: draft.trim(),
      product: product || request?.product,
      customerBackground: request?.customerBackground,
      attachmentNames: attachments.map(({ file }) => file.name),
      attachmentFiles: attachments.map(({ file }) => file),
    });
    setDraft('');
    attachments.forEach((item) => URL.revokeObjectURL(item.url));
    setAttachments([]);
  };
  const reset = () => { setDraft(''); setProduct(''); setConversationCollapsed(false); attachments.forEach((item) => URL.revokeObjectURL(item.url)); setAttachments([]); onReset(); };
  const selectHistory = (id: string) => {
    if (job?.id === id) {
      setConversationCollapsed((collapsed) => !collapsed);
      return;
    }
    setConversationCollapsed(false);
    onSelectHistory(id);
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <main className="workspace-shell" id="analysis-result">
      <header className="workspace-heading">
        <div><h1>{result ? '对话分析与回复建议' : '今天需要分析哪段客户对话？'}</h1></div>
        {(request || result) && <button className="secondary-button" onClick={reset}><PlusIcon /> 分析新对话</button>}
      </header>
      <div className="analysis-workspace">
        <aside className={`conversation-sidebar${conversationCollapsed ? ' conversation-is-collapsed' : ''}`}>
          <header><div><span className="online-dot" /><strong>历史对话</strong></div><small>{displayMessages.length} 条消息</small></header>
          <div className="conversation-context">{(product || request?.product) && <span>关联产品：{product || request?.product}</span>}{request?.customerBackground && <p>{request.customerBackground}</p>}</div>
          {history.length > 0 && <div className="history-sessions"><span>最近分析</span>{(conversationCollapsed ? history : history.slice(0, 8)).map((item) => { const active = job?.id === item.id; return <div className={`history-session-row${active ? ' active' : ''}`} key={item.id}><button className="history-session-open" onClick={() => selectHistory(item.id)} aria-expanded={active ? !conversationCollapsed : undefined} title={active ? (conversationCollapsed ? '展开当前对话' : '收起当前对话') : '查看此对话'}><div><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div><span className="history-session-tail"><em>{item.stage ?? (item.status === 'needs_confirmation' ? '待确认' : item.status === 'handoff' ? '需人工' : '分析中')}</em>{active && <ChevronIcon className={conversationCollapsed ? '' : 'is-open'} />}</span></button><button className="history-session-delete" onClick={() => onDeleteHistory(item.id)} aria-label={`删除历史对话：${item.title}`} title="删除此记录"><TrashIcon /></button></div>; })}</div>}
          {!conversationCollapsed ? <div className="message-list">
            {displayMessages.length ? <><div className="current-dialogue-label">当前对话</div>{displayMessages.map((message) => <div className={`message-row ${message.role}`} key={message.id}><span className="message-avatar">{message.role === 'customer' ? '客' : message.role === 'sales' ? '我' : '?'}</span><div><small>{message.role === 'customer' ? '客户' : message.role === 'sales' ? '销售' : '待确认'}</small><p>{message.text}</p></div></div>)}</> : <div className="chat-empty"><span><SparkIcon /></span><strong>等待添加客户对话</strong><p>在右侧下方粘贴完整对话，聊天记录会同步显示在这里。</p></div>}
            {attachmentNames.map((name) => <div className="history-attachment" key={name}><ImageIcon /><span><strong>聊天截图</strong><small>{name}</small></span></div>)}
          </div> : null}
          <div className="history-footer">AI仅分析，不会自动向客户发送消息</div>
        </aside>
        <section className="coach-column">
          {error && <div className="workspace-error" role="alert">{error}</div>}
          {job?.status === 'needs_confirmation' && job.transcript?.requiresConfirmation ? <TranscriptReview key={job.id} transcript={job.transcript} onConfirm={onConfirmTranscript} /> : job?.status === 'needs_confirmation' ? <ClarificationPanel key={job.id} questions={job.clarificationQuestions} onSubmit={onClarify} /> : job?.status === 'failed' || job?.status === 'canceled' ? <><AnalysisError message={job.status === 'canceled' ? '本次分析已取消，可随时重新开始。' : job.error?.message ?? '分析服务暂时不可用'} /><div className="analysis-task-actions"><button className="secondary-button" onClick={onRetry}>重新分析</button></div></> : busy && !result ? <><AnalysisProgress steps={progressSteps} activeIndex={progress} /><div className="analysis-task-actions"><button className="secondary-button" onClick={onCancel}>取消分析</button></div></> : result ? <SalesCoachResult key={job?.id ?? 'result'} result={result} embedded jobStatus={job?.status} analysisId={job?.id} analysisKnowledgeEnabled={analysisKnowledgeEnabled} /> : <EmptyAdvice analysisKnowledgeEnabled={analysisKnowledgeEnabled} />}
          <div className={`followup-composer main-composer${dragging ? ' is-dragging' : ''}`} onDragEnter={handleDragOver} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} aria-label="图片上传区域">
            {dragging && <div className="drop-overlay" role="status"><UploadIcon /><strong>松开即可上传聊天截图</strong><span>支持 png、jpg、jpeg、webp，最多10张</span></div>}
            <div className="composer-title"><div><strong>{result ? '补充最新对话' : '添加客户对话'}</strong><span>{result ? '客户有新回复？粘贴后继续分析' : '粘贴完整对话，或上传聊天截图'}</span></div>{busy && result && <em>正在重新分析…</em>}</div>
            <div className="composer-input"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }} placeholder={result ? '例如：客户：预算确实超出了，我们需要再考虑一下……' : '粘贴销售与客户的完整对话，或说明你卡在哪一步……'} aria-label={result ? '补充最新客户对话' : '客户完整对话'} /><button disabled={!canAnalyze || busy} onClick={submit} aria-label={result ? '补充并重新分析' : '开始分析'}><ArrowIcon /></button></div>
            {attachments.length > 0 && <div className="composer-attachments">{attachments.map((item, index) => <AttachmentPreview key={`${item.file.name}-${index}`} item={item} onRemove={() => removeAttachment(index)} />)}</div>}
            {fileError && <p className="field-error" role="alert">{fileError}</p>}
            <div className="composer-tools">
              <input ref={fileRef} className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.webp" multiple onChange={(event) => addFiles(event.target.files)} />
              <button className="composer-tool" onClick={() => fileRef.current?.click()}><UploadIcon /> 上传截图</button>
              <ProductSelect value={product} onChange={setProduct} />
              <span className="composer-shortcut">Enter 发送分析 · Shift+Enter 换行</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function EmptyAdvice({ analysisKnowledgeEnabled }: { analysisKnowledgeEnabled: boolean }) {
  return <section className="advice-empty"><h2>回复建议将在这里生成</h2><p>{analysisKnowledgeEnabled ? '完成对话输入后，AI将结合企业规则和已审核资料，优先提供推荐回复，并给出客户阶段、需求判断与下一步策略。' : '完成对话输入后，AI将直接分析客户对话，优先提供推荐回复，并给出客户阶段、需求判断与下一步策略。'}</p><div><span>1</span>识别客户阶段<i /><span>2</span>定位沟通卡点<i /><span>3</span>生成回复建议</div></section>;
}
