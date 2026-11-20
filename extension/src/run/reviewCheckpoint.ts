import type { Proposal, Run } from '../types';

export interface ReviewCheckpoint {
  run: Run;
  proposal: Proposal;
  turnId: string;
  runtime: string;
  root: string;
}

export const reviewCheckpointKey = 'review.pending.v1';
