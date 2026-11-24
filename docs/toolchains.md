# Toolchain management

`toolchains.env` pins the development versions of Node and npm and declares the minimum version of ZCode Desktop. Use three numeric components for each declaration. `package.json`'s `engines.node` describes package compatibility. The project uses Node.js standard libraries and has no dependency lockfile.

## Prepare and inspect

Install nvm separately using its official instructions. Run `./dev setup` from the checkout. If Node is missing, run the exact `nvm install` command printed by setup, then repeat setup. Only setup downloads tools. It obtains the exact npm archive from the official registry, verifies its SHA-512 integrity, and stores an integrity receipt with the installation. It never upgrades global npm or changes shell startup files.

The nvm Node location is `${NVM_DIR:-$HOME/.nvm}/versions/node/v<declared-version>/bin/node`. npm lives in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-zcode/toolchains/node-<version>/npm-<version>`. `HERDR_ZCODE_TOOLCHAIN_CACHE` can select a different cache root. `./dev` enforces the Node pin, and its npm commands also require the prepared npm cache.

The installed `herdr-zcode` checks the same nvm location first. If that executable is absent, it runs the selected ZCode Desktop binary in Electron Node mode with Node 20 or newer. `--app-bundle` takes precedence over `HERDR_ZCODE_APP_BUNDLE`, which defaults to `/Applications/ZCode.app`. The Electron fallback clears `NODE_OPTIONS` and `NODE_PATH` and works with an empty `HOME` and no `NVM_DIR`. The launcher never searches `PATH` for Node.

`./dev doctor` reports declared versions, actual versions, and executable paths. `./dev doctor --desktop` and `herdr-zcode --check-desktop --json` share the same bundle checks. They validate the plist, executable, app-server entry, and bundled Coding Plan catalog, check `ZCODE_APP_MIN_VERSION`, and probe the embedded Node and Electron versions without accessing credentials or starting a model session. The standalone check accepts `--app-bundle <path>` and uses `HERDR_ZCODE_APP_BUNDLE` or `/Applications/ZCode.app` when the flag is omitted.

Use the standalone check by itself. Success exits `0` and returns `compatible: true` with the app version, build, declared minimum, resolved bundle path, and runtime versions. Failure exits `1` and returns `compatible: false`, `reason`, a safe `message`, `appVersion` (the observed version or `null`), `minZcodeAppVersion`, and the resolved `appBundle`. The order is `app_bundle_missing`, `app_bundle_invalid`, `app_version_below_minimum`, `embedded_runtime_invalid`. A usage error reports `invalid_arguments`. If the embedded runtime cannot start, the installed launcher classifies what it can check without it.

The `0.2.0` package advertises `core`, `osc7501`, `catalogFile`, `prepareIsolated`, and `checkDesktop` in `--version --json`. The standalone diagnostic and preparation commands include `scripts/desktop-bootstrap.pl` in the installed runtime. For an installed-candidate check, pack the exact committed source and install the tarball into a disposable prefix. Compare installed files with the archive and record the candidate commit, version, and archive digest. Include the launcher, toolchain scripts, bootstrap helper, and runtime modules in the file list used for package fingerprinting.

Installed `prepare-isolated` uses the selected Desktop bundle's embedded runtime even when a pinned nvm Node is available. It takes the bundle from `--app-bundle` or `/Applications/ZCode.app` and ignores `HERDR_ZCODE_APP_BUNDLE`.

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

`./dev npm run test:live-account`, `test:live-reporter`, `test:live-herdr -- --scenario basic`, and `test:live-herdr-core` are explicit integration checks. They are never part of setup, doctor, or offline tests. Live account/model checks can consume usage. See the [live Core prerequisites](app-server.md#live-herdr-core-certification) for Desktop authentication, the credential override, and the installed-candidate option.

The `test` and live test scripts check actual Node/npm versions in the command body, including when the user's npm configuration disables lifecycle hooks. `./dev pack` validates npm and enables its local prepack guard. Raw npm with lifecycle hooks disabled can bypass prepack; use the project pack command. The direct JavaScript CLI entry checks Node as well. The installed shell launcher selects its own package's policy, independently of the current directory and `--cwd`.

To smoke-test the installed fallback, use a disposable installation prefix and an empty `HOME`. Run the absolute installed launcher under `env -i HOME=<empty-directory> PATH=/usr/bin:/bin` with `--version`, `--version --json`, and `--help`. These metadata checks need ZCode Desktop and do not open an account session.

## Explicit upgrades

1. Edit the relevant values in `toolchains.env` when changing the pinned development tools. When adapting to a new ZCode Desktop release, set `ZCODE_APP_MIN_VERSION` to the release verified with that adapter. Newer releases can run the same compatibility checks. The embedded Node and Electron runtimes ship with ZCode Desktop.
2. Run `./dev setup` for development tool upgrades. Install the exact Node version printed by setup through nvm if needed.
3. Run `./dev doctor --desktop`, `./dev test`, and `./dev pack` to check the selected tools and package.
4. Reinstall a standalone copy explicitly with `./dev install` when ready. Updating a checkout does not update an installed copy or published release assets.

Test-owned scratch roots should be unique directories under `/tmp`, passed through `TEST_TMP_ROOT`. System Node, global npm, and shell defaults are not project version declarations. TypeScript, Bun, Deno, Go, Python, Rust, and Ruby are not used by the current repository's development or release entrypoints.
