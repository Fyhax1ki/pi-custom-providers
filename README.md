# pi-custom-providers

Pi Coding Agent 扩展：**Provider Manager**。用来管理第三方 Provider 和 OpenAI / Anthropic 兼容的中转站。

它**不重新实现任何 AI API**。所有配置都写进 Pi 自己的 `~/.pi/agent/models.json`，然后由 Pi 负责校验、请求转换、流式输出、tool calling 和 usage 统计。这个扩展只做「管理」这件事。

## 安装

```bash
# 单次会话试用
pi -e /path/to/pi-custom-providers

# 作为本地包安装
pi install /path/to/pi-custom-providers

# 从 git 安装
pi install git:github.com/<you>/pi-custom-providers
```

然后在 Pi 里运行：

```
/providers
```

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

**优先级**：中转站自己返回的 metadata → models.json 里已有的值 → models.dev 补缺。models.dev 只填**缺失**字段，不会覆盖你或中转站给出的数据。

**API Key**：支持三种来源，同一时间只保留一个

1. 存在 `auth.json`（默认，和 `/login` 一样）
2. `models.json` 的 `apiKey` 写 `$ENV_VAR` 引用环境变量
3. `models.json` 的 `apiKey` 写 `!command`，用命令输出作为 key

## 它写哪些文件

| 文件 | 用途 |
|---|---|
| `~/.pi/agent/models.json` | Provider / 模型定义（唯一数据源，Pi 原生读取） |
| `~/.pi/agent/auth.json` | 存储的 API Key（和 `/login` 共用，文件权限 0600） |
| `~/.pi/agent/provider-manager.json` | 边车文件：Pi 没有对应字段的信息（tool calling、family、发布日期等） |
| `~/.pi/agent/provider-manager-modelsdev.json` | models.dev 目录缓存（默认 7 天，离线可用） |

写入 `models.json` 时会先做结构校验，写入后立即让 Pi 重新加载；如果 Pi 拒绝该文件，会自动回滚到上一版内容。

## 注意事项

- **写回 `models.json` 会丢失文件里的 `//` 和 `/* */` 注释**（读取时是容忍的）。
- 存储 key 会直接写 `auth.json` 文件，没有走 Pi 的加锁写入路径；如果你同时在别的终端跑 `/login`，理论上存在并发覆盖的窗口。
- 输入 API Key 时是明文回显的（扩展 UI 没有 secret 输入框）。
- Provider id 如果和内置 Provider 重名，模型会被**追加/覆盖到内置 Provider** 上，而不是创建一个独立 Provider。这种情况下扩展会先警告。
- 如果设置了 `PI_OFFLINE`，不会联网拉取 models.dev，只使用本地缓存。

## 开发

```bash
npm install --offline   # 首次：typescript / @types/node / pi 类型
npm run typecheck
pi -e ./src/index.ts
```

改完源码在会话里用 `/reload`。

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 扩展入口，注册 `/providers` 命令 |
| `src/manager.ts` | 全部交互流程（菜单、增删改、测试、发现模型） |
| `src/store.ts` | 持久化：`models.json` 读写与校验、`auth.json`、边车 metadata |
| `src/modelsdev.ts` | models.dev 目录：拉取、缓存、索引、字段映射 |
| `src/endpoint.ts` | 中转站 `GET /models` 发现（复用 Pi 的 key/header 解析） |
| `src/types.ts` | 共享类型与常量 |

几条容易踩的坑：

- **不要用 `pi.registerProvider()` 注册这些 provider。** `models.json` 的 `models` 是「新增/覆盖同名模型」，扩展注册是「整体替换该 provider 的模型列表」；混用会把同名内置 provider 的模型清空。统一靠写文件 + `modelRegistry.refresh()`。
- **不要往 `models.json` 写 Pi schema 不认识的字段。** Pi 无对应字段的信息（tool calling、family、发布日期等）写到边车文件。
- **Key 同一时间只能有一个来源**：`auth.json` 或 `models.json` 的 `$ENV` / `!command` / 字面量。
