export interface Progress { phase: string; completed: number; total: number; detail?: string }
export interface WorkControl { checkpoint?: (progress: Progress) => Promise<void> }
export const checkpoint = async (control: WorkControl | undefined, progress: Progress) => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await control?.checkpoint?.(progress);
};
