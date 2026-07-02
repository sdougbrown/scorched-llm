import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function getAllTsFiles(dir: string): string[] {
  const files: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath))
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

describe('renderer-contract', () => {
  const engineSrcDir = join(__dirname, '..', 'src')
  const packageJsonPath = join(__dirname, '..', 'package.json')
  const spectatorPath = join(__dirname, '..', '..', 'spectator', 'src')

  it('no engine source file imports @scorched-llm/spectator', () => {
    const tsFiles = getAllTsFiles(engineSrcDir)
    const violations: string[] = []

    for (const filePath of tsFiles) {
      const content = readFileSync(filePath, 'utf-8')
      if (content.includes('@scorched-llm/spectator')) {
        violations.push(`${filePath}: contains "@scorched-llm/spectator"`)
      }
    }

    expect(violations, `Engine imports spectator in: ${violations.join(', ')}`).toEqual([])
  })

  it('no engine source file imports from a relative spectator path', () => {
    const tsFiles = getAllTsFiles(engineSrcDir)
    const violations: string[] = []

    for (const filePath of tsFiles) {
      const content = readFileSync(filePath, 'utf-8')
      if (content.includes(spectatorPath) || content.includes('../spectator/')) {
        violations.push(`${filePath}: contains relative spectator import`)
      }
    }

    expect(violations).toEqual([])
  })

  it('engine package.json has no dependency on @scorched-llm/spectator', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
    }
    expect(allDeps).not.toHaveProperty('@scorched-llm/spectator')
  })

  it('engine exports no rendering-related symbols', () => {
    const tsFiles = getAllTsFiles(engineSrcDir)
    const violations: string[] = []
    // Check for actual rendering references, not JS built-in types like DOMException
    const renderingTerms = [
      'Canvas',
      'HTMLElement',
      'document.',
      'window.',
      'requestAnimationFrame',
      'SVG',
      'DOM',
    ]

    for (const filePath of tsFiles) {
      const content = readFileSync(filePath, 'utf-8')
      for (const term of renderingTerms) {
        // Allow DOMException (JS built-in error type used for AbortError handling)
        if (term === 'DOM' && content.includes('DOMException')) continue
        if (content.includes(term)) {
          violations.push(`${filePath}: contains "${term}"`)
        }
      }
    }

    expect(violations, `Engine source references rendering terms: ${violations.join(', ')}`).toEqual([])
  })
})
