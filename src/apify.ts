import { Actor } from "apify";
import { startServer, type Input } from "./apify-server.js";

await Actor.init();
if (Actor.config.get("metaOrigin") !== "STANDBY") throw new Error("This Actor must be run in Standby mode. Enable input passing and use a task's Standby URL.");
const input = await Actor.getInput<Input>();
if (!input) throw new Error("Missing Actor input. Enable 'Validate and pass Actor input' in Standby settings.");
const port = Actor.config.get("containerPort");
if (!port) throw new Error("Missing ACTOR_WEB_SERVER_PORT");
const app = await startServer(input, async (eventName) => {
  const result = await Actor.charge({ eventName });
  if (result.eventChargeLimitReached) {
    console.error("The run's event spending limit has been reached.");
    setTimeout(() => { void app.close().then(() => Actor.exit()); }, 1000).unref();
  }
}, port);
Actor.on("aborting", async () => { await app.close(); });
console.log(`FTP MCP server listening on port ${port}`);
