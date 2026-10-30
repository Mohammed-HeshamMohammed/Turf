# Sourced by the run scripts: `. tools/load-env.sh env/<part>.env`. Exports each KEY=value line of the file (env/README.md)
# that is not set already, so a setting from the environment wins. Stops with a hint when the file does not exist.
callerwhale_env_file="$1"
if [ ! -f "$callerwhale_env_file" ]; then
  echo "Missing $callerwhale_env_file: run node tools/env-init.mjs from Caller Whale CRM/ (see env/README.md)" >&2
  exit 1
fi
while IFS= read -r callerwhale_env_line || [ -n "$callerwhale_env_line" ]; do
  callerwhale_env_line="${callerwhale_env_line%$'\r'}"
  case "$callerwhale_env_line" in '' | \#*) continue ;; esac
  callerwhale_env_key="${callerwhale_env_line%%=*}"
  if [ -z "${!callerwhale_env_key+set}" ]; then export "$callerwhale_env_key=${callerwhale_env_line#*=}"; fi
done <"$callerwhale_env_file"
unset callerwhale_env_file callerwhale_env_line callerwhale_env_key
