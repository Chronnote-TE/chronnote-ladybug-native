import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LADYBUG_VERSION = '0.18.1'
const LADYBUG_TAG = `v${LADYBUG_VERSION}`
const LADYBUG_COMMIT = '1354081eb5528b3ca12e38dd4402cdd47215e57a'
const NODE_API_COMMIT = '1356ebbad75bf69c152dfe1188fad285b5f85b6e'
const EXTENSIONS_COMMIT = '7d7f90fdbb562965407e7c29a8ae5312d09b5812'
const PATCH_VERSION = 4

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workRoot = path.resolve(
  process.env.LADYBUG_WORK_ROOT ?? path.join(repositoryRoot, '.cache', 'ladybug-work')
)
const outputRoot = path.resolve(process.env.LADYBUG_OUTPUT_ROOT ?? path.join(repositoryRoot, 'dist'))
const ladybugRoot = path.join(workRoot, 'ladybug')
const extensionsRoot = path.join(workRoot, 'extensions')
const nodeApiRoot = path.join(workRoot, 'node-api')
const buildArch = process.env.LADYBUG_TARGET_ARCH ?? process.arch
const target = getTarget(process.platform, buildArch)

mkdirSync(workRoot, { recursive: true })
prepareLadybug()
prepareExtensions()
prepareNodeApi()
assembleSourceTree()
installNodeApiDependencies()
configureAndBuild()
stageBundle()

process.stdout.write(`[ladybug-native] built ${target} in ${outputRoot}\n`)

function prepareLadybug() {
  if (!existsSync(path.join(ladybugRoot, '.git'))) {
    run('git', [
      '-c',
      'core.autocrlf=false',
      'clone',
      '--depth=1',
      '--branch',
      LADYBUG_TAG,
      '--filter=blob:none',
      'https://github.com/LadybugDB/ladybug.git',
      ladybugRoot
    ])
  }
  resetCheckout(ladybugRoot, LADYBUG_COMMIT)
}

function prepareExtensions() {
  if (!existsSync(path.join(extensionsRoot, '.git'))) {
    run('git', [
      '-c',
      'core.autocrlf=false',
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      'https://github.com/LadybugDB/extensions.git',
      extensionsRoot
    ])
    run('git', ['sparse-checkout', 'init', '--cone'], { cwd: extensionsRoot })
    run('git', ['sparse-checkout', 'set', 'fts'], { cwd: extensionsRoot })
  }
  checkoutCommit(extensionsRoot, EXTENSIONS_COMMIT)
}

function prepareNodeApi() {
  if (!existsSync(path.join(nodeApiRoot, '.git'))) {
    run('git', [
      '-c',
      'core.autocrlf=false',
      'clone',
      '--filter=blob:none',
      'https://github.com/LadybugDB/ladybug-nodejs.git',
      nodeApiRoot
    ])
  }
  checkoutCommit(nodeApiRoot, NODE_API_COMMIT)
}

function resetCheckout(directory, expectedCommit) {
  run('git', ['reset', '--hard', expectedCommit], { cwd: directory })
  const actualCommit = capture('git', ['rev-parse', 'HEAD'], { cwd: directory })
  if (actualCommit !== expectedCommit) {
    throw new Error(`Unexpected checkout in ${directory}: ${actualCommit}`)
  }
}

function checkoutCommit(directory, commit) {
  run('git', ['checkout', '--detach', commit], { cwd: directory })
  resetCheckout(directory, commit)
}

function assembleSourceTree() {
  const extensionTarget = path.join(ladybugRoot, 'extension')
  rmSync(extensionTarget, { recursive: true, force: true })
  mkdirSync(extensionTarget, { recursive: true })
  cpSync(path.join(extensionsRoot, 'CMakeLists.txt'), path.join(extensionTarget, 'CMakeLists.txt'), {
    preserveTimestamps: true
  })
  cpSync(
    path.join(extensionsRoot, 'extension_config.cmake'),
    path.join(extensionTarget, 'extension_config.cmake'),
    { preserveTimestamps: true }
  )
  cpSync(path.join(extensionsRoot, 'fts'), path.join(extensionTarget, 'fts'), {
    preserveTimestamps: true,
    recursive: true
  })

  const nodeApiTarget = path.join(ladybugRoot, 'tools', 'nodejs_api')
  rmSync(nodeApiTarget, { recursive: true, force: true })
  cpSync(nodeApiRoot, nodeApiTarget, { preserveTimestamps: true, recursive: true })
  rmSync(path.join(nodeApiTarget, '.git'), { recursive: true, force: true })

  run(
    'git',
    ['apply', path.join(repositoryRoot, 'patches', '0001-chronnote-runtime.patch')],
    { cwd: ladybugRoot }
  )
}

