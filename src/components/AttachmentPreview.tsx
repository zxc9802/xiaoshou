import { ImageIcon, TrashIcon } from './Icons';

export interface AttachmentItem { file: File; url: string }

export function AttachmentPreview({ item, onRemove }: { item: AttachmentItem; onRemove: () => void }) {
  return (
    <div className="attachment-item">
      <div className="attachment-thumb">{item.file.type.startsWith('image/') ? <img src={item.url} alt="聊天截图预览" /> : <ImageIcon />}</div>
      <div className="attachment-meta"><strong>{item.file.name}</strong><span>{(item.file.size / 1024).toFixed(1)} KB</span></div>
      <button className="icon-button danger" onClick={onRemove} aria-label={`删除 ${item.file.name}`}><TrashIcon /></button>
    </div>
  );
}
