import { useState } from 'react';
import { CheckIcon, CopyIcon, SparkIcon } from './Icons';

export function RecommendedReply({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="reply-highlight">
      <div className="reply-caption"><span><SparkIcon /> AI 推荐</span><button onClick={copy}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? '已复制' : '一键复制'}</button></div>
      <p>{content}</p>
      {copied && <span className="copy-toast" role="status"><CheckIcon /> 已复制到剪贴板</span>}
    </div>
  );
}
