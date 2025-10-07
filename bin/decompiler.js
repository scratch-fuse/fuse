#!/usr/bin/env node

const path = require('path')
const fs = require('fs')
const yaml = require('yaml')
const jszip = require('jszip')
const forge = require('node-forge')

// Import compiled modules
const {
  toSource,
} = require('@scratch-fuse/core')
const {
  Scope,
  createDecompiler,
  VariableNameManager
} = require('@scratch-fuse/compiler')
const {
  deserializeAllScripts,
  deserializeAllFunctions,
} = require('@scratch-fuse/serializer')
const Builtins = require('@scratch-fuse/builtins')

function md5(input) {
  const md = forge.md.md5.create()
  md.update(input)
  return md.digest().toHex()
}

if (process.argv.length < 3) {
  console.error('Usage: node fuse-decompiler.js <input-sb3-file> <output-directory>')
  process.exit(1)
}

const inputPath = process.argv[2]
const outputDir = process.argv[3]

;(async () => {
  // Step 1: Load and unzip the sb3 file
  console.log(`Reading sb3 file: ${inputPath}`)
  const sb3Data = fs.readFileSync(inputPath)
  const zip = await jszip.loadAsync(sb3Data)
  
  // Step 2: Extract project.json
  const projectJsonFile = zip.file('project.json')
  if (!projectJsonFile) {
    console.error('Error: project.json not found in sb3 file')
    process.exit(1)
  }
  
  const projectJson = JSON.parse(await projectJsonFile.async('text'))
  console.log(`Found ${projectJson.targets.length} targets`)
  
  // Step 3: Create output directory structure
  const assetsDir = path.join(outputDir, 'assets')
  const scriptsDir = path.join(outputDir, 'scripts')
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true })
  }
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true })
  }
  
  // Step 4: Extract assets
  console.log('Extracting assets...')
  const assetMapping = new Map() // md5ext -> new filename
  
  async function extractAsset(md5ext, newName) {
    const file = zip.file(md5ext)
    if (file) {
      const assetPath = path.join(assetsDir, md5ext)
      const data = await file.async('nodebuffer')
      fs.writeFileSync(assetPath, data)
      assetMapping.set(md5ext, md5ext)
      return md5ext
    }
    return null
  }
  
  // Step 5: Process each target and decompile
  const namespaces = new Map(Builtins.Sb3Namespaces)
  const projectConfig = {
    extensions: projectJson.extensions || [],
    stage: {},
    targets: []
  }
  
  // Find stage target
  const stageTarget = projectJson.targets.find(t => t.isStage)
  if (!stageTarget) {
    console.error('Error: No stage target found')
    process.exit(1)
  }
  
  // Step 5.1: Collect global variables from stage
  console.log('Collecting global variables from Stage...')
  const globalVariables = new Map()
  const globalVariableDeclarations = []
  
  for (const [id, [name, value]] of Object.entries(stageTarget.variables || {})) {
    const variable = {
      type: 'variable',
      name: name,
      isGlobal: true,
      exportName: null
    }
    globalVariables.set(name, variable)
    globalVariableDeclarations.push([variable, value])
  }
  
  for (const [id, [name, value]] of Object.entries(stageTarget.lists || {})) {
    const variable = {
      type: 'list',
      name: name,
      isGlobal: true,
      exportName: null
    }
    globalVariables.set(name, variable)
    globalVariableDeclarations.push([variable, value])
  }
  
  console.log(`  Found ${globalVariableDeclarations.length} global variables`)
  
  // Step 5.2: Extract stage assets
  console.log('Processing Stage assets...')
  
  // Extract stage backdrops
  projectConfig.stage.backdrops = []
  for (let i = 0; i < stageTarget.costumes.length; i++) {
    const costume = stageTarget.costumes[i]
    const fileName = await extractAsset(costume.md5ext, `backdrop_${costume.name}`)
    if (fileName) {
      projectConfig.stage.backdrops.push({
        name: costume.name,
        path: `assets/${fileName}`,
        x: costume.rotationCenterX || 0,
        y: costume.rotationCenterY || 0
      })
    }
  }
  
  // Extract stage sounds
  projectConfig.stage.sounds = []
  for (let i = 0; i < stageTarget.sounds.length; i++) {
    const sound = stageTarget.sounds[i]
    const fileName = await extractAsset(sound.md5ext, `sound_stage_${sound.name}`)
    if (fileName) {
      projectConfig.stage.sounds.push({
        name: sound.name,
        path: `assets/${fileName}`
      })
    }
  }
  
  projectConfig.stage.currentBackdrop = stageTarget.currentCostume || 0
  projectConfig.stage.tempo = stageTarget.tempo || 60
  projectConfig.stage.volume = stageTarget.volume || 100
  const usedNames = new VariableNameManager()
  
  // Step 5.3: Generate stage script FIRST (contains global variables)
  console.log('Generating Stage script...')
  const stageSource = await decompileStage(stageTarget, namespaces, globalVariables, globalVariableDeclarations, usedNames)
  if (stageSource) {
    const scriptPath = path.join(scriptsDir, 'stage.fuse')
    fs.writeFileSync(scriptPath, stageSource)
    projectConfig.stage.entry = 'scripts/stage.fuse'
    console.log(`  ✓ Generated stage script with ${globalVariableDeclarations.length} global variables`)
  }
  
  // Step 5.4: Process sprite targets (each has its own scope)
  const spriteTargets = projectJson.targets.filter(t => !t.isStage)
  for (const target of spriteTargets) {
    console.log(`Processing sprite: ${target.name}...`)
    
    const targetConfig = {
      name: target.name,
      currentCostume: target.currentCostume || 0,
      rotationStyle: target.rotationStyle || 'all around',
      layerOrder: target.layerOrder || 0,
      visible: target.visible !== false,
      x: target.x || 0,
      y: target.y || 0,
      size: target.size || 100,
      direction: target.direction || 90,
      draggable: target.draggable || false,
      volume: target.volume || 100,
      costumes: [],
      sounds: []
    }
    
    // Extract sprite costumes
    for (let i = 0; i < target.costumes.length; i++) {
      const costume = target.costumes[i]
      const fileName = await extractAsset(costume.md5ext, `costume_${target.name}_${costume.name}`)
      if (fileName) {
        targetConfig.costumes.push({
          name: costume.name,
          path: `assets/${fileName}`,
          x: costume.rotationCenterX || 0,
          y: costume.rotationCenterY || 0
        })
      }
    }
    
    // Extract sprite sounds
    for (let i = 0; i < target.sounds.length; i++) {
      const sound = target.sounds[i]
      const fileName = await extractAsset(sound.md5ext, `sound_${target.name}_${sound.name}`)
      if (fileName) {
        targetConfig.sounds.push({
          name: sound.name,
          path: `assets/${fileName}`
        })
      }
    }
    
    // Decompile sprite scripts
    if (target.blocks && Object.keys(target.blocks).length > 0) {
      const spriteSource = await decompileTarget(target, namespaces, globalVariables, usedNames)
      if (spriteSource) {
        const safeName = target.name.replace(/[^a-zA-Z0-9_]/g, '_')
        const scriptPath = path.join(scriptsDir, `${safeName}.fuse`)
        fs.writeFileSync(scriptPath, spriteSource)
        targetConfig.entry = `scripts/${safeName}.fuse`
        console.log(`  ✓ Decompiled ${target.name} script`)
      }
    }
    
    projectConfig.targets.push(targetConfig)
  }
  
  // Step 6: Write project.yaml
  const yamlContent = yaml.stringify(projectConfig)
  fs.writeFileSync(path.join(outputDir, 'project.yaml'), yamlContent)
  
  console.log(`\n✓ Successfully decompiled to ${outputDir}`)
  console.log(`  - ${Object.keys(assetMapping).length} assets extracted`)
  console.log(`  - ${projectConfig.targets.length + 1} scripts generated`)
})()

