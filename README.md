# Chronnote Ladybug Native

Reproducible native builds of LadybugDB for Chronnote. The repository contains only build
recipes, patches, and smoke tests for public upstream projects.

## Windows x64

The `Build Windows x64` workflow builds a statically linked LadybugDB Node-API module with the
FTS extension and cppjieba tokenizer, then verifies it in both Node.js and Electron.

Pinned inputs:

- LadybugDB `v0.18.1`
- LadybugDB Extensions commit `7d7f90fdbb562965407e7c29a8ae5312d09b5812`
- LadybugDB Node.js API commit `1356ebbad75bf69c152dfe1188fad285b5f85b6e`
- Electron `41.0.2`

The uploaded bundle contains `lbugjs.node`, the cppjieba dictionaries, a manifest with SHA-256
checksums, and the upstream JavaScript runtime needed by the smoke test.

## Local build

Use a Visual Studio x64 developer shell with CMake, Ninja, Node.js 24, and a static OpenSSL 3
installation available to CMake:

```powershell
npm ci
$env:CMAKE_PREFIX_PATH = 'C:\vcpkg\installed\x64-windows-static-md'
$env:OPENSSL_ROOT_DIR = $env:CMAKE_PREFIX_PATH
npm run build:native
npm run smoke:native
npm run verify
```

Build outputs are written to `dist/`. The persistent `.cache/ladybug-work` directory keeps CMake
objects for fast incremental retries.

## Licenses

The build orchestration in this repository is MIT licensed. Produced bundles contain code from
LadybugDB, cppjieba, OpenSSL, and their transitive dependencies under their respective licenses.
