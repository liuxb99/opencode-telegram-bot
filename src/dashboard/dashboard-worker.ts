import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 5_000;
const MAX_RESTART_DELAY = 8_000;

let worker: Worker | null = null;
let workerPort: number | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongTimeout: ReturnType<typeof setTimeout> | null = null;
let restartCount = 0;
let resolveReady: ((port: number) => void) | null = null;
let rejectReady: ((err: Error) => void) | null = null;
let shuttingDown = false;
const preWorkerLogBuffer: Array<{ level: string; msg: string }> = [];

function getRestartDelay(): number {
  return Math.min(1_000 * Math.pow(2, restartCount), MAX_RESTART_DELAY);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!worker || shuttingDown) return;
    worker.postMessage({ type: "ping" });
    pongTimeout = setTimeout(() => {
      logger.warn("[Dashboard] Worker unresponsive (no pong), restarting...");
      spawnWorker();
    }, HEARTBEAT_TIMEOUT);
  }, HEARTBEAT_INTERVAL);
  heartbeatTimer.unref();
}

function handleWorkerMessage(msg: Record<string, unknown>): void {
  if (msg.type === "ready") {
    const p = msg.port as number;
    workerPort = p;
    restartCount = 0;
    startHeartbeat();
    // Flush pre-worker log buffer
    if (preWorkerLogBuffer.length > 0) {
      const buf = preWorkerLogBuffer.splice(0);
      for (const entry of buf) { worker?.postMessage({ type: "log", level: entry.level, msg: entry.msg }); }
    }
    logger.info("[Dashboard] Dashboard worker started on port " + p);
    resolveReady?.(p);
    resolveReady = null;
    rejectReady = null;
  } else if (msg.type === "pong") {
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
  }
}

function handleWorkerError(err: Error): void {
  logger.error("[Dashboard] Worker error:", err);
  if (!shuttingDown) spawnWorker();
}

function handleWorkerExit(code: number): void {
  logger.warn("[Dashboard] Worker exited with code " + code);
  if (!shuttingDown) spawnWorker();
}

function spawnWorker(): void {
  stopHeartbeat();

  // If a ready promise is still pending, reject it
  if (rejectReady) {
    rejectReady(new Error("Worker restarted"));
    resolveReady = null;
    rejectReady = null;
  }

  // Kill existing
  if (worker) {
    worker.removeAllListeners();
    worker.terminate().catch(() => {});
    worker = null;
    workerPort = null;
  }

  const delay = getRestartDelay();
  restartCount++;
  logger.info(`[Dashboard] Spawning worker in ${delay}ms (attempt ${restartCount})`);

  setTimeout(() => {
    if (shuttingDown) return;
    const workerPath = path.join(__dirname, "worker-entry.js");
    try {
      worker = new Worker(workerPath, { workerData: { port: workerPort ?? 3000 } });
      worker.on("message", handleWorkerMessage);
      worker.on("error", handleWorkerError);
      worker.on("exit", handleWorkerExit);
    } catch (err) {
      logger.error("[Dashboard] Failed to create worker:", err);
      if (!shuttingDown) spawnWorker();
    }
  }, delay);
}

export async function startDashboardWorker(port = 3000): Promise<number> {
  if (worker && workerPort !== null) {
    return workerPort;
  }

  shuttingDown = false;

  return new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    const workerPath = path.join(__dirname, "worker-entry.js");
    worker = new Worker(workerPath, { workerData: { port } });
    worker.on("message", handleWorkerMessage);
    worker.on("error", handleWorkerError);
    worker.on("exit", handleWorkerExit);
  });
}

export function stopDashboardWorker(): void {
  shuttingDown = true;
  stopHeartbeat();
  if (resolveReady) {
    resolveReady = null;
    rejectReady = null;
  }
  if (worker) {
    worker.removeAllListeners();
    worker.postMessage({ type: "shutdown" });
    worker = null;
    workerPort = null;
  }
}

export function postLogToWorker(level: string, msg: string): void {
  if (worker && workerPort !== null) {
    worker.postMessage({ type: "log", level, msg });
  } else if (!shuttingDown) {
    preWorkerLogBuffer.push({ level, msg });
    if (preWorkerLogBuffer.length > 200) preWorkerLogBuffer.shift();
  }
}

export function getWorkerStatus(): { alive: boolean; port: number | null; restarts: number } {
  return { alive: worker !== null, port: workerPort, restarts: restartCount };
}
