# pi-custom-providers

Pi Coding Agent 扩展：**Provider Manager**。用来管理第三方 Provider 和 OpenAI / Anthropic 兼容的中转站。

它**不重新实现任何 AI API**。所有配置都写进 Pi 自己的 `~/.pi/agent/models.json`，然后由 Pi 负责校验、请求转换、流式输出、tool calling 和 usage 统计。这个扩展只做「管理」这件事。

## 安装

```bash
# 从 npm 安装（推荐）
pi install npm:@fyhax1ki/pi-custom-providers

# 从 git 安装（Pi 会自己 clone 一份）
pi install git:github.com/Fyhax1ki/pi-custom-providers

# 指定用户级或项目级：默认用户级（所有项目生效），加 -l 只写到当前项目的 .pi/settings.json
pi install npm:@fyhax1ki/pi-custom-providers -l
```

临时试用单次会话，不改配置：

```bash
pi -e npm:@fyhax1ki/pi-custom-providers
```

然后在 Pi 里运行：

```
/providers
```

卸载：`pi remove npm:@fyhax1ki/pi-custom-providers`。

## 功能

**Provider**

- 添加 / 编辑 / 删除 Provider
- 管理 API Key、Base URL、附加 Headers
- 选择 API 协议：`openai-completions`、`openai-responses`、`anthropic-messages`
- **测试连接**：用该 Provider 真实发一次请求，走 Pi 官方的 streaming 实现
- **从端点自动获取模型**：请求中转站的 `GET /models`，支持 OpenAI / Anthropic / 裸数组等返回格式

**模型**

- 自动获取 / 手动添加 / 删除 / 刷新
- 编辑 metadata：context window、max output tokens、reasoning、input modalities、价格
- **用 models.dev 补充缺失信息**：context window、max output tokens、reasoning、tool calling、modalities、pricing

**模型列表可滚动、可搜索。** 使用“未添加”“已配置”“本地保留”等文字状态，不再使用装饰图标。输入关键字即可筛选，上下键选择，Enter 添加单个；添加后保留筛选词和选中位置，方便继续选择。列表行数随终端高度调整，批量操作（添加全部 / 同步）也在同一列表底部。

模型发现支持 `has_more` / `last_id`、`next_cursor` 和同源下一页链接。发现分页不完整、游标异常或无效条目时，只允许添加，不提供删除同步。同步会预览新增、移除、更新的模型，再一次性保存最终结果。

> 为什么不能直接用 Pi 的 `ctx.ui.select`：它把所有选项一次性渲染成行，而主屏模式的视口固定在底部——列表超过终端高度时标题会被顶出屏幕。中转站动辄返回几百个模型，所以这里用了一个基于 pi-tui `SelectList` 的自定义组件。该组件仅在 TUI 模式可用，RPC / print 模式会自动降级成选项菜单。

**优先级**：中转站自己返回的 metadata、models.json 里已有的值、models.dev 补缺。同步时会更新端点返回的参数；models.dev 只填**缺失**字段。精确模型 ID 优先，歧义匹配不会静默选取，免费模型的零价格也可补全。

models.dev 的价格和模型限制是**目录参考信息**，不代表中转站实际计费和限制，请核对供应商说明。即使主配置已完整，工具调用能力等边车元数据仍可补全。

**API Key**：支持以下来源，同一时间只保留一个

1. 存在 `auth.json`（默认，和 `/login` 一样）
2. `models.json` 的 `apiKey` 写 `$ENV_VAR` 引用环境变量
3. `models.json` 的 `apiKey` 写 `!command`，用命令输出作为 key
4. 直接写入 `models.json` 字面量（不推荐明文保存到可共享的配置中）

## 它写哪些文件

| 文件 | 用途 |
|---|---|
| `~/.pi/agent/models.json` | Provider / 模型定义（唯一数据源，Pi 原生读取） |
| `~/.pi/agent/auth.json` | 存储的 API Key（和 `/login` 共用；POSIX 下每次写入均使用 0600） |
| `~/.pi/agent/provider-manager.json` | 边车文件：Pi 没有对应字段的信息（tool calling、family、发布日期等） |
| `~/.pi/agent/provider-manager-modelsdev.json` | models.dev 目录缓存（默认 7 天，离线可用） |

保存前先做结构校验和并发修改检查；写入后立即让 Pi 重新加载。凭据切换、删除和模型同步将相关文件纳入同一次变更流程；写入或刷新失败时尝试补偿回滚。如果回滚时发现其他会话的新修改，会保留新修改并明确报告冲突，而不是覆盖它。

