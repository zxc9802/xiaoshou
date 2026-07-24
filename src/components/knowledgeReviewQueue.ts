import type { KnowledgeImportJob } from '../types/analysis';

export interface ReviewImportOption {
  id: string;
  label: string;
}

export function buildReviewImportOptions(imports: KnowledgeImportJob[]): ReviewImportOption[] {
  return imports.flatMap((job) => {
    if (job.status !== 'waiting_review') return [];
    const pendingCount = job.candidates.filter((candidate) => candidate.reviewStatus !== 'discarded').length;
    if (pendingCount === 0) return [];
    const firstFileName = job.sourceFiles[0]?.name ?? '未命名资料批次';
    const fileLabel = job.sourceFiles.length > 1 ? `${firstFileName} 等 ${job.sourceFiles.length} 个文件` : firstFileName;
    return [{ id: job.id, label: `${fileLabel} · ${pendingCount} 条待确认` }];
  });
}
