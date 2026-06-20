#!/usr/bin/env tsx
/**
 * Sanitize evaluation files — check for PII and tracking numbers.
 *
 * Scans all files in evaluations/ directory for:
 * - Sequences of 10+ consecutive digits (tracking numbers, SSNs)
 * - Email address patterns
 *
 * Exits with code 1 if any violations found.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const EVALUATIONS_DIR = path.join(process.cwd(), "evaluations");

// Patterns to detect
const PATTERNS = {
  longDigitSequence: /\d{10,}/g,
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
};

interface Violation {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

function scanFile(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Check for long digit sequences
    const digitMatches = line.match(PATTERNS.longDigitSequence);
    if (digitMatches) {
      for (const match of digitMatches) {
        violations.push({
          file: filePath,
          line: lineNumber,
          pattern: "longDigitSequence",
          match,
        });
      }
    }

    // Check for email addresses
    const emailMatches = line.match(PATTERNS.email);
    if (emailMatches) {
      for (const match of emailMatches) {
        violations.push({
          file: filePath,
          line: lineNumber,
          pattern: "email",
          match,
        });
      }
    }
  }

  return violations;
}

function scanDirectory(dir: string): Violation[] {
  const violations: Violation[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      violations.push(...scanDirectory(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      violations.push(...scanFile(fullPath));
    }
  }

  return violations;
}

function main() {
  console.log(`Scanning ${EVALUATIONS_DIR} for PII and tracking numbers...\n`);

  if (!fs.existsSync(EVALUATIONS_DIR)) {
    console.log(`Evaluations directory not found: ${EVALUATIONS_DIR}`);
    console.log("Nothing to scan.");
    process.exit(0);
  }

  const violations = scanDirectory(EVALUATIONS_DIR);

  if (violations.length === 0) {
    console.log("✓ No violations found.");
    process.exit(0);
  }

  console.error(`✗ Found ${violations.length} violation(s):\n`);

  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    Pattern: ${v.pattern}`);
    console.error(`    Match: ${v.match}\n`);
  }

  console.error("Sanitization failed. Remove PII and tracking numbers before committing.");
  process.exit(1);
}

main();
