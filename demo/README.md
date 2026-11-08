# wordfreq —— 零依赖词频统计小工具（中文使用说明）

## 1. 工具简介

`wordfreq` 是一个只依赖 Node.js 内置模块的命令行小工具：读取一个文本文件，统计其中每个单词出现的次数，并按次数从多到少输出前 N 个词（默认前 5 个）。

输出每行三列，用制表符分隔：`<排名>`、`<词>`、`<次数>`，例如：

```
1	fox	3
```

程序同时导出了 `countWords` 与 `topWords` 两个函数（见 `demo/wordfreq.mjs`），也可以被其他 ESM 脚本 `import` 后当库使用：

```js
import { countWords, topWords } from './demo/wordfreq.mjs';

const counts = countWords('The fox. The FOX;');
console.log(topWords(counts, 2)); // [ [ 'fox', 2 ], [ 'the', 2 ] ]
```

## 2. 环境要求

- **Node.js 18 及以上**（本项目实测运行于 v25.8.0，代码只用到 Node 18 已提供的 API）。
- **零第三方依赖**：不需要 `npm install`，`demo/` 下没有 `package.json`，代码只用 `node:fs`、`node:url`、`node:test` 等内置模块。
- 建议先确认版本：

```bash
node -v
```

低于 18 的版本（例如 16.x）不保证可用，请先升级 Node.js。

## 3. 文件清单

| 文件 | 说明 |
| --- | --- |
| `demo/wordfreq.mjs` | 核心程序：词频统计、排序、CLI 参数解析与错误处理，可执行也可 import |
| `demo/wordfreq.test.mjs` | 测试脚本：基于 `node:test`，覆盖统计规则与 CLI 端到端场景 |
| `demo/README.md` | 本文档，中文使用说明 |

除以上三个文件外，本工具不需要任何其他文件；示例文本请放在 `/tmp` 下，不要写进仓库。

## 4. 快速开始

以下命令均在**仓库根目录**（即包含 `demo/` 的那一层）执行。

第一步，把示例文本写入 `/tmp`（`printf` 的 `\n` 会生成真实换行）：

```bash
printf 'The fox. The FOX; a fox tail, the dog.\n' > /tmp/wordfreq-sample.txt
```

第二步，运行工具，只给文件路径，不指定 `--top`（使用默认前 5）：

```bash
node demo/wordfreq.mjs /tmp/wordfreq-sample.txt
```

在 Node.js v25.8.0 上真实运行得到的输出如下（退出码 0）：

```
1	fox	3
2	the	3
3	a	1
4	dog	1
5	tail	1
```

解读：`The`、`The`、`the` 三处大小写不同，统一按小写合并，所以 `the` 计 3 次；`fox`、`FOX`、`fox` 同样合并为 `fox`，计 3 次；`a`、`tail`、`dog` 各 1 次。`fox` 与 `the` 次数相同，`fox` 按码元顺序排在 `the` 前面（详见第 6 节）。

## 5. 参数说明

```
node demo/wordfreq.mjs <文件路径> [--top N]
```

| 参数 | 说明 |
| --- | --- |
| `<文件路径>` | 必填，只能有一个；相对路径以当前工作目录为基准 |
| `--top N` | 可选，输出前 N 个词；`N` 必须是正整数，默认值 `5` |

- 文件路径可以写在 `--top` 之前，也可以写在它之后，例如 `node demo/wordfreq.mjs --top 2 /tmp/wordfreq-sample.txt` 与 `node demo/wordfreq.mjs /tmp/wordfreq-sample.txt --top 2` 等价。
- `--top` 后面的值必须**紧跟** `--top`，且只能出现一次。
- 指定 `--top 2` 时的真实输出：

```bash
node demo/wordfreq.mjs /tmp/wordfreq-sample.txt --top 2
```

```
1	fox	3
2	the	3
```

- `N` 大于不同词的总数时不算错误，只是把能列出的词全部列出。
- 非法取值会报错并以退出码 1 结束（stdout 为空），包括：`0`、负数、小数、非数字、缺值。真实报错示例：

```
错误：--top 的取值必须是正整数，收到 "0"
用法：node demo/wordfreq.mjs <文件路径> [--top N]（N 为正整数，默认 5）
```

```
错误：--top 的取值必须是正整数，收到 "abc"
用法：node demo/wordfreq.mjs <文件路径> [--top N]（N 为正整数，默认 5）
```

```
错误：--top 缺少整数 N
用法：node demo/wordfreq.mjs <文件路径> [--top N]（N 为正整数，默认 5）
```

注意 `1e3`、`1.0`、`+5` 这类写法也算非法，只接受纯十进制正整数（如 `5`、`007` 会按 7 处理）。

## 6. 统计规则

