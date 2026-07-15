import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputRoot = path.resolve(process.env.LADYBUG_OUTPUT_ROOT ?? path.join(repositoryRoot, 'dist'))
const manifest = JSON.parse(readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'))

verifyFile(manifest.artifact, manifest.target.startsWith('win32-'))
for (const file of Object.values(manifest.dictionary.files)) verifyFile(file, false)

process.stdout.write(
  `[ladybug-native] verified ${manifest.target} (${manifest.artifact.sha256}, ${manifest.artifact.size} bytes)\n`
)

function verifyFile(description, requirePeMagic) {
  const absolutePath = path.join(outputRoot, description.path)
  const contents = readFileSync(absolutePath)
  const sha256 = createHash('sha256').update(contents).digest('hex')
  if (sha256 !== description.sha256) {
    throw new Error(`Checksum mismatch for ${description.path}: ${sha256}`)
  }
  if (statSync(absolutePath).size !== description.size) {
    throw new Error(`Size mismatch for ${description.path}`)
  }
  if (requirePeMagic && (contents[0] !== 0x4d || contents[1] !== 0x5a)) {
    throw new Error(`${description.path} is not a Windows PE file`)
  }
}
