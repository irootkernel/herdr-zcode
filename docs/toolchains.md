# Toolchain management

`toolchains.env` pins the CLI and development versions of Node and npm and declares the minimum version of ZCode Desktop. Use three numeric components for each declaration. `package.json`'s `engines.node` describes package compatibility. The launcher selects Node using `NODE_VERSION`. The project uses Node.js standard libraries and has no dependency lockfile.

## Prepare and inspect

Install nvm separately using its official instructions. Run `./dev setup` from the checkout. If Node is missing, run the exact `nvm install` command printed by setup, then repeat setup. Only setup downloads tools. It obtains the exact npm archive from the official registry, verifies its SHA-512 integrity, and stores an integrity receipt with the installation. It never upgrades global npm or changes shell startup files.

The Node location is `${NVM_DIR:-$HOME/.nvm}/versions/node/v<declared-version>/bin/node`. npm lives in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-zcode/toolchains/node-<version>/npm-<version>`. `HERDR_ZCODE_TOOLCHAIN_CACHE` can select a different cache root. Normal execution only reads prepared tools and fails if they are missing or mismatched. The CLI itself needs pinned Node; npm commands additionally need the prepared npm cache.

`./dev doctor` reports declared versions, actual versions, and executable paths. `./dev doctor --desktop` also inspects the app at `HERDR_ZCODE_APP_BUNDLE` or `/Applications/ZCode.app`. The CLI accepts `--app-bundle` as well. Apps at or above `ZCODE_APP_MIN_VERSION` pass the version check. Doctor reports the actual app build and embedded Node and Electron versions for diagnosis. The probe checks the executable and runs without accessing credentials or starting a model session.

## Commands

| Command | Purpose |
| --- | --- |
| `./dev help` | Show commands without requiring tools to be installed |
| `./dev setup` | Prepare exact npm after Node has been installed |
| `./dev doctor [--desktop]` | Inspect and validate tools |
| `./dev run [arguments]` | Run the CLI using pinned Node |
| `./dev test` | Run the offline suite with pinned Node/npm |
| `./dev pack` | Create a tgz in `dist/`, including the launcher and version policy |
| `./dev install [--prefix path]` | Install a standalone package copy; default prefix is `~/.local` |
| `./dev node [arguments]` | Invoke pinned Node directly |
| `./dev npm [arguments]` | Invoke pinned npm directly |

`./dev npm run test:live-account`, `test:live-reporter`, and `test:live-herdr -- --scenario basic` are explicit integration checks. They are never part of setup, doctor, or offline tests. Live account/model checks can consume usage.

The `test` and live test scripts check actual Node/npm versions in the command body, including when the user's npm configuration disables lifecycle hooks. `./dev pack` validates npm and enables its local prepack guard. Raw npm with lifecycle hooks disabled can bypass prepack; use the project pack command. The direct JavaScript CLI entry checks Node as well. The installed shell launcher selects its own package's policy, independently of the current directory and `--cwd`.

## Explicit upgrades

1. Edit the relevant values in `toolchains.env` when changing the pinned development tools. When adapting to a new ZCode Desktop release, set `ZCODE_APP_MIN_VERSION` to the release verified with that adapter. Newer releases can run the same compatibility checks. The embedded Node and Electron runtimes ship with ZCode Desktop.
2. Run `./dev setup` for development tool upgrades. Install the exact Node version printed by setup through nvm if needed.
3. Run `./dev doctor --desktop`, `./dev test`, and `./dev pack` to check the selected tools and package.
4. Reinstall a standalone copy explicitly with `./dev install` when ready. Updating a checkout does not update an installed copy or published release assets.

Test-owned scratch roots should be unique directories under `/tmp`, passed through `TEST_TMP_ROOT`. System Node, global npm, and shell defaults are not project version declarations. TypeScript, Bun, Deno, Go, Python, Rust, and Ruby are not used by the current repository's development or release entrypoints.
