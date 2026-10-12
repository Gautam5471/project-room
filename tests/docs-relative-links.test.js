import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');

function findBrokenRelativeLinks(dir) {
  const broken = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.md'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const links = /!?\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of text.matchAll(links)) {
      const raw = match[1].trim().replace(/^<|>$/g, '');
      if (!raw || raw.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      const target = decodeURIComponent(raw.split('#')[0].split('?')[0]);
      if (!target || target.startsWith('/')) continue;
      const abs = resolve(dir, file, '..', target);
      if (!existsSync(abs)) broken.push(`${file}: ${raw}`);
    }
  }
  return broken;
}

// Check committed local file links, not URLs, fragments, or bare prose references.
test('relative Markdown links in docs point to committed files', () => {
  const broken = findBrokenRelativeLinks(docs);
  assert.deepEqual(broken, [], `Broken local documentation links:\n${broken.join('\n')}`);
});

test('relative link checker reports missing targets including formerly exempt files', t => {
  const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'doc-relative-links-regression-')));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  writeFileSync(join(fixtureDir, 'VALID.md'), '# Valid\n');
  writeFileSync(join(fixtureDir, 'INDEX.md'), [
    '# Index',
    '[Valid](VALID.md)',
    '[External](https://example.com)',
    '[Fragment](#section)',
    '[Protocol](//example.com)',
    '[Claude](CLAUDE-CHANNEL.md)',
    '[Receive](CONNECT-RECEIVE.md)',
    '[Claims](WORK-CLAIMS.md)',
    '[QA2](QA2-SYSTEMS.md)',
    '[Missing](OTHER-MISSING.md)',
  ].join('\n'));

  const broken = findBrokenRelativeLinks(fixtureDir);
  assert.deepEqual(broken, [
    'INDEX.md: CLAUDE-CHANNEL.md',
    'INDEX.md: CONNECT-RECEIVE.md',
    'INDEX.md: WORK-CLAIMS.md',
    'INDEX.md: QA2-SYSTEMS.md',
    'INDEX.md: OTHER-MISSING.md',
  ]);
});

test('scripts/docs-link-check.mjs fails on missing targets including formerly exempt files', t => {
  const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'docs-link-check-regression-')));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  mkdirSync(join(fixtureDir, 'scripts'), { recursive: true });
  mkdirSync(join(fixtureDir, 'docs'), { recursive: true });
  copyFileSync(join(root, 'scripts', 'docs-link-check.mjs'), join(fixtureDir, 'scripts', 'docs-link-check.mjs'));

  writeFileSync(join(fixtureDir, 'docs', 'VALID.md'), '# Valid\n');

  // Case 1: valid link and external URL pass cleanly
  writeFileSync(join(fixtureDir, 'docs', 'INDEX.md'), [
    '# Index',
    '[Valid](VALID.md)',
    '[External](https://example.com)',
    '[Fragment](#section)',
  ].join('\n'));

  const validRun = spawnSync(process.execPath, [join(fixtureDir, 'scripts', 'docs-link-check.mjs')], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });
  assert.equal(validRun.status, 0);
  assert.match(validRun.stdout, /docs-link-check: OK/);

  // Case 2: formerly exempt targets and missing targets fail without being marked pending
  writeFileSync(join(fixtureDir, 'docs', 'INDEX.md'), [
    '# Index',
    '[Valid](VALID.md)',
    '[Claude](CLAUDE-CHANNEL.md)',
    '[Receive](CONNECT-RECEIVE.md)',
    '[Claims](WORK-CLAIMS.md)',
    '[QA2](QA2-SYSTEMS.md)',
    '[Missing](OTHER-MISSING.md)',
  ].join('\n'));

  const failRun = spawnSync(process.execPath, [join(fixtureDir, 'scripts', 'docs-link-check.mjs')], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });
  assert.equal(failRun.status, 1);
  assert.doesNotMatch(failRun.stdout, /pending \(other batch\)/);
  assert.match(failRun.stderr, /docs\/INDEX\.md links to CLAUDE-CHANNEL\.md, which is not in the tree/);
  assert.match(failRun.stderr, /docs\/INDEX\.md links to CONNECT-RECEIVE\.md, which is not in the tree/);
  assert.match(failRun.stderr, /docs\/INDEX\.md links to WORK-CLAIMS\.md, which is not in the tree/);
  assert.match(failRun.stderr, /docs\/INDEX\.md links to QA2-SYSTEMS\.md, which is not in the tree/);
  assert.match(failRun.stderr, /docs\/INDEX\.md links to OTHER-MISSING\.md, which is not in the tree/);
  assert.match(failRun.stderr, /docs-link-check: FAILED \(5 broken, 6 checked\)/);
});