1. **小写归一**：每个词先用 JavaScript 的 `toLowerCase()` 转成小写再计数，因此 `The`、`THE`、`the` 合并为一个词 `the`。
2. **标点切分**：空格、换行、制表符、逗号、句号、分号、感叹号、问号等一切非词内字符都作为分隔符，标点不会进入词中。
3. **内部撇号与连字符保留**：词内部允许出现撇号（`'` 或 `’`）和连字符（`-`），所以 `don't`、`don’t`、`state-of-the-art` 各算一个词，不会被拆成 `don`、`t`、`state`、`of`、`the`、`art`。
4. **不做停用词过滤**：`the`、`a`、`of` 这类虚词照常统计，并可能出现在结果中（示例里 `the` 就排在第 2）。也不剔除短词，也不做词形还原。
5. **并列按 UTF-16 码元升序**：先按次数降序；次数相同时，按小写词的 UTF-16 码元逐个比较（JavaScript 字符串的 `<` 运算符），小的排前面。实现中**刻意不使用 `localeCompare`**，以免不同系统区域设置（locale / ICU）导致排序结果不一致。例如 `z`（U+007A）与 `é`（U+00E9）各出现 1 次时，`z` 排在 `é` 之前；示例中的 `a` < `dog` < `tail` 也是同一规则。
6. **输出格式**：每行 `<排名>\t<词>\t<次数>`，三列之间是**制表符**（不是空格）；排名从 `1` 开始连续编号；每行以 `\n` 结尾；没有表头，没有页脚。
7. **输出行数**：实际行数 = `min(--top, 不同词数)`；空文件或纯标点文本不输出任何内容，但仍以退出码 0 正常结束。

## 7. 限制说明

- **无中文分词**：正则按 Unicode 字母（`\p{L}`）切词，连续汉字会被当作**一个词**。例如 `你好世界 你好` 会得到 `你好世界` 与 `你好` 两个词条，而不是把 `你好世界` 拆成四个字。
- **无词形还原（lemmatization）与词干提取**：`run`、`runs`、`running` 是三个互不相干的词；`apple` 与 `apples` 也不会合并。
- **整文件读入内存**：使用 `readFileSync` 一次性同步读取整个文件，超大文件（数百 MB 以上）会占用同等量级的内存，并可能触发 Node.js 默认的字符串长度上限；统计超大语料请先自行切分。
- **大小写合并只依赖 `toLowerCase()`**：该方法与语言环境无关（不是 `toLocaleLowerCase`），但个别字符的转换结果可能不符合直觉——例如土耳其语大写 `İ` 会转成 `i` + U+0307（组合附加符号），于是 `İstanbul` 与 `istanbul` 在结果里是两个不同的词条。
- 以数字开头的串不完全按“词”处理，例如 `3d` 从 `d` 开始匹配，只统计到 `d`；`abc123` 这类字母开头、内部带数字的词则完整保留。
- 词内连字符仅限 ASCII 半角 `-`，`–`（en dash）、`—`（em dash）不算词内连接符，会起分隔作用。

## 8. 退出码与错误处理

| 退出码 | 含义 | 典型场景 |
| --- | --- | --- |
| `0` | 成功 | 正常输出；空文件、纯标点文本（无输出但成功） |
| `1` | 失败 | 无参数、文件不存在、读取失败、非法 `--top` 等 |

所有错误信息都写到 **stderr**，出错时 **stdout 为空**。真实报错如下：

```
$ node demo/wordfreq.mjs
错误：缺少文件路径
用法：node demo/wordfreq.mjs <文件路径> [--top N]（N 为正整数，默认 5）
（退出码 1）
```

```
$ node demo/wordfreq.mjs /tmp/no-such-file.txt
错误：文件不存在：/tmp/no-such-file.txt（ENOENT: no such file or directory, open '/tmp/no-such-file.txt'）
（退出码 1）
```

```
$ node demo/wordfreq.mjs /tmp
错误：读取文件失败：/tmp（EISDIR: illegal operation on a directory, read）
（退出码 1）
```

其他参数错误（`--top` 重复、未知 `--xxx` 参数、给了两个文件路径）同样以退出码 1 结束，并打印以 `错误：` 开头的中文提示与用法行。

## 9. 测试

测试脚本用 Node.js 内置的 `node:test` + `node:assert/strict` 编写，不引入任何第三方测试框架。在仓库根目录运行：

```bash
node --test demo/wordfreq.test.mjs
```

真实运行结果摘要（Node.js v25.8.0）：

```
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`node --test` 默认使用 spec reporter，所以汇总行以 `ℹ` 开头；如果想看 TAP 形式的汇总（`# pass` / `# fail`），加 `--test-reporter=tap`：

```bash
node --test --test-reporter=tap demo/wordfreq.test.mjs
```

```
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

**结论：9 个测试全部通过（`# pass 9`、`# fail 0`），两种 reporter 下进程退出码均为 0。** 覆盖的场景包括：大小写合并、标点与换行分隔、内部撇号与连字符保留、并列词按码元升序、默认只取前 5、空文本与纯标点、CLI 端到端输出格式、CLI 错误路径（文件不存在 / `--top 0` / `--top abc` 均非零退出）以及显式 `--top N` 只输出前 N 行。
