import type { Express } from "express";
import type { Server } from "http";
import type { AiTaskConnection, AiTaskCoordinator, TeamConnection, TeamRuntime } from './lib/ai-tasks/runtime.js';

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getAiTasks: () => AiTaskCoordinator | null;
  getTeam: () => TeamRuntime | null;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  isReady: () => boolean;
  getManagedOpenCodePreflight: () => Promise<boolean>;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface DesktopUpdateInfo {
  available: boolean;
  currentVersion?: string;
  version?: string | null;
  body?: string | null;
  date?: string | null;
}

export interface DesktopUpdater {
  check: () => Promise<DesktopUpdateInfo>;
  install: () => Promise<DesktopUpdateInfo>;
  restart: () => Promise<void> | void;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  desktopUpdater?: DesktopUpdater;
  /** App-owned built-in resources outside Electron's ASAR archive. */
  builtInExtensionsDir?: string;
  /** Optional host-approved Notion adapter. No credential transfer is performed. */
  aiTaskConnection?: AiTaskConnection;
  /** Optional trusted local host team state and native demand observer. No HTTP controls are installed. */
  teamConnection?: TeamConnection;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
