import { useRef, useState } from 'react';
import { ArrowIcon, CheckIcon, ChevronIcon, PlusIcon, ShieldIcon, UploadIcon } from './Icons';
import { AttachmentPreview, type AttachmentItem } from './AttachmentPreview';
import type { AnalysisRequest } from '../types/analysis';
import { ProductSelect } from './ProductSelect';

export function ConversationInputCard({ busy, onAnalyze }: { busy: boolean; onAnalyze: (request: AnalysisRequest) => void }) {
  const [text, setText] = useState('');
  const [product, setProduct] = useState('');
  const [background, setBackground] = useState('');
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [fileError, setFileError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const enabled = text.trim().length > 0 || attachments.length > 0;

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const supported = Array.from(files).filter((file) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
    const accepted = supported.filter((file) => file.size <= 8 * 1024 * 1024).slice(0, Math.max(0, 10 - attachments.length));
    setFileError(supported.length !== files.length ? '仅支持 png、jpg、jpeg、webp 格式' : supported.length !== accepted.length ? '最多上传10张截图，且单张不能超过8MB' : '');
    setAttachments((current) => [...current, ...accepted.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeAttachment = (index: number) => setAttachments((items) => {
    URL.revokeObjectURL(items[index].url);
    return items.filter((_, itemIndex) => itemIndex !== index);
  });

  return (
    <section className="input-card" aria-label="客户对话输入">
      <div className="input-heading"><span className="section-icon"><PlusIcon /></span><div><h2>添加客户对话</h2><p>信息越完整，分析建议越准确</p></div></div>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴销售与客户的完整对话，或说明你卡在哪一步……" aria-label="客户完整对话" />
      {attachments.length > 0 && <div className="attachment-list">{attachments.map((item, index) => <AttachmentPreview key={`${item.file.name}-${index}`} item={item} onRemove={() => removeAttachment(index)} />)}</div>}
      {fileError && <p className="field-error" role="alert">{fileError}</p>}
      <div className="input-tools">
        <input ref={inputRef} className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.webp" multiple onChange={(event) => addFiles(event.target.files)} />
        <button className="secondary-button" onClick={() => inputRef.current?.click()}><UploadIcon /> 上传聊天截图</button>
        <span className="file-hint">支持 png、jpg、jpeg、webp，最多 10 张</span>
      </div>
      <div className="input-options">
        <label className="select-field"><span>关联产品 <em>可选</em></span><div className="select-wrap"><ProductSelect value={product} onChange={setProduct} emptyLabel="请选择产品" /><ChevronIcon /></div></label>
        <button className="disclosure" aria-expanded={backgroundOpen} onClick={() => setBackgroundOpen(!backgroundOpen)}><span>补充客户背景 <em>可选</em></span><ChevronIcon className={backgroundOpen ? 'rotate' : ''} /></button>
      </div>
      {backgroundOpen && <textarea className="background-input" value={background} onChange={(event) => setBackground(event.target.value)} placeholder="例如：客户所属行业、团队规模、此前沟通情况……" aria-label="补充客户背景" />}
      <div className="input-footer">
        <div className="verified-note"><span><ShieldIcon /></span><div><strong>严格依据已审核的规则及资料生成</strong><small><CheckIcon /> 关键结论将展示引用来源</small></div></div>
        <button className="primary-button" disabled={!enabled || busy} onClick={() => onAnalyze({ conversation: text, product, customerBackground: background, attachmentNames: attachments.map(({ file }) => file.name), attachmentFiles: attachments.map(({ file }) => file) })}>{busy ? '分析中…' : '开始分析'} {!busy && <ArrowIcon />}</button>
      </div>
    </section>
  );
}
