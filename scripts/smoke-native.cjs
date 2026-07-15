'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, statSync, writeSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.resolve(
  process.env.LADYBUG_RUNTIME_ROOT || path.join(repositoryRoot, 'dist', 'runtime')
)
const dictionaryPath = path.resolve(
  process.env.LADYBUG_DICTIONARY_ROOT || path.join(repositoryRoot, 'dist', 'dict')
)
const phase = process.argv[2]
const databasePath = process.argv[3]

if (phase) {
  runWorker(phase, databasePath)
} else {
  runOrchestrator()
}

function runOrchestrator() {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'chronnote-ladybug-smoke-'))
  const targetDatabase = path.join(temporaryRoot, 'graph')
  try {
    runCrashPhase('seed', targetDatabase)
    assert.ok(statSync(`${targetDatabase}.wal`).size > 0)
    runCrashPhase('recover-update', targetDatabase)
    runCleanPhase('recover-final', targetDatabase)
    process.stdout.write('[ladybug-native] Jieba FTS and WAL crash recovery smoke test passed\n')
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function runCrashPhase(nextPhase, targetDatabase) {
  const result = runPhase(nextPhase, targetDatabase)
  const marker = `__LADYBUG_CRASH_READY__:${nextPhase}`
  if (!result.stdout.includes(marker)) {
    throw new Error(formatChildFailure(nextPhase, result))
  }
  if (result.status === 0 && !result.signal) {
    throw new Error(`Crash phase ${nextPhase} exited cleanly instead of simulating a crash`)
  }
}

function runCleanPhase(nextPhase, targetDatabase) {
  const result = runPhase(nextPhase, targetDatabase)
  if (result.status !== 0) throw new Error(formatChildFailure(nextPhase, result))
}

function runPhase(nextPhase, targetDatabase) {
  return spawnSync(process.execPath, [__filename, nextPhase, targetDatabase], {
    encoding: 'utf8',
    env: process.env,
    timeout: 60_000
  })
}

function formatChildFailure(nextPhase, result) {
  return [
    `Ladybug smoke phase ${nextPhase} failed`,
    `status=${String(result.status)} signal=${String(result.signal)}`,
    result.stdout,
    result.stderr,
    result.error?.stack
  ]
    .filter(Boolean)
    .join('\n')
}

function runWorker(nextPhase, targetDatabase) {
  const { Connection, Database } = require(runtimeRoot)
  const database = new Database(targetDatabase)
  const connection = new Connection(database)
  try {
    if (nextPhase === 'seed') {
      seed(connection)
    } else if (nextPhase === 'recover-update') {
      verifyFirstRecovery(connection)
    } else if (nextPhase === 'recover-final') {
      verifyFinalRecovery(connection)
    } else {
      throw new Error(`Unknown smoke phase: ${nextPhase}`)
    }
  } finally {
    if (nextPhase === 'recover-final') {
      connection.closeSync()
      database.closeSync()
    }
  }

  if (nextPhase !== 'recover-final') {
    const marker = `__LADYBUG_CRASH_READY__:${nextPhase}\n`
    writeSync(1, marker)
    process.kill(process.pid, 'SIGKILL')
  }
}

function seed(connection) {
  query(connection, 'CREATE NODE TABLE Doc(id STRING, text STRING, PRIMARY KEY(id))')
  query(connection, "CREATE (:Doc {id: 'updated', text: '宋朝开国皇帝赵匡胤'})")
  query(connection, "CREATE (:Doc {id: 'deleted', text: '待删除的清朝历史'})")
  query(
    connection,
    `CALL CREATE_FTS_INDEX('Doc', 'doc_text', ['text'], stemmer := 'none', stopWords := 'default', tokenizer := 'jieba', jieba_dict_dir := ${quote(dictionaryPath)})`
  )
  query(connection, 'CHECKPOINT')

  query(connection, "MATCH (doc:Doc {id: 'updated'}) SET doc.text = '唐朝开国皇帝李渊'")
  query(connection, "CREATE (:Doc {id: 'inserted', text: '新增知识图谱查询能力'})")
  query(connection, "MATCH (doc:Doc {id: 'deleted'}) DELETE doc")
  assert.deepEqual(search(connection, '唐朝李渊'), ['updated'])
  assert.deepEqual(search(connection, '知识图谱'), ['inserted'])
  assert.deepEqual(search(connection, '清朝'), [])
}

function verifyFirstRecovery(connection) {
  assert.deepEqual(search(connection, '宋朝'), [])
  assert.deepEqual(search(connection, '唐朝李渊'), ['updated'])
  assert.deepEqual(search(connection, '知识图谱'), ['inserted'])
  assert.deepEqual(search(connection, '清朝'), [])
  query(connection, "MATCH (doc:Doc {id: 'updated'}) SET doc.text = '明朝开国皇帝朱元璋'")
  assert.deepEqual(search(connection, '明朝朱元璋'), ['updated'])
}

function verifyFinalRecovery(connection) {
  assert.deepEqual(search(connection, '唐朝'), [])
  assert.deepEqual(search(connection, '明朝朱元璋'), ['updated'])
  assert.deepEqual(search(connection, '知识图谱'), ['inserted'])
  assert.deepEqual(search(connection, '清朝'), [])
}

function query(connection, statement) {
  const result = connection.querySync(statement)
  if (Array.isArray(result)) {
    for (const item of result) item.close()
    throw new Error('LadybugDB returned multiple query results')
  }
  try {
    return result.getAllSync()
  } finally {
    result.close()
  }
}

function search(connection, value) {
  return query(
    connection,
    `CALL QUERY_FTS_INDEX('Doc', 'doc_text', ${quote(value)}, conjunctive := true) RETURN node.id AS id ORDER BY id`
  ).map((row) => String(row.id))
}

function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
