#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
fail() { printf 'herdr-zcode: %s\n' "$*" >&2; exit 1; }
command_name=${1:-help}
[ "$#" -eq 0 ] || shift
case "$command_name" in
  help|--help|-h)
    printf '%s\n' 'Usage: ./dev <command> [arguments]' 'setup                 Prepare pinned npm (requires the exact Node installed through nvm)' 'doctor [--desktop]    Show declared/actual versions and executable paths' 'run [CLI arguments]   Start herdr-zcode' 'test                  Run offline tests' 'pack                  Create a distribution in dist/' 'install [--prefix P]  Install a standalone copy (default: ~/.local)' 'node [arguments]      Run pinned Node' 'npm [arguments]       Run pinned npm; live tests require an explicit npm run test:live-* command' 'Upgrade: edit toolchains.env, install the declared Node if missing, then setup, doctor and test.'
    exit 0 ;;
esac
[ -f "$root/toolchains.env" ] || fail 'Missing toolchains.env'
seen=' '
while IFS='=' read -r key value || [ -n "$key" ]; do
  case "$key" in ''|\#*) continue ;; esac
  case "$key" in NODE_VERSION|NPM_VERSION|ZCODE_APP_MIN_VERSION) ;; *) fail "Unknown toolchain key: $key" ;; esac
  case "$seen" in *" $key "*) fail "Duplicate toolchain key: $key" ;; esac
  seen="$seen$key "
  case "$value" in ''|*[!0-9.]*|.*|*.|*..*) fail "Invalid version for $key" ;; esac
  count_parts() { oldifs=$IFS; IFS=.; set -- $1; IFS=$oldifs; [ "$#" -eq 3 ]; }
  count_parts "$value" || fail "Invalid version for $key"
  case "$key" in NODE_VERSION) pinned_node_version=$value ;; esac
done < "$root/toolchains.env"
for key in NODE_VERSION NPM_VERSION ZCODE_APP_MIN_VERSION; do
  case "$seen" in *" $key "*) ;; *) fail "Missing toolchain key: $key" ;; esac
done
node_bin=${NVM_DIR:-$HOME/.nvm}/versions/node/v$pinned_node_version/bin/node
[ -x "$node_bin" ] || fail "Node $pinned_node_version is missing at $node_bin. Install explicitly: nvm install $pinned_node_version"
actual=$("$node_bin" -p 'process.versions.node') || fail "Cannot inspect $node_bin"
[ "$actual" = "$pinned_node_version" ] || fail "Expected Node $pinned_node_version; actual $actual at $node_bin"
export PATH="$root/scripts/tool-bin:$(dirname "$node_bin"):$PATH"
case "$command_name" in
  run) exec "$node_bin" "$root/bin/herdr-zcode-app.mjs" "$@" ;;
  node) exec "$node_bin" "$@" ;;
esac
exec "$node_bin" "$root/scripts/dev.mjs" "$command_name" "$@"
