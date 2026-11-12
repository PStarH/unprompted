---
title: 安装与首次运行
description: 克隆仓库、安装依赖，并用 npm start 启动本地应用。
---

## 环境

- Node.js **20+** 和 npm。建议 **22+**。可选的 Pi 运行时需要 **22.19+**。
- Git，或者把源码压缩包解压后在该目录打开终端。
- 浏览器。
- 模型接口地址、模型 ID，以及提供商要求的 API 密钥。兼容的本地模型可以不填密钥。
- 只有连接某个云端来源时才需要那个账号。本地文件夹不需要账号。Apple 备忘录需要 macOS。

用 `node --version` 确认版本。

## 安装并启动

```sh
git clone https://github.com/PStarH/unprompted.git
cd unprompted
npm ci --include=optional
npm start
```

`npm ci --include=optional` 会安装锁定的 SQLite 运行时，以及可选的 Pi 和 MCP 包。不需要构建前端。

`npm start` 在 **Ready** 之后打印地址，例如 `Ready → http://127.0.0.1:4173/`。打开这个地址。服务只监听本机，没有登录。

4173 被占用时，启动器会另选端口并打印出来。指定端口：

```sh
npm start -- --port 4180
```

你明确指定的端口如果被占用，启动会失败，并提示换一个。不想自动打开浏览器时加上 `--no-open`。

## 连接模型

在第一屏填写接口地址、模型 ID 和 API 密钥。选择**验证并连接模型**。它会用一段示例内容发一次真实请求。失败不会覆盖已经可用的连接。成功后，密钥保存在本机私有设置里，输入框会被清空，不用重启。

`npm start` 不会读取 `.env`。见[模型](models.md)和[配置](configuration.md)。

## 选择一个来源

一个来源就够开始。

- **本地文件夹**读取 Markdown 和文本。选择**选择文件夹**。macOS 会打开系统选择器，其他系统填写绝对路径。不申请完全磁盘访问。
- **Apple 备忘录**仅限 macOS。选择**选择备忘录文件夹**。启动 Unprompted 的应用（通常是终端）需要自动化权限。
- **Google、GitHub、Outlook、Slack 和 Notion**使用你自己的账号。Google 选择**连接 Google**。GitHub 选择**获取授权码**。Outlook、Slack 和 Notion 选择**连接**，再到提供商页面确认。各自读取什么，见[连接器](connectors.md)。

授权后会立刻开始第一次读取，不用重启。数量来自提供商。空结果会保持为空。

## 演示不是正式运行

```sh
npm run demo
```

演示是用完即弃的本地模拟。它不使用已保存的账号，也不访问外部服务。自己的模型和来源请用 `npm start`。

## 启动之后

若要持续观察，让进程保持运行。可以在「连接」里暂停，或选择**现在检查**。来源默认只读。写入、本地存储，以及模型提供商会收到什么，见[权限与隐私](permissions.md)。

页面打不开时，看[故障排查](troubleshooting.md)。
