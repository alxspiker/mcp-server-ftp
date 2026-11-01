import { Actor } from "apify";
import { actorRunMode } from "./actor-mode.js";
import { apifyDataset, openApifySnapshotStore } from "./apify-store.js";
import { startServer, type Charge } from "./apify-server.js";
import { runAutomation, runAutomationTool, type AutomationInput } from "./automation.js";

await Actor.init();

if (actorRunMode() === "standby") {
  const input = await Actor.getInput<AutomationInput>();
  if (!input) throw new Error("Missing Actor input. Enable 'Validate and pass Actor input' in Standby settings.");
  const port = Actor.config.get("containerPort");
  if (!port) throw new Error("Missing ACTOR_WEB_SERVER_PORT");
  let app: { close: () => Promise<void> } | undefined;
  const charge: Charge = async (eventName) => {
    const result = await Actor.charge({ eventName });
    if (result.eventChargeLimitReached) {
      console.error("The run's event spending limit has been reached.");
      const closing = app;
      setTimeout(() => { void closing?.close().then(() => Actor.exit()); }, 1000).unref();
    }
    return result;
  };
  const services = { openStore: openApifySnapshotStore, dataset: apifyDataset, charge };
  app = await startServer(input, charge, port, "0.0.0.0", (tool, args) => runAutomationTool(input, tool, args, services));
  Actor.on("aborting", async () => { await app?.close(); });
  console.log(`FTP MCP server listening on port ${port}`);
} else {
  const input = await Actor.getInput<AutomationInput>();
  if (!input) throw new Error("Missing Actor input.");
  const charge: Charge = async (eventName) => Actor.charge({ eventName });
  try {
    const result = await runAutomation(input, { openStore: openApifySnapshotStore, dataset: apifyDataset, charge });
    console.log(result.summary);
    await Actor.exit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    await Actor.fail(message);
  }
}
