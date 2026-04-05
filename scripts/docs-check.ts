/**
 * 문서 canonical 체계·README 입구·스텁 길이 점검.
 * 실행: npm run docs:check
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const docsDir = path.join(root, 'docs');

const README_FORBIDDEN = ['logging detail', 'scheduler detail', 'decision prompt internal'] as const;

const STUBS = [
  { rel: path.join('docs', 'SYSTEM_ARCHITECTURE.md'), name: 'SYSTEM_ARCHITECTURE.md' },
  { rel: path.join('docs', 'OPERATIONS_RUNBOOK.md'), name: 'OPERATIONS_RUNBOOK.md' },
  { rel: path.join('docs', 'DATABASE_SCHEMA.md'), name: 'DATABASE_SCHEMA.md' }
] as const;

const STUB_MARKER = '정본은';

/** 마크다운 인라인 링크 대상에 구 문서 .md 가 들어가면 경고 (정책·이력 제외) */
const LEGACY_LINK_RE =
  /\]\([^)]*\b(SYSTEM_ARCHITECTURE|OPERATIONS_RUNBOOK|DATABASE_SCHEMA)\.md[^)]*\)/gi;

const LINK_CHECK_SKIP = new Set(
  [
    'CHANGELOG.md',
    'DOCUMENTATION_POLICY.md',
    'SYSTEM_ARCHITECTURE.md',
    'OPERATIONS_RUNBOOK.md',
    'DATABASE_SCHEMA.md'
  ].map((f) => path.join(docsDir, f).toLowerCase())
);

function walkMarkdownFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMarkdownFiles(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

function main(): void {
  let failed = false;
  const warnings: string[] = [];

  // --- 1) README 금지 키워드 (3회 이상 합산 시 경고)
  const readmePath = path.join(root, 'README.md');
  if (!fs.existsSync(readmePath)) {
    console.warn('[docs-check] WARNING: README.md not found.');
    warnings.push('README missing');
  } else {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const lower = readme.toLowerCase();
    let hits = 0;
    for (const phrase of README_FORBIDDEN) {
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const m = lower.match(re);
      if (m) hits += m.length;
    }
    if (hits >= 3) {
      warnings.push(
        `README: forbidden keyword phrase(s) (${README_FORBIDDEN.join(', ')}) appear ${hits} times total (warn if >= 3)`
      );
    }
  }

  // --- 2) 스텁: 10줄 미만, "정본은" 포함
  for (const { rel, name } of STUBS) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) {
      console.error(`[docs-check] FAIL: ${name} missing.`);
      failed = true;
      continue;
    }
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split(/\r?\n/).length;
    if (lines >= 10) {
      console.error(`[docs-check] FAIL: ${name} has ${lines} lines (must be < 10).`);
      failed = true;
    }
    if (!raw.includes(STUB_MARKER)) {
      console.error(`[docs-check] FAIL: ${name} must contain "${STUB_MARKER}".`);
      failed = true;
    }
  }

  // --- 3) docs 내 구 문서 .md 링크 타겟 (이력·정책 제외)
  for (const file of walkMarkdownFiles(docsDir)) {
    if (LINK_CHECK_SKIP.has(file.toLowerCase())) continue;
    const text = fs.readFileSync(file, 'utf8');
    const matches = [...text.matchAll(LEGACY_LINK_RE)];
    if (matches.length > 0) {
      warnings.push(
        `${path.relative(root, file)}: markdown link targets legacy doc (${matches.length} match(es)) — use canonical ARCHITECTURE / OPERATIONS / DATABASE`
      );
    }
  }

  for (const w of warnings) {
    console.warn(`[docs-check] WARNING: ${w}`);
  }

  if (failed) {
    console.error('[docs-check] FAILED (stub rules).');
    process.exit(1);
  }

  console.log('[docs-check] OK (stubs valid; see warnings above if any).');
}

main();
