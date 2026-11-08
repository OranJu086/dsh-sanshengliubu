#!/usr/bin/env node
/**
 * demo/wordfreq.test.mjs —— wordfreq 的零依赖测试（node:test + node:assert/strict）。
 *
 * 运行方式（在仓库根）：
 *   node --test demo/wordfreq.test.mjs
 *
 * 覆盖 8 类场景：
 * 1. 大小写合并；
 * 2. 标点与换行分隔；
 * 3. 内部撇号 / 连字符保留；
 * 4. 并列词按 UTF-16 码元升序且结果确定；
 * 5. topWords 默认 n=5 且按次数降序；
 * 6. 空文本与纯标点文本；
 * 7. CLI 端到端（真实 spawn 子进程）；
 * 8. CLI 错误路径（非零退出码 + 非空 stderr）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { countWords, topWords } from './wordfreq.mjs';

/** 被测 CLI 脚本的绝对路径。 */
const SCRIPT_PATH = fileURLToPath(new URL('./wordfreq.mjs', import.meta.url));

/** 子进程的工作目录（demo/），保证相对路径解析稳定。 */
const DEMO_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * 创建一个临时目录并执行回调，结束后在 finally 中强制清理。
 *
 * @param {(tmpDir: string) => void} fn 回调，参数为临时目录绝对路径
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordfreq-'));
  try {
    fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 同步运行一次 CLI。
 *
 * @param {string[]} args 传给脚本的参数列表
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// 1. 大小写合并
// ---------------------------------------------------------------------------
test('大小写合并：The the THE 归并为小写 the，计 3 次', () => {
  const counts = countWords('The the THE');
  assert.equal(counts.get('the'), 3);
  // 不应额外产生大写的键。
  assert.equal(counts.has('The'), false);
  assert.equal(counts.has('THE'), false);
  assert.equal(counts.size, 1);
});

// ---------------------------------------------------------------------------
// 2. 标点与换行分隔
// ---------------------------------------------------------------------------
test('标点与换行分隔：逗号、句号、换行、感叹号都算分隔符，fox 计 4 次', () => {
  const counts = countWords('fox,fox. fox\nfox!');
  assert.equal(counts.get('fox'), 4);
  assert.equal(counts.size, 1);
  // 标点不能被当成单词的一部分。
  assert.equal(counts.has('fox,'), false);
  assert.equal(counts.has('fox.'), false);
});

// ---------------------------------------------------------------------------
// 3. 内部撇号 / 连字符保留
// ---------------------------------------------------------------------------
test("内部撇号与连字符保留：don't 计 2 次，state-of-the-art 计 1 次", () => {
  const counts = countWords("don't don't state-of-the-art");
  assert.equal(counts.get("don't"), 2);
  assert.equal(counts.get('state-of-the-art'), 1);
  assert.equal(counts.size, 2);
  // 不能被拆成 don / t / state / of / the / art。
  assert.equal(counts.has('don'), false);
  assert.equal(counts.has('state'), false);
});

// ---------------------------------------------------------------------------
// 4. 并列词按码元升序且结果确定
// ---------------------------------------------------------------------------
test('并列词按码元升序：z（U+007A）排在 é（U+00E9）之前', () => {
  const counts = countWords('z é');
  assert.equal(counts.get('z'), 1);
  assert.equal(counts.get('é'), 1);
  // 前置校验：两个字符的 UTF-16 码元顺序确实是 z < é。
  assert.ok('z' < 'é');

  const top = topWords(counts);
  assert.deepEqual(top, [
    ['z', 1],
    ['é', 1],
  ]);
  // 显式断言顺序：若实现改用 localeCompare，在 ICU 下会得到 ['é','z']。
  assert.deepEqual(
    top.map(([word]) => word),
    ['z', 'é'],
  );
});

// ---------------------------------------------------------------------------
// 5. topWords 默认 n=5
// ---------------------------------------------------------------------------
test('topWords 默认 n=5：7 个不同频次的词只返回前 5 个，且按次数降序', () => {
  const text = 'a a a a a a a b b b b b b c c c c c d d d d e e e f f g';
  const counts = countWords(text);
  assert.equal(counts.size, 7);

  const top = topWords(counts);
  assert.equal(top.length, 5);
  assert.deepEqual(top, [
    ['a', 7],
    ['b', 6],
    ['c', 5],
    ['d', 4],
    ['e', 3],
  ]);

  // 次数必须单调不增。
  for (let i = 1; i < top.length; i += 1) {
    assert.ok(top[i - 1][1] >= top[i][1]);
  }
});

// ---------------------------------------------------------------------------
// 6. 空文本与纯标点文本
// ---------------------------------------------------------------------------
test('空文本与纯标点文本：返回空 Map / 空数组，不抛异常', () => {
  for (const text of ['', '   ', '\n\n\t', '!!! ,,, --- ... ???', '—— ……']) {
    let counts;
    assert.doesNotThrow(() => {
      counts = countWords(text);
    });
    assert.ok(counts instanceof Map);
    assert.equal(counts.size, 0);
    assert.deepEqual(topWords(counts), []);
  }

  // 未传入文本（undefined）同样安全。
  assert.deepEqual(topWords(countWords(undefined)), []);
});

// ---------------------------------------------------------------------------
// 7. CLI 端到端
// ---------------------------------------------------------------------------
test('CLI 端到端：子进程退出码 0，输出 ≤5 行且为「排名\\t词\\t次数」，首行为最高频词', () => {
  withTempDir((tmpDir) => {
    const tmpFile = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(tmpFile, 'apple apple apple\nbanana banana\ncherry\n', 'utf8');

    const result = spawnSync(process.execPath, [SCRIPT_PATH, tmpFile], {
      cwd: DEMO_DIR,
      encoding: 'utf8',
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `期望退出码 0，实际 ${result.status}；stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'), 'stdout 应以换行结尾');

    const lines = result.stdout.trimEnd().split('\n');
    assert.ok(lines.length > 0, 'stdout 不应为空');
    assert.ok(lines.length <= 5, `stdout 行数应 ≤ 5，实际 ${lines.length}`);

    for (const line of lines) {
      assert.match(line, /^\d+\t.+\t\d+$/);
    }

    // 第一行必须是最高频词（apple 出现 3 次）。
    assert.equal(lines[0], '1\tapple\t3');
    assert.deepEqual(lines, ['1\tapple\t3', '2\tbanana\t2', '3\tcherry\t1']);
  });
});

// ---------------------------------------------------------------------------
// 8. CLI 错误路径
// ---------------------------------------------------------------------------
test('CLI 错误路径：文件不存在、--top 0、--top abc 均非零退出且 stderr 非空', () => {
  withTempDir((tmpDir) => {
    const existingFile = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(existingFile, 'hello hello world\n', 'utf8');
    const missingFile = path.join(tmpDir, 'definitely-missing.txt');

    const cases = [
      { name: '不存在的文件', args: [missingFile] },
      { name: '--top 0', args: [existingFile, '--top', '0'] },
      { name: '--top abc', args: [existingFile, '--top', 'abc'] },
    ];

    for (const { name, args } of cases) {
      const result = runCli(args);
      assert.notEqual(result.status, 0, `${name} 应以非零码退出，实际 ${result.status}`);
      assert.ok(result.stderr.trim().length > 0, `${name} 的 stderr 不应为空`);
      assert.equal(result.stdout, '', `${name} 出错时 stdout 应为空`);
    }
  });
});

// ---------------------------------------------------------------------------
// 附加场景：显式 --top N
// ---------------------------------------------------------------------------
test('CLI 显式 --top N：只输出前 N 行', () => {
  withTempDir((tmpDir) => {
    const tmpFile = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(tmpFile, 'apple apple apple\nbanana banana\ncherry\n', 'utf8');

    const result = runCli([tmpFile, '--top', '2']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');

    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(lines, ['1\tapple\t3', '2\tbanana\t2']);
  });
});