function installNodeApiDependencies() {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], {
    cwd: path.join(ladybugRoot, 'tools', 'nodejs_api'),
    shell: process.platform === 'win32'
  })
}

function configureAndBuild() {
  const buildRoot = path.join(ladybugRoot, 'build', 'chronnote-node')
  const cmakeArgs = [
    '-S',
    ladybugRoot,
    '-B',
    buildRoot,
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DOPENSSL_USE_STATIC_LIBS=TRUE',
    '-DBUILD_NODEJS=TRUE',
    '-DBUILD_SHELL=FALSE',
    '-DBUILD_SHARED_LBUG=FALSE',
    '-DBUILD_SINGLE_FILE_HEADER=FALSE',
    '-DBUILD_TESTS=FALSE',
    '-DBUILD_EXTENSION_TESTS=FALSE',
    '-DAUTO_UPDATE_GRAMMAR=FALSE',
    '-DEXTENSION_STATIC_LINK_LIST=fts'
  ]
  appendCmakePath(cmakeArgs, 'CMAKE_PREFIX_PATH')
  appendCmakePath(cmakeArgs, 'OPENSSL_ROOT_DIR')
  appendCmakePath(cmakeArgs, 'CMAKE_TOOLCHAIN_FILE')
  appendCmakePath(cmakeArgs, 'VCPKG_TARGET_TRIPLET')
  if (process.platform === 'darwin' && buildArch !== process.arch) {
    cmakeArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${buildArch === 'x64' ? 'x86_64' : buildArch}`)
  }

  run(process.env.CMAKE ?? 'cmake', cmakeArgs)
  run(process.env.CMAKE ?? 'cmake', [
    '--build',
    buildRoot,
    '--target',
    'lbugjs',
    '--parallel',
    process.env.LADYBUG_BUILD_JOBS ?? '2'
  ])
}

function appendCmakePath(args, name) {
  if (process.env[name]) args.push(`-D${name}=${process.env[name]}`)
}

function stageBundle() {
  const nodeApiBuild = path.join(ladybugRoot, 'tools', 'nodejs_api', 'build')
  const nativeFile = path.join(nodeApiBuild, 'lbugjs.node')
  if (!existsSync(nativeFile)) throw new Error(`Built native module is missing: ${nativeFile}`)

  rmSync(outputRoot, { recursive: true, force: true })
  const artifactRoot = path.join(outputRoot, target)
  const runtimeRoot = path.join(outputRoot, 'runtime')
  const dictionaryRoot = path.join(outputRoot, 'dict')
  mkdirSync(artifactRoot, { recursive: true })
  mkdirSync(runtimeRoot, { recursive: true })

  cpSync(nativeFile, path.join(artifactRoot, 'lbugjs.node'))
  for (const fileName of [
    'connection.js',
    'database.js',
    'index.js',
    'index.mjs',
    'lbug.d.ts',
    'lbug_native.js',
    'prepared_statement.js',
    'query_result.js'
  ]) {
    cpSync(path.join(nodeApiBuild, fileName), path.join(runtimeRoot, fileName))
  }
  cpSync(nativeFile, path.join(runtimeRoot, 'lbugjs.node'))
  cpSync(path.join(ladybugRoot, 'third_party', 'cppjieba', 'dict'), dictionaryRoot, {
    recursive: true
  })

  const manifest = {
    schemaVersion: 1,
    ladybugVersion: LADYBUG_VERSION,
    ladybugCommit: LADYBUG_COMMIT,
    nodeApiCommit: NODE_API_COMMIT,
    extensionsCommit: EXTENSIONS_COMMIT,
    patchVersion: PATCH_VERSION,
    target,
    artifact: describeFile(path.join(target, 'lbugjs.node')),
    dictionary: {
      source: 'cppjieba',
      files: Object.fromEntries(
        ['hmm_model.utf8', 'idf.utf8', 'jieba.dict.utf8', 'stop_words.utf8', 'user.dict.utf8'].map(
          (fileName) => [fileName, describeFile(path.join('dict', fileName))]
        )
      )
    }
  }
  writeFileSync(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function describeFile(relativePath) {
  const absolutePath = path.join(outputRoot, relativePath)
  const contents = readFileSync(absolutePath)
  return {
    path: relativePath.replaceAll(path.sep, '/'),
    sha256: createHash('sha256').update(contents).digest('hex'),
    size: statSync(absolutePath).size
  }
}

function getTarget(platform, arch) {
  const value = `${platform}-${arch}`
  const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  if (!supported.has(value)) throw new Error(`Unsupported target: ${value}`)
  return value
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    shell: options.shell ?? false
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: process.env,
    shell: options.shell ?? false,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`)
}
