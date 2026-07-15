'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.resolve(
  process.env.LADYBUG_RUNTIME_ROOT || path.join(repositoryRoot, 'dist', 'runtime')
)
const dictionaryPath = path.resolve(
  process.env.LADYBUG_DICTIONARY_ROOT || path.join(repositoryRoot, 'dist', 'dict')
)
const { Connection, Database } = require(runtimeRoot)

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'chronnote-ladybug-smoke-'))
const databasePath = path.join(temporaryRoot, 'graph')
let database
let connection

try {
  ;({ database, connection } = openDatabase())
  query('CREATE NODE TABLE Doc(id STRING, text STRING, PRIMARY KEY(id))')
  query("CREATE (:Doc {id: 'updated', text: '宋朝开国皇帝赵匡胤'})")
  query("CREATE (:Doc {id: 'deleted', text: '待删除的清朝历史'})")
  query(
    `CALL CREATE_FTS_INDEX('Doc', 'doc_text', ['text'], stemmer := 'none', stopWords := 'default', tokenizer := 'jieba', jieba_dict_dir := ${quote(dictionaryPath)})`
  )
  query('CHECKPOINT')

  query("MATCH (doc:Doc {id: 'updated'}) SET doc.text = '唐朝开国皇帝李渊'")
  query("CREATE (:Doc {id: 'inserted', text: '新增知识图谱查询能力'})")
  query("MATCH (doc:Doc {id: 'deleted'}) DELETE doc")
  assert.deepEqual(search('唐朝李渊'), ['updated'])
  assert.deepEqual(search('知识图谱'), ['inserted'])
  assert.deepEqual(search('清朝'), [])
  closeDatabase()

  assert.ok(statSync(`${databasePath}.wal`).size > 0)
  ;({ database, connection } = openDatabase())
  assert.deepEqual(search('宋朝'), [])
  assert.deepEqual(search('唐朝李渊'), ['updated'])
  assert.deepEqual(search('知识图谱'), ['inserted'])
  assert.deepEqual(search('清朝'), [])

  query("MATCH (doc:Doc {id: 'updated'}) SET doc.text = '明朝开国皇帝朱元璋'")
  closeDatabase()
  ;({ database, connection } = openDatabase())
  assert.deepEqual(search('唐朝'), [])
  assert.deepEqual(search('明朝朱元璋'), ['updated'])
  process.stdout.write('[ladybug-native] Jieba FTS and WAL recovery smoke test passed\n')
} finally {
  connection?.closeSync()
  database?.closeSync()
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function openDatabase() {
  const nextDatabase = new Database(databasePath)
  return { database: nextDatabase, connection: new Connection(nextDatabase) }
}

function closeDatabase() {
  connection?.closeSync()
  database?.closeSync()
  connection = undefined
  database = undefined
}

function query(statement) {
  const result = connection.querySync(statement)
  if (Array.isArray(result)) throw new Error('LadybugDB returned multiple query results')
  return result.getAllSync()
}

function search(value) {
  return query(
    `CALL QUERY_FTS_INDEX('Doc', 'doc_text', ${quote(value)}, conjunctive := true) RETURN node.id AS id ORDER BY id`
  ).map((row) => String(row.id))
}

function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
