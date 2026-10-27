# Sourced by the run scripts: `. tools/load-env.sh env/<part>.env`. Exports each KEY=value line of the file (env/README.md)
# that is not set already, so a setting from the environment wins. Stops with a hint when the file does not exist.
turf_env_file="$1"
if [ ! -f "$turf_env_file" ]; then
  echo "Missing $turf_env_file: run node tools/env-init.mjs from Full CRM Turf/ (see env/README.md)" >&2
  exit 1
fi
while IFS= read -r turf_env_line || [ -n "$turf_env_line" ]; do
  turf_env_line="${turf_env_line%$'\r'}"
  case "$turf_env_line" in '' | \#*) continue ;; esac
  turf_env_key="${turf_env_line%%=*}"
  if [ -z "${!turf_env_key+set}" ]; then export "$turf_env_key=${turf_env_line#*=}"; fi
done <"$turf_env_file"
unset turf_env_file turf_env_line turf_env_key
