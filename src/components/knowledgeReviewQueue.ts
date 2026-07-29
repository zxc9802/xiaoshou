import type { KnowledgeImportJob } from '../types/analysis';

export interface ReviewImportOption {
  id: string;
  label: string;
}

export function buildReviewImportOptions(imports: KnowledgeImportJob[]): ReviewImportOption[] {
  return imports.flatMap((job) => {
    if (job.status !== 'waiting_review' && job.status !== 'failed') return [];
    const pendingCount = job.candidates.filter((candidate) => candidate.reviewStatus !== 'discarded').length;
    const firstFileName = job.sourceFiles[0]?.name ?? '未命名资料批次';
    const fileLabel = job.sourceFiles.length > 1 ? `${firstFileName} 等 ${job.sourceFiles.length} 个文件` : firstFileName;
    const statusLabel = pendingCount > 0
      ? `${pendingCount} 条待确认`
      : job.status === 'failed' ? '解析失败，可重新解析' : '未提取候选条目，可人工补充';
    return [{ id: job.id, label: `${fileLabel} · ${statusLabel}` }];
  });
}
