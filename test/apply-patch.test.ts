import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EditAmbiguousError, EditNotFoundError, findSpans, replaceOccurrence } from '../src/tools/impl/text-edit.js';
import { applyPatchTool } from '../src/tools/impl/patch.js';
import { editTool } from '../src/tools/impl/edit.js';
import type { ToolContext } from '../src/tools/registry.js';

interface PatchResult { ok: boolean; path: string; edits: number; applied: Array<{ index: number; replacements: number; match: string }>; changed: boolean }
interface EditResult { ok: boolean; path: string; replacements: number; match: string }

async function withWorkspace<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-patch-test-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('replaceOccurrence handles exact match, uniqueness, replaceAll, and not-found', () => {
  const exact = replaceOccurrence('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 99;');
  assert.equal(exact.updated, 'const a = 99;\nconst b = 2;\n');
  assert.equal(exact.mode, 'exact');
  assert.equal(exact.replacements, 1);

  assert.throws(() => replaceOccurrence('x = 1\nx = 1\n', 'x = 1', 'y = 1'), EditAmbiguousError);
  const all = replaceOccurrence('x = 1\nx = 1\n', 'x = 1', 'y = 1', { replaceAll: true });
  assert.equal(all.updated, 'y = 1\ny = 1\n');
  assert.equal(all.replacements, 2);

  assert.throws(() => replaceOccurrence('nothing here', 'missing', 'x'), EditNotFoundError);
});

test('findSpans falls back to whitespace-tolerant fuzzy matching only when enabled', () => {
  const content = 'function outer() {\n    const value = 1;\n    return value;\n}\n';
  const needle = '  const value = 1;\n  return value;'; // 2-space indent vs the file's 4-space
  assert.equal(findSpans(content, needle).spans.length, 0); // exact off by default
  const fuzzy = findSpans(content, needle, { fuzzy: true });
  assert.equal(fuzzy.mode, 'fuzzy');
  assert.equal(fuzzy.spans.length, 1);
});

test('fuzzy replacement re-indents newString to the file and tolerates trailing whitespace', () => {
  const indented = replaceOccurrence(
    'function outer() {\n    const value = 1;\n    return value;\n}\n',
    '  const value = 1;\n  return value;',
    '  const value = 2;\n  return value * 2;',
    { fuzzy: true },
  );
  assert.equal(indented.mode, 'fuzzy');
  assert.equal(indented.updated, 'function outer() {\n    const value = 2;\n    return value * 2;\n}\n');

  const trailing = replaceOccurrence('alpha   \nbeta\n', 'alpha\nbeta', 'gamma\nbeta', { fuzzy: true });
  assert.equal(trailing.mode, 'fuzzy');
  assert.equal(trailing.updated, 'gamma\nbeta\n');
});

test('apply_patch applies ordered edits atomically and later edits see earlier results', async () => {
  await withWorkspace(async (directory) => {
    const context: ToolContext = { cwd: directory };
    await writeFile(join(directory, 'sample.txt'), 'first line\nsecond line\nthird line\n');
    const result = await applyPatchTool.execute({
      filePath: 'sample.txt',
      edits: [
        { oldString: 'first line', newString: 'FIRST' },
        { oldString: 'FIRST\nsecond line', newString: 'FIRST\nSECOND' }, // depends on edit 0
      ],
    }, context) as PatchResult;
    assert.equal(result.ok, true);
    assert.equal(result.edits, 2);
    assert.equal(result.changed, true);
    assert.deepEqual(result.applied.map((entry) => entry.match), ['exact', 'exact']);
    assert.equal(await readFile(join(directory, 'sample.txt'), 'utf8'), 'FIRST\nSECOND\nthird line\n');
  });
});

test('apply_patch is all-or-nothing: a failing edit leaves the file untouched and reports its index', async () => {
  await withWorkspace(async (directory) => {
    const context: ToolContext = { cwd: directory };
    const original = 'alpha\nbeta\ngamma\n';
    await writeFile(join(directory, 'atomic.txt'), original);
    await assert.rejects(
      applyPatchTool.execute({
        filePath: 'atomic.txt',
        edits: [
          { oldString: 'alpha', newString: 'ALPHA' },
          { oldString: 'does-not-exist', newString: 'nope' },
        ],
      }, context) as Promise<unknown>,
      /edits\[1\] oldString not found.*NOT modified/s,
    );
    assert.equal(await readFile(join(directory, 'atomic.txt'), 'utf8'), original);
  });
});

test('apply_patch supports replaceAll and rejects ambiguous edits', async () => {
  await withWorkspace(async (directory) => {
    const context: ToolContext = { cwd: directory };
    await writeFile(join(directory, 'multi.txt'), 'dup\ndup\ndup\n');
    const all = await applyPatchTool.execute({
      filePath: 'multi.txt',
      edits: [{ oldString: 'dup', newString: 'unique', replaceAll: true }],
    }, context) as PatchResult;
    assert.equal(all.applied[0]?.replacements, 3);
    assert.equal(await readFile(join(directory, 'multi.txt'), 'utf8'), 'unique\nunique\nunique\n');

    await writeFile(join(directory, 'ambiguous.txt'), 'tok\ntok\n');
    await assert.rejects(
      applyPatchTool.execute({ filePath: 'ambiguous.txt', edits: [{ oldString: 'tok', newString: 'x' }] }, context) as Promise<unknown>,
      /appears 2 times.*NOT modified/s,
    );
    assert.equal(await readFile(join(directory, 'ambiguous.txt'), 'utf8'), 'tok\ntok\n');
  });
});

test('edit_file performs exact replacement and falls back to fuzzy matching', async () => {
  await withWorkspace(async (directory) => {
    const context: ToolContext = { cwd: directory };
    await writeFile(join(directory, 'plain.txt'), 'hello world\n');
    const exact = await editTool.execute({ filePath: 'plain.txt', oldString: 'hello', newString: 'goodbye' }, context) as EditResult;
    assert.equal(exact.match, 'exact');
    assert.equal(await readFile(join(directory, 'plain.txt'), 'utf8'), 'goodbye world\n');

    // The block was copied with a 2-space base indent while the file uses 4/8, so exact fails and fuzzy rescues it.
    await writeFile(join(directory, 'indented.py'), 'class X:\n    def f(self):\n        return 1\n');
    const fuzzy = await editTool.execute({
      filePath: 'indented.py',
      oldString: '  def f(self):\n    return 1',
      newString: '  def f(self):\n    return 42',
    }, context) as EditResult;
    assert.equal(fuzzy.match, 'fuzzy');
    assert.equal(await readFile(join(directory, 'indented.py'), 'utf8'), 'class X:\n    def f(self):\n        return 42\n');

    await assert.rejects(
      editTool.execute({ filePath: 'indented.py', oldString: 'return 42', newString: 'return 42' }, context) as Promise<unknown>,
      /identical/,
    );
    await assert.rejects(
      editTool.execute({ filePath: 'indented.py', oldString: 'absent', newString: 'x' }, context) as Promise<unknown>,
      /not found/,
    );
  });
});
