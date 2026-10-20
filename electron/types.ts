export const PROVIDERS = ['cgv', 'megabox', 'lottecinema'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const FORMATS = ['ALL', '2D', '3D', 'IMAX', '4DX', 'DOLBY', 'SCREENX'] as const;
export type Format = (typeof FORMATS)[number];
export interface RuleInput {
  id?: string;
  provider: Provider;
  theaterId: string;
  theaterName: string;
  movieTitle: string;
  date: string;
  format: Format;
  isEnabled: boolean;
}
export interface Rule extends Omit<RuleInput, 'id'> {
  id: string;
  revision: number;
  movieId?: string;
}
export interface Session {
  provider: Provider;
  showingId?: string;
  theaterId: string;
  theaterName: string;
  movieId: string;
  movieTitle: string;
  date: string;
  time: string;
  screen: string;
  format: Exclude<Format, 'ALL'> | 'UNKNOWN';
  isBookable: boolean;
  bookingUrl: string;
}
export interface RuleProgress {
  revision: number;
  baseline?: Record<string, boolean>;
  lastSuccess?: number;
  lastFailure?: number;
  error?: string;
  failures: number;
  nextAt: number;
  retryUntil?: number;
  count: number;
}
export interface OutboxItem {
  id: string;
  session: Session;
  ruleRefs: { id: string; revision: number }[];
  secretRevision: number;
  createdAt: number;
  nextAt: number;
  attempts: number;
}
export interface HistoryItem {
  id: string;
  at: number;
  kind: 'sent' | 'failed' | 'expired' | 'overflow';
  title: string;
  detail: string;
}
export interface Settings {
  intervalSeconds: number;
  isPaused: boolean;
  shouldStartAtLogin: boolean;
  hasConfiguredLogin: boolean;
}
export interface State {
  schemaVersion: 1;
  rules: Rule[];
  settings: Settings;
  progress: Record<string, RuleProgress>;
  secret: { encrypted?: string; revision: number; isTerminal: boolean; retryAt?: number };
  outbox: OutboxItem[];
  dedupe: Record<string, number>;
  history: HistoryItem[];
}
export interface Snapshot {
  rules: Rule[];
  settings: Settings;
  progress: Record<string, Omit<RuleProgress, 'baseline'>>;
  history: HistoryItem[];
  pendingCount: number;
  hasWebhook: boolean;
  isWebhookBlocked: boolean;
  isEncryptionAvailable: boolean;
  isOnline: boolean;
  isSuspended: boolean;
  isChecking: boolean;
  nextAt?: number;
  recoveryError?: string;
  loginWarning?: string;
  storagePath: string;
}
export interface CinemaApi {
  getSnapshot(): Promise<Snapshot>;
  saveRule(input: RuleInput): Promise<Snapshot>;
  deleteRule(id: string): Promise<Snapshot>;
  setPaused(value: boolean): Promise<Snapshot>;
  saveWebhook(url: string): Promise<Snapshot>;
  deleteWebhook(): Promise<Snapshot>;
  updateSettings(input: {
    intervalSeconds?: number;
    shouldStartAtLogin?: boolean;
  }): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  openBooking(input: { provider: Provider; url: string }): Promise<void>;
  recoverStorage(): Promise<Snapshot>;
  quit(): Promise<void>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}
