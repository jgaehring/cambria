// A CLI document conversion tool for cloudina

import { program } from 'commander'
import { readFileSync } from 'fs'
import YAML from 'js-yaml'
import { LensSource, LensOp } from './lens-ops'
import { reverseLens } from './reverse'
import { applyLensToDoc } from './patch'
import { quicktype, InputData, jsonInputForTargetLanguage } from 'quicktype-core'
import { JSONSchema7 } from 'json-schema'
import { inspect } from 'util'

interface YAMLLens {
  lens: LensSource
}

async function quicktypeJSON(targetLanguage, typeName, jsonString) {
  const jsonInput = jsonInputForTargetLanguage(targetLanguage)

  // We could add multiple samples for the same desired
  // type, or many sources for other types. Here we're
  // just making one type from one piece of sample JSON.
  await jsonInput.addSource({
    name: typeName,
    samples: [jsonString],
  })

  const inputData = new InputData()
  inputData.addInput(jsonInput)

  return await quicktype({
    inputData,
    lang: targetLanguage,
  })
}

// copied from migrationRunner.ts; should probably migrate into cloudina
const foldInOp = (lensOpJson): LensOp => {
  const opName = Object.keys(lensOpJson)[0]

  // the json format is
  // {"<opName>": {opArgs}}
  // and the internal format is
  // {op: <opName>, ...opArgs}
  const data = lensOpJson[opName]
  if (['in', 'map'].includes(opName)) {
    data.lens = data.lens.map((lensOp) => foldInOp(lensOp))
  }

  const op = { op: opName, ...data }
  return op
}

const generateSchema = async (doc): Promise<JSONSchema7> => {
  const { lines: jsonSchemaLines } = await quicktypeJSON(
    'json-schema',
    'Input',
    JSON.stringify(doc)
  )
  const jsonSchemaString = jsonSchemaLines.join('\n')
  return JSON.parse(jsonSchemaString)
}

async function main() {
  program
    .requiredOption('-l, --lens <filename>', 'lens source as yaml')
    .option('-i, --input <filename>', 'input document filename')
    .option('-s, --schema <schema>', 'json schema for input document')
    .option('-b, --base <filename>', 'base document filename')
    .option('-r, --reverse', 'run the lens in reverse')

  program.parse(process.argv)

  // read doc from stdin if no input specified
  const input = readFileSync(program.input || 0, 'utf-8')
  const baseDoc = program.base ? JSON.parse(readFileSync(program.base, 'utf-8')) : {}
  const doc = JSON.parse(input)
  const rawLens = YAML.safeLoad(readFileSync(program.lens, 'utf-8')) as YAMLLens

  if (!rawLens || typeof rawLens !== 'object') throw new Error('Error loading lens')
  if (!('lens' in rawLens)) throw new Error(`Expected top-level key 'lens' in YAML lens file`)

  // we could have a root op to make this consistent...
  let lens = (rawLens.lens as LensSource)
    .filter((o) => o !== null)
    .map((lensOpJson) => foldInOp(lensOpJson))
  if (program.reverse) {
    lens = reverseLens(lens)
  }

  // TODO: need to actually use an input schema here --
  // either 1) take it as an arg, 2) generate it from the data
  const inputSchema = program.schema || (await generateSchema(doc))

  console.log('input schema', inspect(inputSchema, false, 10, true))

  const newDoc = applyLensToDoc(lens, doc, inputSchema, baseDoc)

  console.log(JSON.stringify(newDoc, null, 4))
}

main()
