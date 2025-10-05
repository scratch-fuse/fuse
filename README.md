# Scratch FUSE Compiler

A compiler CLI that converts FUSE (a high-level programming language) projects into Scratch 3.0 (.sb3) files.

## Overview

Scratch FUSE Compiler allows you to write Scratch projects using a more expressive, text-based language called FUSE, then compile them into native Scratch projects. This enables better version control, code organization, and programming patterns for Scratch development.

## Installation

```bash
npm install -g @scratch-fuse/fuse
```

Or use directly with npx:

```bash
npx @scratch-fuse/fuse <input-file> <output-file>
```

## Usage

### Basic Command

```bash
fuse <input-file> <output-file>
```

- `<input-file>`: Path to your project configuration file (YAML format)
- `<output-file>`: Path where the compiled .sb3 file will be saved

### Example

```bash
fuse example/project.yaml output.sb3
```

## Project Format

A FUSE project consists of:
1. A **project configuration file** (YAML)
2. One or more **FUSE script files** (.fuse)
3. Optional **asset files** (images, sounds)

### Project Configuration File

The project configuration file is written in YAML and defines your Scratch project structure.

#### Minimal Example

```yaml
stage: {}
targets:
  - name: "My Sprite"
    entry: "./sprite.fuse"
```

#### Complete Example

```yaml
# Optional: Import type definitions
types:
  - "./types.fuse"

# Optional: Scratch extensions to use
extensions:
  - "pen"
  - "music"

# Stage configuration
stage:
  currentBackdrop: 0
  tempo: 60
  volume: 100
  
  # Optional: Stage backdrops
  backdrops:
    - path: "./backdrop1.svg"
      name: "Backdrop 1"
      x: 240  # rotation center X
      y: 180  # rotation center Y
  
  # Optional: Stage sounds
  sounds:
    - path: "./sound.wav"
      name: "My Sound"
  
  # Optional: Stage script
  entry: "./stage.fuse"

# Sprite configurations
targets:
  - name: "Sprite1"
    currentCostume: 0
    rotationStyle: "all around"  # or "left-right", "don't rotate"
    layerOrder: 1
    visible: true
    x: 0
    y: 0
    size: 100
    direction: 90
    draggable: false
    tempo: 60
    volume: 100
    
    # Optional: Sprite costumes
    costumes:
      - path: "./costume1.svg"
        name: "Costume 1"
        x: 48  # rotation center X
        y: 50  # rotation center Y
    
    # Optional: Sprite sounds
    sounds:
      - path: "./meow.wav"
        name: "Meow"
    
    # Sprite script
    entry: "./sprite1.fuse"
```

### Configuration Schema

#### Root Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `types` | `string[]` | No | Paths to type definition files |
| `extensions` | `string[]` | No | Scratch extensions to enable |
| `stage` | `object` | Yes | Stage configuration |
| `targets` | `object[]` | Yes | Array of sprite configurations |

#### Stage Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `currentBackdrop` | `number` | No | 0 | Index of initial backdrop |
| `tempo` | `number` | No | 60 | Initial tempo (BPM) |
| `volume` | `number` | No | 100 | Initial volume (0-100) |
| `backdrops` | `object[]` | No | - | Stage backdrops |
| `sounds` | `object[]` | No | - | Stage sounds |
| `entry` | `string` | No | - | Path to stage script file |

#### Target (Sprite) Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Sprite name |
| `currentCostume` | `number` | No | 0 | Index of initial costume |
| `rotationStyle` | `string` | No | "all around" | Rotation style |
| `layerOrder` | `number` | No | auto | Layer order (higher = front) |
| `visible` | `boolean` | No | true | Initial visibility |
| `x` | `number` | No | 0 | Initial X position |
| `y` | `number` | No | 0 | Initial Y position |
| `size` | `number` | No | 100 | Initial size percentage |
| `direction` | `number` | No | 90 | Initial direction (degrees) |
| `draggable` | `boolean` | No | false | Can be dragged in player |
| `tempo` | `number` | No | 60 | Sprite-specific tempo |
| `volume` | `number` | No | 100 | Sprite-specific volume |
| `costumes` | `object[]` | No | - | Sprite costumes |
| `sounds` | `object[]` | No | - | Sprite sounds |
| `entry` | `string` | No | - | Path to sprite script file |

#### Asset Properties

**Backdrop/Costume:**
| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | `string` | Yes | Path to image file (SVG, PNG, etc.) |
| `name` | `string` | Yes | Asset name in Scratch |
| `x` | `number` | No | Rotation center X coordinate |
| `y` | `number` | No | Rotation center Y coordinate |

**Sound:**
| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | `string` | Yes | Path to sound file (WAV, MP3, etc.) |
| `name` | `string` | Yes | Sound name in Scratch |

### FUSE Script Files

FUSE is a C-like language that compiles to Scratch blocks. See the example files for syntax reference.

#### Basic Syntax Example

```fuse
// Variables
global score = 0
global playerX = 0

// Functions
@export("start game") fn startGame() once -> void {
  score = 0
  playerX = 0
  looks.say("Game Started!")
}

// Event handlers
event.start {
  startGame()
}

event.whenKeyPressed("space") {
  score = score + 1
}
```

#### Key Features

- **Variables**: `global` and local variables
- **Functions**: Define reusable code blocks
- **Export decorator**: `@export("name")` creates custom Scratch blocks
- **Event handlers**: `event.start`, `event.whenKeyPressed()`, etc.
- **Control flow**: `if`, `while`, `for` loops
- **Built-in namespaces**: `looks`, `motion`, `sensing`, `operators`, etc.

## Example Project

The `example/` directory contains a working example:

- `project.yaml` - Project configuration
- `sort.fuse` - Bubble sort implementation for performance testing

To compile the example:

```bash
fuse example/project.yaml example/output.sb3
```

## File Paths

All paths in the project configuration file can be:
- **Relative paths**: Resolved relative to the project configuration file's directory
- **Absolute paths**: Used as-is

## Asset Requirements

- **Images**: SVG, PNG, JPG, etc.
- **Sounds**: WAV, MP3, etc.
- If no costumes/backdrops are provided, an empty transparent SVG is automatically created

## Output

The compiler generates a standard Scratch 3.0 (.sb3) file that can be:
- Opened in Scratch 3.0 editor
- Opened in TurboWarp
- Shared on the Scratch website

## Related Packages

This compiler depends on several packages in the Scratch FUSE ecosystem:

- `@scratch-fuse/core` - Lexer and parser for FUSE language
- `@scratch-fuse/compiler` - Compiler logic
- `@scratch-fuse/serializer` - Scratch project serialization
- `@scratch-fuse/builtins` - Built-in Scratch block definitions

## License

MPL-2.0

## Repository

https://github.com/scratch-fuse/fuse

## Issues

Report bugs at: https://github.com/scratch-fuse/fuse/issues
