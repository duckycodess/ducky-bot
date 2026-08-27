import type { ScheduleDraft } from '@ducky/contracts';

export interface ScheduleSource {
  readonly kind: 'text' | 'file';
  /** Decoded text. Phase 1 only ever supplies text/plain or text/csv. */
  readonly text: string;
  readonly contentType?: string;
}

export interface ScheduleExtractionProvider {
  readonly name: string;
  /**
   * Whether this provider can read images or PDFs. No Phase 1 provider can, so
   * those uploads are refused before any download rather than producing an
   * invented preview.
   */
  readonly supportsBinary: boolean;
  extract(source: ScheduleSource): Promise<ScheduleDraft>;
}
