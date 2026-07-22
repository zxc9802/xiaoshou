export * from '../../shared/contracts';

import type { AnalysisRequestInput } from '../../shared/contracts';

export interface AnalysisRequest extends AnalysisRequestInput {
  attachmentFiles?: File[];
}