每个文件采用临时文件加原子重命名；跨文件流程是**失败补偿**，不是数据库事务，不能保证进程崩溃或断电时跨文件原子性。

## 操作

- **列表**：上下键选择（或直接打字筛选）、Enter 确认、Esc 返回上一层
- **向导**（添加 provider / 添加模型）：Enter 下一步、**Esc 返回上一步**；只有在第一步按 Esc 才取消整个流程
- 「API key」那一步 **留空回车 = 跳过**
- **网络操作**：TUI 下按 Esc 取消目录加载、模型发现或连接测试；保存操作一旦开始，不在中途取消。

每一步都会显示阶段，例如 `添加 provider  2/5，供应商名称（my-relay）`；子菜单带面包屑，例如 `my-relay / 模型（3 个）`。

添加 provider 的五个步骤：`provider id → 供应商名称 → API 协议 → Base URL → API key`。供应商名称可以填中文，留空则用 id。

改动会立即写进 `models.json`（带校验和回滚）并让 Pi 重新加载，不需要重启。

## 注意事项

- **写回 `models.json` 会丢失文件里的 `//` 和 `/* */` 注释**（读取时是容忍的）。
- 配置写入使用 Node 内置能力实现目录锁；`auth.json.lock` 的空目录及心跳方式与当前开发宿主 Pi 0.99.1 的锁协议一致，不引用宿主的私有依赖。等待锁超时会报错，不自动抢占陈旧锁。若崩溃后锁持续存在，请先确认没有写入进程，再检查对应的 `.lock` 目录。
- 不遵守文件锁的外部编辑器仍可能产生竞态；扩展会检查文件版本并尽量避免覆盖。Windows 文件访问权限由目录 ACL 决定，不能把 POSIX 的 0600 等同于 Windows ACL。
- 输入 API Key 时是明文回显的（扩展 UI 没有 secret 输入框）。
- Provider id 如果和内置 Provider 重名，模型会被**追加/覆盖到内置 Provider** 上，而不是创建一个独立 Provider。这种情况下扩展会先警告。
- 如果设置了 `PI_OFFLINE`，不会联网拉取 models.dev，只使用本地缓存。

## 开发

```bash
npm run typecheck       # 使用已安装的本地 TypeScript
npm test                # Node 内置测试运行器；模拟端点，不请求真实模型
npm run check           # 类型检查和全部测试
pi -e ./src/index.ts
```

测试使用原生 TypeScript 加载，需要 Node.js 22.18+（或 24.x）。测试只在项目内创建临时目录，结束后清理。依赖安装不包含在检查命令中；需要安装时应先确认，并仅在项目目录内执行。当前 API 兼容性以开发宿主 Pi 0.99.1 为基准，未验证任意宿主版本。

运行时新增依赖为零：`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 都是 **peerDependencies**（由 Pi 宿主提供），只作为 devDependencies 装到本地供类型检查。

改完源码在会话里用 `/reload`。

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 扩展入口，注册 `/providers` 命令 |
| `src/manager.ts` | 全部交互流程（菜单、增删改、测试、发现模型） |
| `src/store.ts` | 持久化校验、并发冲突检测、跨文件变更和失败补偿 |
| `src/file-io.ts` | Node 内置文件操作：安全临时文件、原子写入、目录锁 |
| `src/model-operations.ts` | 不依赖 UI 的模型合并与同步计算 |
| `src/picker.ts` | 可搜索、保留状态、适配窗口高度的列表 |
| `src/progress.ts` | 可取消的网络操作提示 |
| `src/wizard.ts` | 支持返回上一步的向导 |
| `tests/` | 文件保存、菜单操作、模型目录、发现与交互回归测试 |
| `src/modelsdev.ts` | models.dev 目录：拉取、缓存、索引、字段映射 |
| `src/endpoint.ts` | 中转站 `GET /models` 发现（复用 Pi 的 key/header 解析） |
| `src/types.ts` | 共享类型与常量 |

几条容易踩的坑：

- **不要用 `pi.registerProvider()` 注册这些 provider。** `models.json` 的 `models` 是「新增/覆盖同名模型」，扩展注册是「整体替换该 provider 的模型列表」；混用会把同名内置 provider 的模型清空。统一靠写文件 + `modelRegistry.refresh()`。
- **不要往 `models.json` 写 Pi schema 不认识的字段。** Pi 无对应字段的信息（tool calling、family、发布日期等）写到边车文件。
- **Key 同一时间只能有一个来源**：`auth.json` 或 `models.json` 的 `$ENV` / `!command` / 字面量。
