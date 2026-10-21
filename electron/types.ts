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
  movieId?: string;
  date: string;
  format: Format;
  isEnabled: boolean;
  shouldNotifyEarliestOnly?: boolean;
}
export interface Rule extends Omit<RuleInput, 'id'> {
  id: string;
  revision: number;
  movieId?: string;
}
export interface Session {
  notificationKind?: 'dayOpen' | 'earliest';
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
export type LocalOutboxItem = Omit<OutboxItem, 'secretRevision'>;
export type LocalAlertResult = { kind: 'requested' | 'failed' | 'unsupported'; detail?: string };
export interface HistoryItem {
  id: string;
  at: number;
  kind: 'sent' | 'failed' | 'expired' | 'overflow' | 'localRequested' | 'localFailed' | 'cancelled';
  title: string;
  detail: string;
}
export interface Settings {
  intervalSeconds: number;
  isPaused: boolean;
  shouldStartAtLogin: boolean;
  hasConfiguredLogin: boolean;
  shouldNotifyLocally: boolean;
  shouldKeepAwake?: boolean;
}
export interface State {
  schemaVersion: 2;
  rules: Rule[];
  settings: Settings;
  progress: Record<string, RuleProgress>;
  secret: { encrypted?: string; revision: number; isTerminal: boolean; retryAt?: number };
  outbox: OutboxItem[];
  dedupe: Record<string, number>;
  localOutbox: LocalOutboxItem[];
  localDedupe: Record<string, number>;
  history: HistoryItem[];
}
export interface EarliestSession {
  identity: string;
  startsAt: number;
  date: string;
  time: string;
  format: Session['format'];
  screen: string;
}
export interface RuleEarliest {
  revision: number;
  checkedAt: number;
  session?: EarliestSession;
}
export interface Snapshot {
  earliestByRule?: Record<string, RuleEarliest>;
  isKeepingAwake?: boolean;
  keepAwakeWarning?: string;
  rules: Rule[];
  settings: Settings;
  progress: Record<string, Omit<RuleProgress, 'baseline'>>;
  history: HistoryItem[];
  pendingCount: number;
  localPendingCount: number;
  isLocalAlertSupported: boolean;
  localAlertWarning?: string;
  hasWebhook: boolean;
  isWebhookBlocked: boolean;
  isEncryptionAvailable: boolean;
  isOnline: boolean;
  isSuspended: boolean;
  isChecking: boolean;
  nextAt?: number;
  recoveryError?: string;
  loginWarning?: string;
  trayWarning?: string;
  storagePath: string;
}
export interface Catalog {
  provider: Provider;
  fetchedAt: number;
  regions: { id: string; name: string }[];
  theaters: { id: string; name: string; regionId: string }[];
  movies: { id: string; title: string; posterUrl?: string }[];
}
export interface CatalogRequest {
  provider: Provider;
  requestId: string;
  force?: boolean;
}
export interface PosterRequest {
  provider: Provider;
  movieId?: string;
  movieTitle: string;
  requestId: string;
}
export interface PosterResult {
  dataUrl?: string;
}
export interface UpdateState {
  revision: number;
  phase:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'verifying'
    | 'ready'
    | 'opening'
    | 'opened'
    | 'error';
  currentVersion: string;
  platformLabel: string;
  availableVersion?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  lastCheckedAt?: number;
  nextCheckAllowedAt?: number;
  message?: string;
}
export interface CinemaApi {
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  cancelUpdate(): Promise<UpdateState>;
  openUpdateInstaller(): Promise<UpdateState>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  getPoster(input: PosterRequest): Promise<PosterResult>;
  cancelPoster(input: { requestId: string }): Promise<void>;
  getCatalog(input: CatalogRequest): Promise<Catalog>;
  cancelCatalog(input: { requestId: string }): Promise<void>;
  getSnapshot(): Promise<Snapshot>;
  saveRule(input: RuleInput): Promise<Snapshot>;
  deleteRule(id: string): Promise<Snapshot>;
  setPaused(value: boolean): Promise<Snapshot>;
  saveWebhook(url: string): Promise<Snapshot>;
  deleteWebhook(): Promise<Snapshot>;
  updateSettings(input: {
    intervalSeconds?: number;
    shouldStartAtLogin?: boolean;
    shouldNotifyLocally?: boolean;
    shouldKeepAwake?: boolean;
  }): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  openBooking(input: { provider: Provider; url: string }): Promise<void>;
  recoverStorage(): Promise<Snapshot>;
  quit(): Promise<void>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}
