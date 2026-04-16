export interface Bridge {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readonly isConnected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}
