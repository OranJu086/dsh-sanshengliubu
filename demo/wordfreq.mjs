#!/usr/bin/env node
/**
 * demo/wordfreq.mjs —— 零依赖词频统计小工具（ESM，Node 18+）。
 *
 * 既可以被 import 当作库使用，也可以直接作为 CLI 运行：
 *   node demo/wordfreq.mjs <文件路径> [--top N]
 *
 * 仅使用 node: 内置模块，不依赖任何第三方包。
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 单词 token 正则：字母起始，可含内部数字，内部允许撇号/连字符，首尾不带标点。 */
const TOKEN_PATTERN = /\p{L}[\p{L}\p{N}]*(?:['’-]\p{L}[\p{L}\p{N}]*)*/gu;

/** CLI 默认展示的条数。 */
const DEFAULT_TOP = 5;

/** CLI 用法说明（出现在参数错误提示中）。 */
const USAGE = '用法：node demo/wordfreq.mjs <文件路径> [--top N]（N 为正整数，默认 5）';

/** 参数错误：与文件读取错误区分开，便于输出不同的中文提示。 */
class UsageError extends Error {}

/**
 * 统计一段文本中的单词频次。
 *
 * 规则：
 * - token 由 TOKEN_PATTERN 决定（见上）；
 * - 所有 token 统一转小写后合并计数；
 * - 不做停用词过滤，不剔除短词；
 * - 连续汉字会被当成一个 token，不做中文分词（见 README 的限制说明）。
 *
 * @param {string} text 待统计文本
 * @returns {Map<string, number>} 小写单词 → 出现次数
 */
export function countWords(text) {
  const counts = new Map();
  if (typeof text !== 'string' || text.length === 0) {
    return counts;
  }

  // 每次调用新建正则对象，避免带 g 标志的 lastIndex 状态在调用之间残留。
  const tokenRe = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    const word = match[0].toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * 取出现次数最多的若干单词。
 *
 * 排序规则：次数降序；次数相同时按小写词的 UTF-16 码元升序比较。
 * 这里刻意不使用 localeCompare，避免 ICU / locale 差异导致结果不稳定。
 *
 * @param {Map<string, number>} counts countWords 的返回值
 * @param {number} [n=5] 返回条数，必须是正整数；非法值返回空数组
 * @returns {Array<[string, number]>} 形如 [['fox', 3], ...]
 */
export function topWords(counts, n = DEFAULT_TOP) {
  if (!(counts instanceof Map)) {
    return [];
  }
  const limit = Number.isInteger(n) && n > 0 ? n : 0;
  if (limit === 0) {
    return [];
  }

  const entries = [...counts.entries()];
  entries.sort((a, b) => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    const wa = a[0];
    const wb = b[0];
    // 按 UTF-16 码元比较，固定写法，避免 locale 相关行为。
    return wa < wb ? -1 : wa > wb ? 1 : 0;
  });
  return entries.slice(0, limit);
}

/**
 * 解析 CLI 参数。
 *
 * 规则：
 * - 第一个不以 -- 开头的参数是文件路径；
 * - --top 后必须紧跟一个正整数，且只能出现一次；
 * - 出现第二个文件路径、未知 -- 参数、缺少 N、N 非正整数都视为非法参数。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ filePath: string, top: number }}
 */
function parseArgs(argv) {
  const filePaths = [];
  let top = DEFAULT_TOP;
  let hasTop = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--top') {
      if (hasTop) {
        throw new UsageError('--top 参数重复');
      }
      const value = argv[i + 1];
      if (value === undefined) {
        throw new UsageError('--top 缺少整数 N');
      }
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        throw new UsageError(`--top 的取值必须是正整数，收到 "${value}"`);
      }
      top = Number(value);
      hasTop = true;
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new UsageError(`未知参数 "${arg}"`);
    }

    filePaths.push(arg);
    if (filePaths.length > 1) {
      throw new UsageError('只能指定一个文件路径');
    }
  }

  if (filePaths.length === 0) {
    throw new UsageError('缺少文件路径');
  }

  return { filePath: filePaths[0], top };
}

/** CLI 主流程：解析参数、读取文件、输出 `<排名>\t<词>\t<次数>`。 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let text;
  try {
    text = readFileSync(options.filePath, 'utf8');
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? '文件不存在' : '读取文件失败';
    const detail = error && error.message ? `（${error.message}）` : '';
    process.stderr.write(`错误：${reason}：${options.filePath}${detail}\n`);
    process.exitCode = 1;
    return;
  }

  const rows = topWords(countWords(text), options.top);
  // 空文件或没有可用词：stdout 不输出，正常退出（exit code 0）。
  if (rows.length === 0) {
    return;
  }

  const lines = rows.map(([word, count], index) => `${index + 1}\t${word}\t${count}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

// 只有被直接执行时才运行 CLI；被 import 或 node -e 导入时不执行、不抛错。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
