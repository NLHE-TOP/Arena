/** An operator-started PokerTools 2.0.0 deployment; NLHE never builds it. */
export interface PlatformHandle {
  baseUrl: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
  /** Optional operator-provided restart for financial test isolation. */
  restartApi?: () => Promise<void>;
}
