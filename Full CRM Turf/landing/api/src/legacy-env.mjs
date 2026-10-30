// Settings are CALLERWHALE_*. A server still configured with the old TURF_* names keeps working: each one that has no
// CALLERWHALE_ twin is copied over before anything reads the environment (this file is imported first).
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("TURF_")) process.env["CALLERWHALE_" + name.slice(5)] ??= value;
}
