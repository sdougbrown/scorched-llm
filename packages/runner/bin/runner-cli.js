#!/usr/bin/env node
import { runRunnerCli } from '../dist/index.js'

await runRunnerCli(process.argv.slice(2))
