#!/usr/bin/env node

const path = require('path')
const fs = require('fs')
const yaml = require('yaml')
const jsonschema = require('jsonschema')
const forge = require('node-forge')
// Import compiled modules
const { Lexer, Parser } = require('@scratch-fuse/core')
const {
  Context,
  Scope,
  flattenFunctions,
  flattenVariables,
  mergeModule
} = require('@scratch-fuse/compiler')
const {
  uid,
  serializeScript,
  serializeFunction,
  mergeWorkspaces
} = require('@scratch-fuse/serializer')
const Builtins = require('@scratch-fuse/builtins')

const jszip = require('jszip')

if (process.argv.length < 3) {
  console.error('Usage: node fuse.js <input-file> <output-file>')
  process.exit(1)
}

const inputPath = process.argv[2]
const outputPath = process.argv[3]

const inputDir = path.dirname(inputPath)
const inputJson = yaml.parse(fs.readFileSync(inputPath, 'utf-8'))
const schema = {
  id: '/Sb3Project',
  type: 'object',
  properties: {
    types: {
      type: 'array',
      items: { type: 'string' }
    },
    root: {
      type: 'string'
    },
    extensions: {
      type: 'array',
      items: { type: 'string' }
    },
    stage: {
      type: 'object',
      properties: {
        currentBackdrop: { type: 'number' },
        tempo: { type: 'number' },
        volume: { type: 'number' },
        backdrops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              name: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' }
            }
          }
        },
        sounds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              name: { type: 'string' }
            }
          }
        },
        entry: { type: 'string' }
      }
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          currentCostume: { type: 'number' },
          rotationStyle: { type: 'string' },
          layerOrder: { type: 'number' },
          visible: { type: 'boolean' },
          x: { type: 'number' },
          y: { type: 'number' },
          size: { type: 'number' },
          direction: { type: 'number' },
          draggable: { type: 'boolean' },
          tempo: { type: 'number' },
          volume: { type: 'number' },
          costumes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                name: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' }
              }
            }
          },
          sounds: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                name: { type: 'string' }
              }
            }
          },
          entry: { type: 'string' }
        },
        required: ['name']
      }
    }
  },
  required: ['stage', 'targets']
}

function md5Bytes(data) {
  const md = forge.md.md5.create()
  md.update(data)
  return md.digest().toHex()
}

// 空 SVG 资源
const EMPTY_SVG =
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1" height="1"><rect width="1" height="1" fill="transparent"/></svg>'

const validator = new jsonschema.Validator()

const validationResult = validator.validate(inputJson, schema)

if (!validationResult.valid) {
  console.error('Input JSON does not conform to schema:')
  validationResult.errors.forEach(error => {
    console.error(`- ${error.stack}`)
  })
  process.exit(1)
}

const root = inputJson.root ? path.resolve(inputJson.root) : path.resolve('/')

/**
 *
 * @param {Map<string, ModuleInfo>} base
 * @param {Map<string, ModuleInfo>} upper
 */
function mergeModules(base, upper) {
  const merged = new Map(base)
  for (const [name, module] of upper.entries()) {
    if (merged.has(name)) {
      const existing = merged.get(name)
      mergeModule(existing, module, 0, 0)
    } else {
      merged.set(name, module)
    }
  }
  return merged
}

async function processTypes(paths) {
  /**
   * @type {Map<string, import('@scratch-fuse/compiler').ModuleInfo>}
   */
  let modules = new Map(Builtins.Sb3Modules)
  for (const typePath of paths) {
    const fullPath = path.isAbsolute(typePath)
      ? typePath
      : path.join(inputDir, typePath)
    try {
      const typeFuse = fs.readFileSync(fullPath, 'utf-8')
      const lexer = new Lexer(typeFuse)
      const parser = new Parser(lexer)
      const ast = parser.parse()

      /** @type {import('@scratch-fuse/compiler').ModuleInfo} */
      const module = {
        name: '',
        parent: null,
        functions: new Map(),
        variables: new Map(),
        externs: new Map(),
        children: modules
      }

      const context = new Context(module, {
        importResolver: {
          resolve: importResolver
        }
      })
      await context.compile(ast)
      // modules = mergeModules(modules, result.modules)
    } catch (error) {
      console.error(`Error compiling type file: ${fullPath}`)
      throw error
    }
  }
  return modules
}

