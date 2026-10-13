// Stable entry point for screens and tests. Domain modules share one transport and job runner.
// Desktop calls use the Rust host; browser development uses the local /rpc bridge.
export { call, inDesktop, ServiceError } from "./service/transport";
export * from "./service/jobs";
export * from "./service/projects";
export * from "./service/datasets";
export * from "./service/lists";
export * from "./service/leads";
export * from "./service/skiptrace";
export * from "./service/state";
export * from "./service/enrichment";
