# blindedit

**审计 coding agent 的会话记录，找出它没读文件就改的地方。**

```bash
git clone https://github.com/kylemarvin884/openbot-blindedit
cd openbot-blindedit
node src/cli.mjs audit ~/.claude/projects/<project>/<session>.jsonl
```

零依赖，Node ≥ 22，不需要 API key，不调用模型。只读你本地的 transcript。

真实输出（`node demo/demo.mjs`，第一段是模拟「没有 read-before-write 守卫」的会话）：

```text
blindedit 0.1.0 — 8 events, 2 reads, 6 writes
transcript  fixtures/blind-session.jsonl  (claude-code)

✗ 2 files written without a prior read
  config/prod.yaml             line 5     overwrite
                               full-content write to an existing file that was never read
  src/checkout.ts              line 7     edit
                               edit applied without reading the file first

✓ 4 writes after a read, 1 file created by the agent

2 risky writes, 0 guard retries → exit 1
```

## 为什么

这不是凭空想的失败模式。Claude Code 的 issue 里写得很直接：

- [#16546](https://github.com/anthropics/claude-code/issues/16546)：
  > "The model generates an edit command with guessed/hallucinated content … burns **double the output tokens** for every file edit"
  高发场景：新会话开始、**上下文压缩之后**、跨文件修改。
- [#25305](https://github.com/anthropics/claude-code/issues/25305)：
  把验证步骤写进 `CLAUDE.md`，会话读了也理解了，仍然跳过验证直接说完成，作者估计 **75% 的使用量花在返工上**。
- [#33781](https://github.com/anthropics/claude-code/issues/33781)：
  「60 passed, 0 failed」的报告建立在把真实 bug 写成预期行为之上，约 60,000 tokens 被浪费。

`blindedit` 不去判断代码对不对，只回答一个能被确定性验证的问题：
**这次会话里，哪些写操作之前根本没有读过那个文件？**

Claude Code 现在有 read-before-write 守卫，盲改多数会被拦下：
失败一次、读文件、再重发一次 edit——浪费的是输出 token。没有这层守卫的 harness
（自建 agent、部分 CLI、Codex 风格日志）则可能真的写进去。两种情况都报，但分开计数。

## 安装

需要 Node ≥ 22。没有构建步骤，也没有依赖。

```bash
git clone https://github.com/kylemarvin884/openbot-blindedit
cd openbot-blindedit
node src/cli.mjs --help
```

想直接当命令用：

```bash
npm install -g .
blindedit audit <transcript.jsonl>
```

## 用法

```bash
# Claude Code 的会话文件（路径以你本机为准）
blindedit audit ~/.claude/projects/my-app/2f1c9a4e.jsonl

# 机器可读，进 CI
blindedit audit session.jsonl --json --fail-on=attempt

# 只看摘要
blindedit audit session.jsonl --quiet
```

| 参数 | 作用 |
| --- | --- |
| `--json` | 输出稳定 JSON，适合管道和 CI |
| `--fail-on=write` | 默认。有成功落地的盲写就 exit 1 |
| `--fail-on=attempt` | 被守卫拦下的无效重试也算失败 |
| `--fail-on=none` | 只报告，不影响退出码 |
| `--root <dir>` | 相对路径的解析与展示基准（默认用 transcript 里的 cwd） |
| `--quiet` | 只打印最后一行 |
| `--no-color` | 关闭 ANSI 颜色 |

退出码：`0` 无违规，`1` 有违规，`2` 参数错误或文件读不了。

## 它检查什么

| 情况 | 判定 | 严重级别 |
| --- | --- | --- |
| `Edit` / `MultiEdit` 成功，但会话里从没读过该文件 | blind edit | ✗ 高危 |
| `Write` 覆盖已有文件（结果标为 `update`），但从没读过 | blind overwrite | ✗ 高危 |
| 写操作被 `File has not been read yet` 类守卫拒绝 | guard retry | ⚠ 浪费 token |
| `Write` 新建文件（结果标为 `create`），之后再编辑 | 正常 | ✓ |
| 先 `Read` 再写；或先 `cat` / `head` / `sed -n` / `Get-Content` 再写 | 正常 | ✓ |
| `Read` 失败（文件不存在）后再写 | 按未读处理 | ✗ 高危 |
| 同一文件在读过之前被重复写 | 合并成一条，带次数 | ✗ 高危 |

「读过」的判定：`Read` / `View` 类工具成功返回，或命令是**单文件**的
`cat` / `head` / `tail` / `bat` / `less` / `more` / `nl` / `sed -n` / `Get-Content`。
带管道、重定向、glob 的命令不计入，避免误报。

## 支持格式

- **Claude Code JSONL**（主要目标，用真实结构的 fixture 覆盖）
- **OpenAI 风格** `tool_calls`
- **通用事件** `{"tool": "...", "input": {...}}`

无法识别格式时不会硬猜：没有 tool call 就 exit 2。

## JSON 输出

```json
{
  "version": "0.1.0",
  "format": "claude-code",
  "events": 8,
  "summary": {
    "reads": 2,
    "writes": 6,
    "coveredWrites": 4,
    "createdFiles": 1,
    "failedWrites": 0,
    "riskyFiles": 2,
    "riskyWrites": 2,
    "attemptFiles": 0,
    "attempts": 0
  },
  "risky": [
    { "path": "config/prod.yaml", "line": 5, "tool": "Write", "mode": "overwrite", "writes": 1 }
  ],
  "attempts": []
}
```

字段名稳定；新增字段只会在小版本里加，不删不改。

## 三个真实用例

1. **夜间无人值守任务的早上验收**：先跑一遍，确认它没有靠猜去改配置文件或 schema，
   再决定要不要合并。
2. **自建 agent / 没有守卫的 harness**：Codex 风格的日志里，`Write` 全量覆盖是真实风险
   （参考 [issue #33781](https://github.com/anthropics/claude-code/issues/33781) 里 60k tokens 的返工）。
   先找出被静默覆盖的文件，再谈加守卫。
3. **把「改前必读」变成可检查的交付标准**：`--fail-on=write` 放进发布前的脚本，
   和测试、lint 一样当门槛；`--fail-on=attempt` 则用来盯无效重试。

## 限制（先说清楚）

- 只覆盖 transcript 里**记录下来的工具调用**。agent 通过自定义脚本改文件、
  或 harness 不记录工具结果，本工具只能标 `write-unknown`，不能断定它没读。
- **「读过」不等于「读懂了」**，更不保证改动正确。本工具不做正确性判断。
- 命令读取只识别单文件形式；`cat a.ts b.ts` 会把两个都算作读过，
  但 `rg pattern src | xargs sed` 这类不算。
- 检测规则目前只有 17 个单元测试和 3 个合成 fixture 做回归，**没有在真实语料上统计
  误报率 / 漏报率（未验证）**。发布时不会编造准确率。
- Claude Code 新版本的守卫会让「成功落地的盲写」变少；这时有价值的是
  guard retry 计数和跨 harness 的审计，不是盲写数量。

## 开发

```bash
npm test        # node --test，17 个测试
npm run demo    # 跑三个 fixture，打印上面的输出
```

## 相关工具

同系列，各管一件事，可以一起用：

- `stalectx`：读过的文件，之后在磁盘上被改了
- `compactaudit`：compaction 摘要丢了哪些约束和路径
- `handoffcheck`：交接文档是否已经过期
- `toolprobe`：OpenAI 兼容端点的 tool calling 是否符合预期

## License

MIT © 2026 Xiao-KL