// function processVariable(variable) {
//   const scratchId = uid()
//   return {
//     [scratchId]: [
//       variable.exportName ?? variable.name,
//       variable.type === 'list' ? [] : 0
//     ]
//   }
// }
// /**
//  *
//  * @param {Map<string, import('../dist/index.d.ts').Variable>} variableMap
//  * @returns {Record<string, [string, string | number | boolean | (string | number | boolean)[]]>}
//  */
// function processVariables(variableMap) {
//   const processed = {}
//   for (const [, [variable, defaultValue]] of variableMap) {
//     Object.assign(processed, processVariable(variable))
//   }
//   return processed
// }

/**
 *
 * @param {string} importPath
 * @param {string} currentFile
 * @return {Promise<Promise<import('@scratch-fuse/core').Program>}
 */
async function importResolver(importPath, currentFile) {
  // First detect if it starts with ./ or ../, if true use relative path
  // Next check if it's absolute path, if yes, first check root/${importPath}, then check importPath directly
  // Finally, throw error if not found
  const relPathRegex = /^\.{1,2}\//
  const absPathRegex = /^\//

  let resolvedPath = null

  if (relPathRegex.test(importPath)) {
    resolvedPath = path.resolve(path.dirname(currentFile), importPath)
    if (fs.existsSync(resolvedPath)) {
      const source = fs.readFileSync(resolvedPath, 'utf-8')
      const lexer = new Lexer(source)
      const parser = new Parser(lexer)
      return parser.parse()
    }
  } else if (absPathRegex.test(importPath)) {
    // Try root/importPath first
    let rootPath = path.join(root, importPath)
    if (fs.existsSync(rootPath)) {
      const source = fs.readFileSync(rootPath, 'utf-8')
      const lexer = new Lexer(source)
      const parser = new Parser(lexer)
      return parser.parse()
    }
    // Try importPath directly
    if (fs.existsSync(importPath)) {
      const source = fs.readFileSync(importPath, 'utf-8')
      const lexer = new Lexer(source)
      const parser = new Parser(lexer)
      return parser.parse()
    }
  }

  throw new Error(`Cannot resolve import: ${importPath} from ${currentFile}`)
}

async function compileScript(
  entry,
  baseModuleDefinition,
  stageVariables,
  variables
) {
  // 如果没有 entry，返回空 workspace
  if (!entry) {
    return {}
  }

  const fullPath = path.isAbsolute(entry) ? entry : path.join(inputDir, entry)

  try {
    const sourceCode = fs.readFileSync(fullPath, 'utf-8')
    const lexer = new Lexer(sourceCode)
    const parser = new Parser(lexer)
    const program = parser.parse()

    const combinedVariables = new Map([
      ...(stageVariables
        ? Array.from(stageVariables.entries()).map(v => [
            v[0],
            [v[1][0], v[1][1]]
          ])
        : []),
      ...Array.from(variables.entries()).map(v => [v[0], [v[1][0], v[1][1]]])
    ])

    /** @type {import('@scratch-fuse/compiler').ModuleInfo} */
    const module = {
      name: '',
      parent: null,
      functions: new Map(),
      variables: combinedVariables,
      externs: new Map(),
      children: structuredClone(baseModuleDefinition),
      filename: fullPath
    }

    const context = new Context(module, {
      importResolver: {
        resolve: importResolver
      }
    })

    const result = await context.compile(program)

    // 从 compile 结果中获取 variables
    if (!stageVariables) {
      for (const [variable, defaultValue] of result.variables.values()) {
        variable.isGlobal = true
        variables.set(variable.name, [variable, defaultValue])
      }
    } else {
      for (const [variable, defaultValue] of result.variables.values()) {
        if (variable.isGlobal) {
          stageVariables.set(variable.name, [variable, defaultValue])
        } else {
          variables.set(variable.name, [variable, defaultValue])
        }
      }
    }

    const workspace = mergeWorkspaces(
      ...result.functions.map(f => serializeFunction(f)),
      ...result.scripts.map(s => serializeScript(s))
    )
    return workspace
  } catch (error) {
    console.error(`Error compiling script file: ${fullPath}`)
    throw error
  }
}