/**
 * Decompile stage blocks to FUSE source code with global variables
 * @param {Object} stageTarget - The stage target object from project.json
 * @param {Map} namespaces - The namespace definitions
 * @param {Array} globalVariables - Array of [variable, value] pairs for global variables
 * @returns {Promise<string>} - The generated FUSE source code
 */
async function decompileStage(stageTarget, namespaces, globalVariables, globalVariableDeclarations, usedNames) {
  try {
    
    const globalScope = new Scope(globalVariables)
    
    // Step 2: Deserialize blocks to IR (if any)
    const workspace = stageTarget.blocks || {}
    const scripts = deserializeAllScripts(workspace, globalScope)
    const functions = deserializeAllFunctions(workspace, globalScope)
    
    console.log(`    Found ${scripts.length} scripts and ${functions.length} functions`)
    
    // Step 3: Create decompiler
    const decompiler = createDecompiler(globalScope, namespaces, functions, usedNames)
    
    // Step 4: Decompile to AST
    const astNodes = []
    
    // ALWAYS add global variable declarations first
    for (const [variable, value] of globalVariableDeclarations) {
      const varDecl = decompiler.decompileVariable(variable, value)
      astNodes.push(varDecl)
    }
    
    // Decompile functions
    for (const func of functions) {
      try {
        const funcDecl = decompiler.decompileFunction(func)
        astNodes.push(funcDecl)
      } catch (error) {
        console.log(`    ⚠ Warning: Could not decompile function ${func.proccode}: ${error.stack}`)
      }
    }
    
    // Decompile scripts (event handlers)
    for (const script of scripts) {
      try {
        const scriptAst = decompiler.decompileScript(script)
        astNodes.push(...scriptAst)
      } catch (error) {
        console.log(`    ⚠ Warning: Could not decompile script: ${error.stack}`)
      }
    }
    
    // Step 5: Insert namespace declarations at the beginning (for missing/custom namespaces)
    const generatedNamespaces = decompiler.namespaces
    const namespaceNodes = []
    for (const [namespaceName, namespaceBody] of generatedNamespaces.entries()) {
      const properties = []
      for (const [key, value] of namespaceBody.entries()) {
        properties.push({
          type: 'NamespaceProperty',
          key: key,
          value: value,
          line: 0,
          column: 0
        })
      }
      namespaceNodes.push({
        type: 'NamespaceDeclaration',
        name: namespaceName,
        body: {
          type: 'NamespaceBody',
          properties: properties,
          line: 0,
          column: 0
        },
        line: 0,
        column: 0
      })
    }
    
    // Step 6: Generate source code with namespaces first
    // Always generate, even if only global variables
    const program = {
      type: 'Program',
      body: [...namespaceNodes, ...astNodes],
      line: 0,
      column: 0
    }
    
    const sourceCode = toSource(program)
    return sourceCode
    
  } catch (error) {
    console.error(`  ✗ Error decompiling stage: ${error.stack}`)
    console.error(error.stack)
    return null
  }
}

