/**
 * How this Actor process should behave.
 *
 * Apify sets `APIFY_META_ORIGIN=STANDBY` only when the run was started through
 * Standby. Console, API, CLI, and Schedule starts use other values
 * (`WEB`, `API`, `SCHEDULER`, and so on). The SDK exposes the same value as
 * `Actor.config.get("metaOrigin")`.
 *
 * https://docs.apify.com/actors/development/programming-interface/standby#detect-the-run-mode
 */
export type ActorRunMode = "standby" | "automation";

export function actorRunMode(env: NodeJS.ProcessEnv = process.env): ActorRunMode {
  return env.APIFY_META_ORIGIN === "STANDBY" ? "standby" : "automation";
}
