export type Status = 'pass' | 'partial' | 'fail' | 'n/a';

export interface Res {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  redirects: number;
}

/** res null = network error or skipped; error says why. */
export interface Fetched {
  res: Res | null;
  error?: string;
}

export interface Probe {
  url: string;
  res: Res | null;
}

/** Everything the checks need. Checks are pure functions over this. */
export interface Snapshot {
  origin: string;
  home: Res | null;
  homeError?: string;
  robots: Res | null;
  sitemapUrl: string | null;
  sitemap: Res | null;
  childSitemap: Res | null;
  productUrl: string | null;
  product: Res | null;
  llms: Res | null;
  llmsLinks: Probe[];
  markdownAccept: Res | null;
  indexMd: Res | null;
  productMd: Res | null;
  pricingMd: Res | null;
  notFound: Res | null;
  feeds: Probe[];
  protocols: Probe[];
}

export interface CheckOutput {
  status: Status;
  evidence: string;
}

export interface CheckDef {
  id: number;
  name: string;
  level: 1 | 2 | 3 | 4;
  impact: 'H' | 'M' | 'L';
  weight: number;
  /** What counts as pass, in plain words, for the public docs. */
  passRule: string;
  run: (s: Snapshot) => CheckOutput;
}

export interface CheckResult extends CheckOutput {
  id: number;
  name: string;
  level: 1 | 2 | 3 | 4;
  weight: number;
}

export interface LevelScore {
  /** null when the level has no scorable checks. */
  score: number | null;
  checks: number;
}

export interface ScoreSummary {
  levels: { 1: LevelScore; 2: LevelScore; 3: LevelScore; 4: LevelScore };
  /** Before blockers. */
  raw: number;
  /** Points, 0-120 uncapped (4 levels × 0.3); UI shows min(overall, 100). */
  overall: number;
  blockers: string[];
}

export type RefundReason = 'unreachable' | 'blocked_by_robots' | 'waf_blocked';

export type Platform = 'wordpress' | 'shopify' | 'website';

export interface ScanResult {
  url: string;
  origin: string;
  platform: Platform;
  scannedAt: string;
  checks: CheckResult[];
  score: ScoreSummary;
  /** The site's own logo (Organization JSON-LD, else icon link), absolute http(s) URL; '' when it has none. */
  logo: string;
  refund: { eligible: boolean; reason: RefundReason | null; detail: string | null };
  /** The site answered some requests with 429 (or 503 + Retry-After): it is throttling the crawler. */
  rateLimited: boolean;
}