/**
 * Decompile a sprite's blocks to FUSE source code
 * @param {Object} target - The target object from project.json
 * @param {Map} namespaces - The namespace definitions
 * @param {Map} globalVariables - Map of global variable definitions
 * @returns {Promise<string>} - The generated FUSE source code
 */
async function decompileTarget(target, namespaces, globalVariables, usedNames) {
  try {
    // Step 1: Collect local variables from the sprite
    const localVars = new Map(globalVariables.entries())
    const variableDeclarations = []
    
    // Parse sprite's local variables
    for (const [id, [name, value]] of Object.entries(target.variables || {})) {
      if (localVars.has(name)) {
        console.log(`    ⚠ Warning: Variable name conflict for '${name}', skipping local variable`)
        continue
      }
      const variable = {
        type: 'variable',
        name: name,
        isGlobal: false,
        exportName: null
      }
      localVars.set(name, variable)
      variableDeclarations.push([variable, value])
    }
    
    for (const [id, [name, value]] of Object.entries(target.lists || {})) {
      const variable = {
        type: 'list',
        name: name,
        isGlobal: false,
        exportName: null
      }
      localVars.set(name, variable)
      variableDeclarations.push([variable, value])
    }
    
    // Step 2: Create scope with global + local variables
    const globalScope = new Scope(localVars)
    
    // Step 3: Deserialize blocks to IR
    const workspace = target.blocks
    const scripts = deserializeAllScripts(workspace, globalScope)
    const functions = deserializeAllFunctions(workspace, globalScope)
    
    console.log(`    Found ${scripts.length} scripts and ${functions.length} functions`)
    
    // Step 4: Create decompiler
    const decompiler = createDecompiler(globalScope, namespaces, functions, usedNames)
    
    // Step 5: Decompile to AST
    const astNodes = []
    
    // Decompile LOCAL variables only (global variables are in stage)
    for (const [variable, value] of variableDeclarations) {
      const varDecl = decompiler.decompileVariable(variable, value)
      astNodes.push(varDecl)
    }
    
    // Decompile functions
    for (const func of functions) {
      try {
        const funcDecl = decompiler.decompileFunction(func)
        astNodes.push(funcDecl)
      } catch (error) {
        console.log(`    ⚠ Warning: Could not decompile function ${func.proccode}: ${error.stack}`)
      }
    }
    
    // Decompile scripts (event handlers)
    for (const script of scripts) {
      try {
        const scriptAst = decompiler.decompileScript(script)
        astNodes.push(...scriptAst)
      } catch (error) {
        console.log(`    ⚠ Warning: Could not decompile script: ${error.stack}`)
      }
    }
    
    // Step 6: Insert namespace declarations at the beginning (for missing/custom namespaces)
    const generatedNamespaces = decompiler.namespaces
    const namespaceNodes = []
    for (const [namespaceName, namespaceBody] of generatedNamespaces.entries()) {
      const properties = []
      for (const [key, value] of namespaceBody.entries()) {
        properties.push({
          type: 'NamespaceProperty',
          key: key,
          value: value,
          line: 0,
          column: 0
        })
      }
      namespaceNodes.push({
        type: 'NamespaceDeclaration',
        name: namespaceName,
        body: {
          type: 'NamespaceBody',
          properties: properties,
          line: 0,
          column: 0
        },
        line: 0,
        column: 0
      })
    }
    
    // Step 7: Generate source code with namespaces first
    if (astNodes.length === 0 && namespaceNodes.length === 0) {
      return null
    }
    
    const program = {
      type: 'Program',
      body: [...namespaceNodes, ...astNodes],
      line: 0,
      column: 0
    }
    
    const sourceCode = toSource(program)
    return sourceCode
    
  } catch (error) {
    console.error(`  ✗ Error decompiling target: ${error.stack}`)
    console.error(error.stack)
    return null
  }
}
