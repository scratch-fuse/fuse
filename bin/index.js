#!/usr/bin/env node

const path = require('path')
const fs = require('fs')
const yaml = require('yaml')
const jsonschema = require('jsonschema')
const forge = require('node-forge')
// Import compiled modules
const {
  Lexer,
  Parser,
} = require('@scratch-fuse/core')
const {
  Compiler,
  getProgramInfo,
  Scope,
} = require('@scratch-fuse/compiler')
const {
  uid,
  serializeScript,
  serializeFunction,
  mergeWorkspaces,
  mergeNamespace
} = require('@scratch-fuse/serializer')
const Builtins = require('@scratch-fuse/builtins')

const jszip = require('jszip')

if (process.argv.length < 3) {
  console.error('Usage: node script-compiler.js <input-file> <output-file>')
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
const EMPTY_SVG = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1" height="1"><rect width="1" height="1" fill="transparent"/></svg>'

const validator = new jsonschema.Validator()

const validationResult = validator.validate(inputJson, schema)

if (!validationResult.valid) {
  console.error('Input JSON does not conform to schema:')
  validationResult.errors.forEach(error => {
    console.error(`- ${error.stack}`)
  })
  process.exit(1)
}

/**
 *
 * @param {Map<string, Namespace>} base
 * @param {Map<string, Namespace>} upper
 */
function mergeNamespaces(base, upper) {
  const merged = new Map(base)
  for (const [name, namespace] of upper.entries()) {
    if (merged.has(name)) {
      const existing = merged.get(name)
      merged.set(name, mergeNamespace(new Map(existing), namespace))
    } else {
      merged.set(name, namespace)
    }
  }
  return merged
}

function processTypes(paths) {
  /**
   * @type {Map<string, import('../dist/index.d.ts').Namespace>}
   */
  const namespaces = new Map(Builtins.Sb3Namespaces)
  for (const typePath of paths) {
    const fullPath = path.isAbsolute(typePath)
      ? typePath
      : path.join(inputDir, typePath)
    const typeFuse = fs.readFileSync(fullPath, 'utf-8')
    const lexer = new Lexer(typeFuse)
    const parser = new Parser(lexer)
    const ast = parser.parse()
    const programInfo = getProgramInfo(ast)
    namespaces = mergeNamespaces(namespaces, programInfo.namespaces)
  }
  return namespaces
}

function processVariable(variable) {
  const scratchId = uid()
  return {
    [scratchId]: [
      variable.exportName ?? variable.name,
      variable.type === 'list' ? [] : 0
    ]
  }
}
/**
 *
 * @param {Map<string, import('../dist/index.d.ts').Variable>} variableMap
 * @returns {Record<string, [string, string | number | boolean | (string | number | boolean)[]]>}
 */
function processVariables(variableMap) {
  const processed = {}
  for (const [, [variable, defaultValue]] of variableMap) {
    Object.assign(processed, processVariable(variable))
  }
  return processed
}


function compileScript(entry, baseNamespaceDefinition, stageVariables, variables) {
  // 如果没有 entry，返回空 workspace
  if (!entry) {
    return {}
  }
  
  const fullPath = path.isAbsolute(entry) ? entry : path.join(inputDir, entry)
  const sourceCode = fs.readFileSync(fullPath, 'utf-8')
  const lexer = new Lexer(sourceCode)
  const tokens = lexer.all()
  const parser = new Parser(tokens)
  const program = parser.parse()
  const programInfo = getProgramInfo(program)
  const localNamespaceDefinition = mergeNamespaces(
    baseNamespaceDefinition,
    programInfo.namespaces
  )
  if (!stageVariables) {
    for (const variable of programInfo.variables.values()) {
      variable[0].isGlobal = true
    }
  }
  for (const [id, [variable, defaultValue]] of programInfo.variables.entries()) {
    if (stageVariables) {
      if (variable.isGlobal) {
        stageVariables.set(id, [variable, defaultValue])
      } else {
        variables.set(id, [variable, defaultValue])
      }
    } else {
      variables.set(id, [variable, defaultValue])
    }
  }
  const combinedVariables = new Map([
    ...Array.from(stageVariables.entries()).map(v => [v[0], v[1][0]]),
    ...Array.from(variables.entries()).map(v => [v[0], v[1][0]])
  ])
  const globalScope = new Scope(combinedVariables)
  const funcs = Compiler.getFunctions(globalScope, program)
  const compiler = new Compiler(
    globalScope,
    funcs,
    localNamespaceDefinition,
  )
  const workspace = mergeWorkspaces(
    ...Array.from(funcs.values()).map(f => serializeFunction(compiler.parse(f))),
    ...compiler.parse(program).map(s => serializeScript(s))
  )
  return workspace
}

;(async () => {
  const zip = jszip()
  // process
  const baseNamespaceDefinition = inputJson.types
    ? processTypes(inputJson.types)
    : Builtins.Sb3Namespaces
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
  const stageWorkspace = compileScript(
    stage.entry,
    baseNamespaceDefinition,
    null,
    stageVariables
  )

  const targets = inputJson.targets.map(target => {
    const spriteVariables = new Map()
    const spriteWorkspace = compileScript(
      target.entry,
      baseNamespaceDefinition,
      stageVariables,
      spriteVariables
    )
    return { target, workspace: spriteWorkspace, variables: spriteVariables }
  })

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
  for (const [id, [variable, defaultValue]] of stageVariables.entries()) {
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
