#!/usr/bin/env node
// Offline, read-only research report. Does not import the engine or contact a service.
import fs from 'node:fs';
import { evaluateValueStudy, valueStudyTemplate } from '../src/value-study.js';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--template') {
  console.log(JSON.stringify(valueStudyTemplate(), null, 2));
} else if (args.length === 2 && args[0] === '--input') {
  try {
    const report = evaluateValueStudy(JSON.parse(fs.readFileSync(args[1], 'utf8')));
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error('Could not evaluate the study. Check the JSON schema, unique IDs and evidence-scope fields. No input data was changed.');
    process.exitCode = 1;
  }
} else {
  console.error('Usage: npm run study:value -- --input PRIVATE_STUDY.json | --template');
  process.exitCode = 2;
}