;(async () => {
  const zip = jszip()
  // process
  const baseModuleDefinition = inputJson.types
    ? mergeModules(
        new Map(Builtins.Sb3Modules),
        await processTypes(inputJson.types)
      )
    : new Map(Builtins.Sb3Modules)
  const projectJson = {
    targets: [],
    monitors: [],
    extensions: inputJson.extensions ? inputJson.extensions : [],
    meta: {
      semver: '3.0.0',
      vm: '0.2.0',
      agent: '',
      platform: { name: 'TurboWarp', url: 'https://turbowarp.org/' }
    }
  }

  const stageVariables = new Map()
  const stage = inputJson.stage

  console.log('Compiling stage...')
  const stageWorkspace = await compileScript(
    stage.entry,
    baseModuleDefinition,
    null,
    stageVariables
  )

  const targets = []
  for (const target of inputJson.targets) {
    console.log(`Compiling sprite: ${target.name}`)
    const spriteVariables = new Map()
    const spriteWorkspace = await compileScript(
      target.entry,
      baseModuleDefinition,
      stageVariables,
      spriteVariables
    )
    targets.push({
      target,
      workspace: spriteWorkspace,
      variables: spriteVariables
    })
  }

  // 创建空 SVG 资源
  function createEmptyAsset() {
    const md5 = md5Bytes(EMPTY_SVG)
    const md5ext = `${md5}.svg`
    zip.file(md5ext, EMPTY_SVG)
    return {
      assetId: md5,
      md5ext: md5ext,
      dataFormat: 'svg'
    }
  }

  // 处理资产文件的辅助函数
  async function processAsset(assetPath, type) {
    const fullPath = path.isAbsolute(assetPath)
      ? assetPath
      : path.join(inputDir, assetPath)
    const assetData = fs.readFileSync(fullPath)
    const assetDataString =
      typeof assetData === 'string' ? assetData : assetData.toString('binary')
    const md5 = md5Bytes(assetDataString)
    const ext = path.extname(assetPath).slice(1)
    const md5ext = `${md5}.${ext}`

    zip.file(md5ext, assetData)

    return {
      assetId: md5,
      md5ext: md5ext,
      dataFormat: ext
    }
  }

  // 构建 stage target
  const stageTarget = {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: stageWorkspace,
    comments: {},
    currentCostume: stage.currentBackdrop ?? 0,
    costumes: [],
    sounds: [],
    volume: stage.volume ?? 100,
    layerOrder: 0,
    tempo: stage.tempo ?? 60,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null
  }

  // 处理 stage 变量
  for (const [variable, defaultValue] of stageVariables.values()) {
    const scratchId = uid()
    if (variable.type === 'list') {
      stageTarget.lists[scratchId] = [
        variable.exportName ?? variable.name,
        Array.isArray(defaultValue) ? defaultValue : []
      ]
    } else {
      stageTarget.variables[scratchId] = [
        variable.exportName ?? variable.name,
        defaultValue ?? 0
      ]
    }
  }

  // 处理 stage backdrops
  if (stage.backdrops && stage.backdrops.length > 0) {
    for (const backdrop of stage.backdrops) {
      const assetInfo = await processAsset(backdrop.path, 'backdrop')
      stageTarget.costumes.push({
        assetId: assetInfo.assetId,
        name: backdrop.name,
        md5ext: assetInfo.md5ext,
        dataFormat: assetInfo.dataFormat,
        rotationCenterX: backdrop.x ?? 0,
        rotationCenterY: backdrop.y ?? 0
      })
    }
  } else {
    // 添加默认空背景
    const emptyAsset = createEmptyAsset()
    stageTarget.costumes.push({
      assetId: emptyAsset.assetId,
      name: 'empty',
      md5ext: emptyAsset.md5ext,
      dataFormat: emptyAsset.dataFormat,
      rotationCenterX: 0,
      rotationCenterY: 0
    })
  }

  // 处理 stage sounds
  if (stage.sounds && stage.sounds.length > 0) {
    for (const sound of stage.sounds) {
      const assetInfo = await processAsset(sound.path, 'sound')
      stageTarget.sounds.push({
        assetId: assetInfo.assetId,
        name: sound.name,
        md5ext: assetInfo.md5ext,
        dataFormat: assetInfo.dataFormat,
        format: assetInfo.dataFormat,
        rate: 48000,
        sampleCount: 1
      })
    }
  }

  projectJson.targets.push(stageTarget)

  // 构建 sprite targets
  for (let i = 0; i < targets.length; i++) {
    const { target, workspace, variables } = targets[i]

    const spriteTarget = {
      isStage: false,
      name: target.name,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: workspace,
      comments: {},
      currentCostume: target.currentCostume ?? 0,
      costumes: [],
      sounds: [],
      volume: target.volume ?? 100,
      layerOrder: target.layerOrder ?? i + 1,
      tempo: target.tempo ?? 60,
      videoTransparency: 50,
      videoState: 'on',
      textToSpeechLanguage: null,
      visible: target.visible ?? true,
      x: target.x ?? 0,
      y: target.y ?? 0,
      size: target.size ?? 100,
      direction: target.direction ?? 90,
      draggable: target.draggable ?? false,
      rotationStyle: target.rotationStyle ?? 'all around'
    }

    // 处理 sprite 局部变量
    for (const [id, [variable, defaultValue]] of variables.entries()) {
      const scratchId = uid()
      if (variable.type === 'list') {
        spriteTarget.lists[scratchId] = [
          variable.exportName ?? variable.name,
          Array.isArray(defaultValue) ? defaultValue : []
        ]
      } else {
        spriteTarget.variables[scratchId] = [
          variable.exportName ?? variable.name,
          defaultValue ?? 0
        ]
      }
    }

    // 处理 sprite costumes
    if (target.costumes && target.costumes.length > 0) {
      for (const costume of target.costumes) {
        const assetInfo = await processAsset(costume.path, 'costume')
        spriteTarget.costumes.push({
          assetId: assetInfo.assetId,
          name: costume.name,
          md5ext: assetInfo.md5ext,
          dataFormat: assetInfo.dataFormat,
          rotationCenterX: costume.x ?? 0,
          rotationCenterY: costume.y ?? 0
        })
      }
    } else {
      // 添加默认空造型
      const emptyAsset = createEmptyAsset()
      spriteTarget.costumes.push({
        assetId: emptyAsset.assetId,
        name: 'empty',
        md5ext: emptyAsset.md5ext,
        dataFormat: emptyAsset.dataFormat,
        rotationCenterX: 0,
        rotationCenterY: 0
      })
    }

    // 处理 sprite sounds
    if (target.sounds && target.sounds.length > 0) {
      for (const sound of target.sounds) {
        const assetInfo = await processAsset(sound.path, 'sound')
        spriteTarget.sounds.push({
          assetId: assetInfo.assetId,
          name: sound.name,
          md5ext: assetInfo.md5ext,
          dataFormat: assetInfo.dataFormat,
          format: assetInfo.dataFormat,
          rate: 48000,
          sampleCount: 1
        })
      }
    }

    projectJson.targets.push(spriteTarget)
  }

  // 将 project.json 添加到 zip
  zip.file('project.json', JSON.stringify(projectJson))

  const result = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  })
  fs.writeFileSync(outputPath, result)
  console.log(`Successfully compiled to ${outputPath}`)
})()
