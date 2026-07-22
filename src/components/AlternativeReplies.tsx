import { useState } from 'react';
import type { AlternativeReply } from '../types/analysis';
import { CopyIcon } from './Icons';

export function AlternativeReplies({ replies }: { replies: AlternativeReply[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(replies[active].content); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="alternative-box">
      <div className="reply-tabs" role="tablist">{replies.map((reply, index) => <button key={reply.tone} role="tab" aria-selected={active === index} className={active === index ? 'active' : ''} onClick={() => setActive(index)}>{reply.tone}</button>)}</div>
      <p>{replies[active].content}</p><button className="text-button" onClick={copy}><CopyIcon /> {copied ? '已复制' : '复制此版本'}</button>
    </div>
  );
}
