# dsh-codex-import

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue.svg)](cordis.patch.yml)
[![Node](https://img.shields.io/badge/Node-18%2B-blue.svg)](https://nodejs.org/)

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 Codex CLI/Desktop 的对话导入 DSH，成为 `dsh-tui` 里可以列出、resume 并继续对话的会话。Codex 与 DSH 的会话格式互不相通，两边都读不了对方的历史。

> Codex 的思维链在服务端加密，无法解密；只有其中的明文摘要可以还原，本插件会把它导入。

## 它做什么

- **按会话归并 rollout 分段。** 一个对话会拆成多个共享 `session_id` 的 `rollout-*.jsonl`；文件 mtime 不能代表对话时间，文件名后缀也不等于 session id。
- **转换成 DSH session v3 会话日志** —— turn、step、消息、工具调用与结果、思考摘要、图片。
- **尽可能还原思考过程。** Codex 把 reasoning 存成服务端密钥的 Fernet 令牌，但其中约三分之一的记录另带明文 `summary`，会被转成 `reasoning` 块。
- **把附图接入 DSH 附件库**，使其能在会话记录里渲染，也能重新送到模型面前。
- **剔除 Codex 自己注入的上下文**（`<recommended_plugins>`、`<environment_context>`、`<skill>`、`# AGENTS.md instructions` 等），让首轮内容和会话标题是真人说的话。
- **用 harness 自己的校验器逐一验证，再加一道工具调用配对检查，全部通过后**才写入会话库。已存在的会话绝不覆盖。
- **生成回滚清单**，一条命令即可撤销一次导入。

## 安装

在仓库根目录执行：

```sh
dsh plugin --profile dsh-tui add "file:$PWD"
```

pnpm 的 `file:` 协议会把包**拷贝**进 profile 而不是建软链，因此安装副本与仓库相互独立。由于包声明了 `dsh.bundle.patch`，CLI 会自动把它追加进 `dsh.profile.bundles`，无需其他配置。卸载用 `dsh plugin --profile dsh-tui remove dsh-codex-import`。

装完**重启 `dsh-tui`** —— 插件在启动时挂载。

## 使用

在 `dsh-tui` 会话里：

```
/import-codex --list               # 先看有什么，再决定导什么
/import-codex                      # 同样是列出 —— 不给范围就不写入
/import-codex --since-hours 168    # 最近一周
/import-codex --session <id>       # 指定某个 Codex session id（可重复）
/import-codex --max-tool-output 4000  # 换取更小的会话（代价是细节减少）
/import-codex --dry-run            # 只转换并校验，不写入
/import-codex --force              # 连你在 DSH 里继续过的会话也刷新（破坏性）
/import-codex --help
```

裸敲 `/import-codex` 是**列出**而不是全量导入 —— 范围应该由人来定。列表会给出每个对话的完整 session id、时间跨度、工作目录和开场提问。时间窗按**文件名里的时间戳**选取，而不是 mtime —— Codex 会回写旧 rollout，几个月前的文件也可能带着今天的 mtime。

同样的能力也可以脱离 harness，直接在 shell 里用：

```sh
node bin/import-codex.mjs list    --since-hours 168
node bin/import-codex.mjs convert --since-hours 24 --out /tmp/import-check
node bin/import-codex.mjs verify  /tmp/import-check
node bin/import-codex.mjs sync    --since-hours 24      # 直接同步进 $DSH_HOME/sessions
```

`convert` 只写出一个目录就停下，方便先人工检查；`sync` 是同一条流水线对准真实 sessions 根目录：先转换到临时目录 → 校验 → 再逐个会话对齐。两者都会直接打开附件库，所以 CLI 和 `/import-codex` 一样能导入图片。

## 重复导入是增量的

同一个对话再导一次是安全的；没变化时几乎不花代价。每个会话都会和**当次重新转换的结果**按事件流摘要比对，于是只会落到四种结果之一：

| | 行为 |
| --- | --- |
| 尚未导入 | 安装。 |
| 内容逐字节相同 | **完全不写**。没变化的重复运行不会碰任何文件。 |
| 内容不同 | **原地刷新** —— session id 与目录都不变，所以 `/resume` 列表和工作区状态继续有效。Codex 侧新增的轮次、以及早于某次转换器改动导入的会话，都靠这条路径补齐。 |
| 不是本导入器写的文件 | **完全不碰**。 |

最后一条最关键。DSH 是**每批事件追加一个 zstd 帧**，所以你在 DSH 里继续过的会话已经不是两帧日志了；重写它会删掉你自己的轮次。反过来，仍是两帧、但摘要与本导入器记录的不一致，说明有别的什么东西重写过它，同样不碰。`--force` 可以覆盖这个保护，它按设计就是破坏性的。若某次转换拿不到附件库（会把图片弄丢），也会被拒绝，而不会允许它覆盖一个本来就带图片的日志。

全程不删除任何东西，也不会把一个对话导入两次：刷新是替换文件，目录、目录里的其他文件、以及 session id 都保留。

## 保留什么，丢弃什么

| | 结果 |
| --- | --- |
| 消息、工具调用与结果 | **完整导入**。若需要更小的会话，可用 `--max-tool-output N` 把每条工具输出截断到 N 字符；默认 0，即全部保留。 |
| 思维链 | 只有明文 `summary`，覆盖率约三分之一。其余是 OpenAI 服务端密钥的 Fernet 令牌，任何客户端都读不了。 |
| 图片 | **会导入**，经附件库。只会如实报告，绝不静默丢弃。 |
| Codex 注入的上下文 | 丢弃。但 `# Files mentioned by the user:` 是**拆壳**而非丢弃 —— 它内部裹着真人的原始提问。 |
| 压缩标记、world state、token 计数、子 agent 信封 | 丢弃：属于上下文管道，不是对话内容。只存在于压缩 `replacement_history` 里的消息会被捞回来。 |
| Codex 工具名（`exec`、`shell` 等） | 原样保留为历史供模型阅读，但在 DSH 里不可调用。 |

导入的图片只有在**当前模型支持图片**时才真正可见。模型目录条目若未声明 `inputModalities`，会默认为纯文本，harness 会在请求发出前把图片替换成
`[image omitted because this model accepts text only; attachment sha256:…]` —— 导入本身仍然正确，但 agent 会说自己看不到图片。
`deepseek-flash` 与 `deepseek-v4-flash-vision-exp` 声明了 `["text","image"]`；`deepseek-v4-flash` 和 `deepseek-v4-pro` 没有。
另注意 `acp` profile 写死使用 `deepseek-v4-flash`，所以**通过 ACP 验证图片会得到假阴性**。

## 格式为什么这么讲究

DSH 会**三次**校验会话日志，而较弱的检查并不足够 —— 一个导入可以正常列出、正常 resume，却在下一轮对话失败。下面五条规则每一条都是被真实校验器抓出来后补上的，现在都由 `lib/verify.js` 强制检查：

1. 第一个 zstd 帧必须**恰好只装 header 这一行**。
2. 有四类事件属于 surface-eligible，必须带 `surfaceOp` 标记。
3. 每条消息事件都必须带非空字符串 `id`。
4. `assistant/message` 必须带数字 `turn`、数字 `step`，以及 `stream` 数组。
5. 每个工具结果都必须在 assistant 消息上有一条配对的 `tool-call` **内容块** —— provider 是从内容块里读 `tool_calls`，而不是从 `tool/call` 事件。

完整契约见 [`docs/formats.md`](docs/formats.md)：物理布局、事件映射、全量 Codex 记录清单，以及图片和 session id 为什么必须那样处理。

## 环境要求

- 已安装 `dsh-tui` profile 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Node.js 18+（插件运行在 harness 内）
- Codex 数据位于 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）

## 开发

因为是拷贝安装，改了代码不会自动生效：

```sh
scripts/reinstall.sh          # 重新拷贝进 dsh-tui profile，然后重启 dsh-tui
```

`scripts/reinstall.sh <profile>` 可指定其他 profile。重复执行 `dsh plugin add` 会原地刷新已有的 `file:` 依赖，不需要先 remove。

测试跑在真实 Codex 语料和一次性的 `DSH_HOME` 上，不需要 mock，也不会留下残留：

```sh
npm test              # 先测对齐行为，再测组装后的 /import-codex 命令本体
node scripts/test-sync.mjs --keep     # 保留临时目录以便排查
```

`test-sync.mjs` 覆盖确定性、安装、无变化重跑、原地刷新、两种拒绝、`--force` 与图片保护；`test-plugin.mjs` 按 harness 的方式组装插件并真正调用命令处理器 —— 斜杠命令才是实际使用的入口，其他测试都到不了那里。

改动 `lib/convert.js` 或 `lib/verify.js` 之前，请先读 [`docs/formats.md`](docs/formats.md)。`DSH_CODEX_IMPORT_SELFTEST=<path>` 会让插件把命令注册结果写进文件 —— 这是唯一无头确认命令已注册的办法，因为 `dsh-acp` 不解析斜杠命令，`acp` profile 也不会加载其他 profile 的 bundle。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
