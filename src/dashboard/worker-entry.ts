import { parentPort, workerData } from "node:worker_threads";
import { startDashboard, stopDashboard, pushLog } from "./server.js";
import { initializeStore, closeDatabase } from "../conversation-log/store.js";

async function main(): Promise<void> {
  initializeStore();

  const port = await startDashboard(workerData?.port ?? 3000);
  parentPort?.postMessage({ type: "ready", port });

  parentPort?.on("message", (msg) => {
    if (msg.type === "ping") {
      parentPort?.postMessage({ type: "pong" });
    } else if (msg.type === "log") {
      pushLog(msg.level as string, msg.msg as string);
    } else if (msg.type === "shutdown") {
      stopDashboard();
      closeDatabase();
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error("[DashboardWorker] Fatal error:", err);
  process.exit(1);
});
