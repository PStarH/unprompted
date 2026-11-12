---
title: 模型
description: 在应用里连接兼容 OpenAI 接口的模型，以及这个连接被允许做什么。
---

模型负责解释请求，也可以对照上下文。它不能批准动作、授予权限，或宣布工作已经完成。

## 在应用里连接

运行 `npm start`，然后填写：

- API 接口地址
- 模型 ID
- API 密钥（提供商要求时）

**验证并连接模型**会用一段示例内容发一次结构化请求。只有成功的检查会被保存。密钥写入本机私有设置，不写入工作区记录，API 和事件流也不会返回它。更换接口地址时，不会沿用另一个提供商的密钥。

保存之后，模型按主角色理解请求。规则仍然可以识别请求，模型仍会被调用。原来可以核验的要求继续有效。失败的、或没有依据的解读，不会变成可以执行的动作。

没有模型时，正常模式不会把工作标成就绪。`npm run demo` 是另一套只走规则的模拟。

## 环境变量

由操作者控制进程时，可以设置：

- `UNPROMPTED_MODEL_ROLE=primary`
- `UNPROMPTED_MODEL_BASE_URL`
- `UNPROMPTED_MODEL_NAME`
- 需要时再设置 `UNPROMPTED_MODEL_API_KEY`

适配器期望兼容 OpenAI 的 chat-completions 接口。`UNPROMPTED_MODEL_MAX_CALLS_PER_MINUTE` 限制调用次数。`npm start` 不读取 `.env`。请用 `node --env-file=.env server.js`，或自己导出变量。`--env-file` 需要 Node.js 20.6+。

不设置角色时，仍是辅助模式：只在规则覆盖不到的地方，请模型补充解释。

## Pi 运行时

把 `UNPROMPTED_AGENT_HARNESS` 设为 `pi`，会用 Pi Agent Core 1.4.0 代替默认的 classic 适配器。在 Node.js **22.19+** 上用 `npm ci --include=optional` 安装可选包。接口必须支持流式 chat completions 和函数工具。

Pi 可以在与当前任务相关的文档里做有上限的搜索和阅读。它自带的工具不能发信、不能跑 shell，也不能改权限。每次运行最多四次模型请求、八次工具尝试、60 秒。`npm run eval:pi` 用脚本化响应检查这条集成，不评估模型质量。

## 什么会离开这台机器

远程模型会收到被选中的任务上下文。请自行判断该提供商的策略是否适合你连接的来源。完全本地的演示不会调用模型。连接模型也不会打开连接器的写入。见[权限与隐私](permissions.md)。
