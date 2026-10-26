// Only authored UI literals are translated. Interpolated mail, names and evidence stay untouched.
const messages = {
  "请填写注册应用的公开 Client ID，不要填写访问令牌或密钥。": "Enter the registered public Client ID, not an access token or secret.",
  "复制授权码并登录": "Copy code and sign in to",
  "此处保留前 8000 个字符，完整正文请在 GitHub 查看。": "The first 8,000 characters are stored here. View the complete text on GitHub.",
  "GitHub issue 有了新的状态，已记录跟进。": "A GitHub issue changed. Its tracking record was updated.",
  "授权无法开始。请检查已注册的 Client ID，并为应用开启设备授权。": "Authorization could not start. Check the registered Client ID and enable device authorization for the app.",
  "连接常用工具": "Connect everyday tools",
  "等待完成授权": "Waiting for authorization",
  "已连接 · 只读": "Connected · read-only",
  "已连接 · 按授权行动": "Connected · authorized actions",
  "尚未连接": "Not connected",
  "读取 Gmail 和 Google Docs，关联邮件请求与文档证据。": "Read Gmail and Google Docs, connecting requests with their evidence.",
  "发现分配给你的 issue，持续跟进负责人和状态变化。": "Find issues assigned to you and follow assignment and state changes.",
  "读取 Outlook 收件箱，从邮件中发现需要跟进的工作。": "Read your Outlook inbox and discover work that needs following up.",
  "{count} 个活跃 issue": "Active issues: {count}",
  "{count} 封邮件 · {tasks} 项工作": "Emails read: {count} · Work discovered: {tasks}",
  "授权没有完成，可以重新连接。": "Authorization did not finish. You can connect again.",
  "授权码已过期，重新连接会生成新的授权码。": "The code expired. Connect again to get a new one.",
  "本次授权已取消，已有连接与工作记录保留。": "Authorization cancelled. Existing connections and work records are retained.",
  "授权已保存，重试应用连接即可，无需重新登录。": "Authorization is saved. Retry applying the connection without signing in again.",
  "复制授权码，在官方页面粘贴并确认。完成后会自动开始观察。": "Copy the code, paste it on the official page and confirm. Observation starts automatically when you finish.",
  "复制授权码": "Copy code",
  "打开官方授权页面": "Open official sign-in page",
  "正在确认账号身份并应用连接。": "Verifying your account and applying the connection.",
  "应用 Client ID": "Application Client ID",
  "发行版尚未预置此应用。自托管时只需填写一次注册应用的公开 Client ID，不需要访问令牌或 Client Secret。": "This distribution has no preconfigured app. For self-hosting, enter the registered public Client ID once. No access token or client secret is needed.",
  "此连接只读取内容，不发送或修改。工作上下文可能交给你选择的模型理解。": "This connection reads only, with no sending or editing. Work context may be sent to your selected model.",
  "通过官方 OAuth 连接": "Connect with official OAuth",
  "管理连接": "Manage connection",
  "断开连接": "Disconnect",
  "连接": "Connect",
  "应用已保存的连接": "Apply saved connection",
  "连接你每天使用的工具": "Connect the tools you use every day",
  "选择一个来源就能开始，后续随时增加。账号授权后直接生效。": "Start with one source and add more whenever you need. Account authorization takes effect immediately.",
  "需要先连接工作来源": "Connect a work source first",
  "持续观察": "Continuous observation",
  "保存观察设置": "Save observation settings",
  "查看最近一次同步错误": "View the last sync error",
  "授权码已复制，在官方页面粘贴即可。": "Code copied. Paste it on the official sign-in page.",
  "请选择上方授权码并复制。": "Select and copy the code above.",
  "连接一个工作来源后，我会读取授权内容并发现值得跟进的事情。": "Connect a work source to read authorized context and discover useful follow-ups.",
  "连接自己的模型和常用工具，开始处理真实工作。": "Connect your own model and everyday tools to start working with real context.",
  "当前不会自动留意 已连接来源的变化。": "Automatic observation of connected sources is paused.",
  "我无法确认 已连接来源的最新状态。": "The latest state of connected sources is not confirmed.",
  "正在检查 已连接来源的最新变化。": "Checking the latest changes in connected sources.",
  "已停止跟进": "Tracking stopped",
  "跟进已分配的 issue": "Following assigned issue",
  "来源状态或你的选择已停止本次跟进；这不代表 Agent 完成了工作。": "Tracking stopped because of the source state or your choice. This is not a verified agent completion.",
  "这个 issue 当前分配给你。我会留意状态和负责人变化。": "This issue is assigned to you. I will follow its state and assignment changes.",
  "负责人": "Assignee",
  "在 GitHub 查看": "View on GitHub",
  "暂不跟进": "Stop following for now",
  "连接器只读，不会评论、关闭或修改 issue。": "The connector is read-only. It does not comment, close or edit issues.",
  "管理 Outlook 连接": "Manage Outlook connection",
  "调整读取来源": "Change read sources",
  "更新读取来源会恢复只读。需要发送或修改时，可以重新开启行动权限。": "Updating read sources restores read-only access. Enable action permissions again when you need sending or editing.",
  "更新读取范围": "Update read access",
  "复制回复草稿": "Copy reply draft",
  "回复草稿已复制。": "Reply draft copied.",
  "浏览器无法自动复制，请在回复正文中选择并复制。": "Automatic copying is unavailable. Select and copy the reply text.",
  "让 Agent 开始照看你的工作。": "Let your agent start following your work.",
  "开启经你批准的 Gmail 发送": "Enable approved Gmail replies",
  "等待首次检查": "Waiting for the first check",
  "开始首次检查": "Run the first check",
  "当前不会自动留意 Google Workspace 的变化。": "Automatic checks for Google Workspace are paused.",
  "最后成功观察：{time}。重新开启自动观察或手动同步后，我会核对新变化。": "Last successful check: {time}. Resume observation or check now to review new changes.",
  "观察已过期": "Observation out of date",
  "观察需要检查": "Check observation",
  "我无法确认 Google Workspace 的最新状态。": "The latest Google Workspace state is not confirmed.",
  "最后成功观察：{time}。新变化未知；下次同步成功后才会恢复正常照看。": "Last successful check: {time}. New changes are unknown until the next successful check.",
  "最近一次观察失败。保留已有记录；自动观察会在下个周期重试。": "The last check failed. Existing records are retained; automatic observation retries next cycle.",
  "正在同步": "Syncing",
  "正在检查 Google Workspace 的最新变化。": "Checking the latest Google Workspace changes.",
  "首次同步完成后会按设置间隔继续观察。": "After the first check, observation continues at your selected interval.",
  "这次跟进有帮助吗？": "Was this follow-up useful?",
  "原因，可选": "Reason, optional",
  "共同依赖": "Shared dependency",
  "补丁应用后已读回核验。": "The applied patch was read back and verified.",
  "这件事已更新，请重新打开后操作。": "This work has changed. Open it again before acting.",
  "连接模型和 Google 后，这里会显示真实来源与读取状态。": "Connect your model and Google to see your real sources and reading status here.",
  "正在读取本地连接设置。": "Loading your connection settings.",
  "已读取邮件": "Emails read",
  "已读取文档": "Documents read",
  "发现的工作": "Work discovered",
  "连接自己的工作环境": "Connect your own workspace",
  "连接 Google，让 Agent 从你的工作中发现事情。": "Connect Google to start finding work that needs your attention.",
  "开启 Gmail API": "Enable Gmail API",
  "开启 Drive API": "Enable Drive API",
  "发现的工作已经放在下方。你可以查看来源和下一步。": "Your discovered work is below, with its sources and next steps.",
  "已检查目前读取到的内容，暂未发现有依据的待办。有新变化时会继续核对。": "The content read so far has been checked. No supported tasks were found; new changes will be checked as they arrive.",
  "继续 Google 授权": "Continue Google authorization",
  "取消连接": "Cancel connection",
  "部分工作未完成模型读取。检查模型连接后可以重新核对。": "Some work could not be read by your model. Check the model connection, then retry.",
  "重新核对工作": "Recheck work",
  "最近成功观察": "Last successful check",
  "首次观察正在开始。": "Your first check is starting.",
  "关闭页面后仍会观察，本地服务需要保持运行。": "Checks continue with this page closed while the local service is running.",
  "管理连接与观察": "Manage connections and observation",
  "让 Agent 读取什么？": "What should the agent read?",
  "首次读取最近 3 天的邮件，之后跟进新邮件。": "Start with the last 3 days of email, then follow new messages.",
  "首次读取最多 20 份近期文档，之后跟进变化。": "Start with up to 20 recent documents, then follow changes.",
  "连接后持续观察": "Keep observing after connecting",
  "立即检查一次，之后默认每 5 分钟检查变化，可以随时暂停。": "Check once immediately, then every 5 minutes by default. Pause at any time.",
  "读取的工作内容会交给你选择的模型理解。首次只申请读取，发送邮件和修改文档另行开启。": "Work content is sent to your selected model. Start with read access; enable sending and document changes separately.",
  "首次自托管：准备 Google 连接": "One-time setup for a self-hosted Google connection",
  "当前发行版没有预置 Google 客户端。完成下面一次性设置后，后续只需选择账号。": "This distribution has no preconfigured Google client. Complete these steps once; future connections only need account selection.",
  "开启所需 API": "Enable the APIs you need",
  "设置使用者": "Set who can use the connection",
  "打开 OAuth 使用者设置": "Open OAuth audience settings",
  "外部测试应用需要将自己的 Google 账号加入测试用户。": "For an external testing app, add your Google account as a test user.",
  "下载桌面客户端": "Download the desktop client",
  "创建 OAuth 客户端": "Create an OAuth client",
  "应用类型选择 Desktop app，下载 JSON 后回到这里。": "Choose Desktop app, download its JSON, then return here.",
  "遇到 Google 设置问题？": "Need help with Google setup?",
  "请在同一个 Google Cloud 项目中完成以上设置。测试状态的授权可能在 7 天后需要重新连接。": "Use the same Google Cloud project for all steps. Testing authorizations may need reconnecting after 7 days.",
  "Google 官方连接说明": "Google’s connection guide",
  "Google 连接由启动环境管理。账号、权限和访问范围以启动设置为准。": "Your launch environment manages this Google connection, including its account, permissions and access.",
  "选择或拖入客户端 JSON": "Choose or drop the client JSON",
  "只读取 Google Desktop 客户端配置，文件保留在你的设备上。": "Import the Google Desktop client configuration locally on your device.",
  "发送与文档修改权限": "Sending and document changes",
  "允许申请 Gmail 发送权限": "Request Gmail sending access",
  "允许申请 Google Docs 修改权限": "Request Google Docs editing access",
  "开启后只执行你在具体行动中批准或约定的操作。Google Docs 修改需要同时保留文档读取权限。": "Only actions you approve or authorize will run. Google Docs editing also requires document read access.",
  "开启所选行动权限": "Enable selected actions",
  "允许执行我已授权的发送与修改": "Allow sending and changes I have authorized",
  "立即生效；每次执行仍会核对授权范围和最新证据。": "Applies immediately. Each action still checks your authorization and current evidence.",
  "保存行动权限": "Save action permissions",
  "开启 Google Docs API": "Enable Google Docs API",
  "持续观察变化": "Keep observing changes",
  "关闭网页后继续运行；退出本地服务后暂停。": "Continue with the page closed; pause when the local service exits.",
  "检查间隔": "Check interval",
  "应用已保存的 Google 连接": "Apply saved Google connection",
  "连接详情与诊断": "Connection details and diagnostics",
  "检查账号授权": "Check account authorization",
  "重新连接 Google": "Reconnect Google",
  "断开后停止读取和执行，已观察到的本机工作记录会保留。": "Disconnecting stops reads and actions. Previously observed work stays on this device.",
  "断开 Google": "Disconnect Google",
  "连接用于理解工作的模型": "Connect a model to understand your work",
  "支持兼容接口和本地模型。连接后，再选择让 Agent 读取的工作环境。": "Use a compatible API or a local model, then choose the workspace your agent can read.",
  "等待工作环境": "Waiting for your workspace",
  "模型已准备好，下一步连接你的工作环境。": "Your model is ready. Connect your workspace next.",
  "连接 Google 后会立即读取授权内容，主动发现有依据的工作。": "Connect Google to read authorized content and discover work supported by its sources.",
  "连接后，你的真实工作会出现在这里。": "Your real work will appear here after connecting.",
  "无需手动创建任务；Agent 会从授权环境中发现值得跟进的事。": "No manual task entry. The agent discovers follow-ups from your authorized workspace.",
  "Google 已断开": "Google disconnected",
  "已停止读取与执行。重新连接后继续，已有工作记录保留。": "Reads and actions have stopped. Reconnect to continue; your work records are retained.",
  "连接自己的模型与 Google，开始处理真实工作。": "Connect your own model and Google to start working with your real context.",
  "等待连接真实工作环境": "Waiting for your workspace connection",
  "至少选择一个读取来源。": "Choose at least one source to read.",
  "请选择小于 64 KB 的 Google Desktop 客户端 JSON。": "Choose a Google Desktop client JSON smaller than 64 KB.",
  "这是 Web 类型的客户端。请创建 Desktop app 类型并重新下载 JSON。": "This is a Web client. Create a Desktop app client and download its JSON.",
  "文件不是有效的 Google Desktop 客户端配置。请重新下载 Desktop app JSON。": "This is not a valid Google Desktop client configuration. Download the Desktop app JSON again.",
  "行动权限已更新并立即生效。": "Your action permissions are updated and active.",
  "每次请选择一个客户端 JSON 文件。": "Choose one client JSON file at a time.",
  "Google 已断开，读取和执行均已停止。可以随时重新连接。": "Google is disconnected. Reads and actions have stopped. You can reconnect at any time.",
  "连接 Google": "Connect Google",
  "导入并连接 Google": "Import and connect Google",
  "重试同步": "Retry sync",
  "现在检查": "Check now",
  "正在连接 Google": "Connecting Google",
  "等待连接 Google": "Waiting for Google",
  "正在读取你的工作环境": "Reading your workspace",
  "连接需要处理": "Connection needs attention",
  "正在核对发现的工作": "Checking discovered work",
  "模型读取需要处理": "Model reading needs attention",
  "正在进行首次观察": "Running your first check",
  "自动观察已暂停": "Automatic checks paused",
  "观察状态已过期": "Observation is out of date",
  "正在照看你的工作": "Following your work",
  "在 Google 窗口选择账号并允许读取，完成后这里会自动连接。": "Choose your account and allow read access in the Google window. This workspace connects automatically when you finish.",
  "正在切换到你的真实工作空间，无需重启。": "Connecting your real workspace. No restart needed.",
  "Google 授权已失效。重新连接即可继续，已有工作记录会保留。": "Google authorization has expired. Reconnect to continue; your work records are retained.",
  "Google 项目尚未开启所需 API。开启后点击「重试同步」。": "Your Google project has not enabled the required API. Enable it, then choose Retry sync.",
  "Google 拒绝读取部分内容。检查所选权限，以及组织管理员是否允许此应用。": "Google denied access to some content. Check selected permissions and whether your organization allows this app.",
  "Google 暂时限制了请求。稍后会再次观察，也可以手动重试。": "Google is temporarily limiting requests. Checks will resume later; you can also retry manually.",
  "暂时无法连接 Google。检查网络后重试，已有记录会保留。": "Google cannot be reached. Check your network and retry; existing records are retained.",
  "这次观察未完成。可以重试，或展开详情查看原因。": "This check did not finish. Retry, or open connection details to see the reason.",
  "Google 没有授予全部所选权限。重新连接并勾选需要的读取权限。": "Google did not grant all selected permissions. Reconnect and select the read access you need.",
  "未能确认 Google 账号身份。请重新选择账号并授权。": "Your Google account identity could not be verified. Select your account and authorize again.",
  "Google 未提供持续访问授权。请在 Google 账号中移除旧授权后重新连接。": "Google did not grant persistent access. Remove the previous grant in your Google account, then reconnect.",
  "Google 授权交换未完成。检查网络与客户端配置后重新连接。": "The Google authorization exchange did not finish. Check your network and client setup, then reconnect.",
  "组织管理员限制了此应用。请联系管理员允许所需的 Google 访问。": "Your organization restricts this app. Ask your administrator to allow the required Google access.",
  "你取消了这次授权。准备好后可以继续连接。": "You cancelled authorization. Connect again when you are ready.",
  "Google 授权已过期。准备好后重新连接即可。": "Google authorization timed out. Connect again when you are ready.",
  "授权已保存。点击应用连接后继续。": "Authorization is saved. Apply the connection to continue.",
  "你的工作空间正在连接，请稍后再试。": "Your workspace is connecting. Try again shortly.",
  "真实模型 · 样例工作区": "Connected model · sample workspace",
  "连接模型后开始样例工作流；真实环境需另行接入。": "Connect a model to start the sample workflow. Connect your real workspace separately.",
  "模型会实际理解请求；当前上下文和发送使用模拟数据。": "Your model interprets the requests. Context and delivery in this workspace are simulated.",
  "等待模型连接": "Waiting for a model",
  "连接模型后，才会开始理解上下文。": "Connect a model to start understanding the context.",
  "当前没有运行模型推理。请先完成上方连接。": "Model reasoning is not running. Connect your model above to begin.",
  "连接模型后，我会在授权的范围内跟进。": "After connecting, I'll follow through within your authorized scope.",
  "模型请求失败，请检查连接。": "The model request failed. Check the connection.",
  "示例工作区 · 使用已连接的模型": "Sample workspace · using your connected model",
  "模型提供方拒绝了 Key 或模型权限，请检查后重试。": "The model provider rejected the key or model access. Check your API key and permissions.",
  "模型提供方限流或额度不足，请检查提供方账户。": "The model provider is rate limited or has insufficient quota. Check your provider account.",
  "模型请求未完成，请检查接口地址、模型 ID 和结构化响应支持。": "The model request did not complete. Check the endpoint, model ID and structured-response support.",
  "模型已响应，但没有返回所需的有依据结构。请选择支持结构化响应的模型。": "The model responded but did not return the requested grounded structure. Choose a model supporting structured responses.",
  "模型连接": "Model connection",
  "先连接你的模型，开始真正的 Agent 体验。": "Connect your model to start the agent.",
  "模型已连接": "Model connected",
  "模型已配置，尚未通过连接验证": "Model configured, connection not yet verified",
  "接口地址": "API endpoint",
  "模型 ID": "Model ID",
  "本地模型可留空": "Optional for local models",
  "已保存在本机，留空保持不变": "Saved locally; leave blank to keep it",
  "粘贴提供方的 API Key": "Paste your provider's API key",
  "高级选项": "Advanced options",
  "推理内核": "Reasoning harness",
  "Key 只保存在本机。测试使用虚构内容；连接后，任务上下文会发送给所选模型。": "Your key is stored locally. The check uses invented content; after connecting, task context is sent to your selected model.",
  "验证并连接模型": "Verify and connect model",
  "移除本机模型连接": "Remove local model connection",
  "使用自己的 API Key · 支持兼容接口和本地模型": "Your API key · compatible APIs and local models",
  "次模型请求": "model requests",
  "未连接时不会宣称模型正在工作。规则演示可单独运行 npm run demo。": "The model is not connected yet. The separate rule-based example is available with npm run demo.",
  "模型请求需要检查": "Check model connection",
  "真实请求已验证": "Real request verified",
  "等待连接": "Not connected",
  "更换模型或连接设置": "Change model or connection",
  "正在发送测试请求…": "Sending a test request…",
  "模型真实请求已验证，连接已生效。": "The real model request passed. Your connection is now active.",
  "本机模型连接已移除。": "The local model connection was removed.",
  "模型由启动环境配置。修改环境变量并重启，或移除它们后在这里连接。": "Your launch environment controls this model. Update it and restart, or remove those settings to connect here.",
  "没有匹配的请求 · 未采取行动": "No matching request · no action taken",
  "忽略旧版本 · 保留较新的版本": "Older revision ignored · newer version kept",
  "从上下文中发现新请求": "New request discovered from context",
  "文档已保留，供后续请求核对": "Document available for future requests",
  "已观察，尚无有依据的任务": "Observed without a supported task",
  "演示进展": "Demo progress",
  "本地演示 · 无需连接账号": "Local demo · no account needed",
  "不用给我任务。看看接下来会发生什么。": "No task prompt. Watch what happens next.",
  "约 15 秒：一封请求到来，文档逐渐更新，我会自己关联和核对。": "About 15 seconds: a request arrives, a document changes, and I connect the context and check the evidence.",
  "发现了该跟进的事，正在等齐证据。": "I found the follow-up. The evidence isn't ready yet.",
  "没有让你补写提示词，也不会因为文档有变化就直接宣布完成。": "No extra prompt needed. A document change alone won't count as completion.",
  "证据齐了。看过回复，再决定是否发送。": "The evidence is ready. Review the reply and make the call.",
  "文档由演示环境更新。我核对了要求和最新结果，并准备好回复。": "The demo environment updated the document. I checked the requirements and latest results, then prepared a reply.",
  "回复已发送，模拟回执已核验。": "Reply sent. Simulated receipt verified.",
  "这是模拟回执，不是真实发送。你可以查看结果、换个场景，或开始自己的工作区。": "This is a simulated receipt. Inspect the result, replay the story, or try your own workspace.",
  "已按你的选择停止，不会替你发送。": "Stopped as you chose. No reply will be sent.",
  "你随时可以选择不做。重播演示可以重新体验完整过程。": "You can always choose not to act. Replay to try the full story again.",
  "结果还没确认，我会保留不确定性。": "The outcome is still uncertain. I'll keep that visible.",
  "先核对执行结果，再决定下一步。不会盲目重试。": "Check what happened before deciding the next step. No blind retries.",
  "主动发现": "Notice the work",
  "核对证据": "Check evidence",
  "核验结果": "Verify the result",
  "查看核验结果": "See verified result",
  "查看准备好的回复": "Review prepared reply",
  "开始自己的工作区": "Try your own workspace",
  "开发者：运行第一个场景": "Developers: run your first scenario",
  "再体验一次": "Replay the story",
  "开始照看你自己的工作": "Start with your own work",
  "这是用完即清理的演示空间。退出演示，启动个人工作区后再连接账号，设置才会保留。": "This demo workspace is disposable. Start your personal workspace before connecting an account so your settings are kept.",
  "回到终端，按 Ctrl+C 退出演示。": "Return to the terminal and press Ctrl+C to stop the demo.",
  "运行": "Run",
  "重新打开终端显示的网址，在这里连接 Google。默认只读。": "Open the address shown in the terminal, then connect Google here. It starts read-only.",
  "查看连接指南": "Read the connection guide",
  "处理这个选择": "Review the decision",
  "接下来": "Next",
  "调整跟进": "Adjust follow-up",
  "查看结果": "View outcome",
  "当前进展已同步。": "Current progress is synced.",
  "回复已更新，这次没有发送。": "The reply changed. Nothing was sent this time.",
  "请看过新内容后再发送。": "Review the updated content before sending.",
  "{count} 件事在等这个条件": "{count} tasks are waiting on this",
  "优先级与依据": "Priority and reasons",
  "重新核对的时间": "When to check again",
  "到 {when} 时重新核对": "Check again at {when}",
  "处理 {count} 个选择": "Review {count} decisions",
  "检查连接与观察": "Check connection and monitoring",
  "重新同步": "Sync again",
  "还没确认这次操作的结果。": "This action's outcome is not confirmed yet.",
  "先同步进展，再决定下一步，避免重复操作。": "Sync progress before deciding what to do next, to avoid repeating the action.",
  "你不用守着这里。": "You don't need to stay here.",
  "只要本地服务在运行，关闭此页面也会继续跟进。": "While the local service is running, I'll keep following up with this page closed.",
  "任务详情已更新": "Task details updated",
  "工作台": "Overview",
  "需要你": "Needs you",
  "发生过什么": "Activity",
  "连接与上下文": "Connections",
  "相处方式": "Working together",
  "跳到工作台": "Skip to workspace",
  "工作空间导航": "Workspace navigation",
  "Unprompted 工作台": "Unprompted workspace",
  "我的工作空间": "My workspace",
  "你的日常": "Your day",
  "工作空间": "Workspace",
  "少一点操心。": "A little less to manage.",
  "多一点自己的时间。": "A little more time for you.",
  "你的私人空间": "Your personal workspace",
  "本地运行": "Running locally",
  "正在连接": "Connecting",
  "查看键盘快捷键": "Keyboard shortcuts",
  "事情在推进，你可以专注。": "Things are moving. Stay focused.",
  "我会照看值得跟进的事，只在需要你时开口。": "I'll follow through on what matters and ask when your judgment helps.",
  "正在了解工作空间": "Getting to know your workspace",
  "连接后，真实进展会显示在这里。": "Your progress will appear once connected.",
  "我在照看的事": "What I'm looking after",
  "不用重新交代，有变化我会接着跟进。": "No need to repeat yourself. I'll follow up when things change.",
  "查看动态": "View activity",
  "筛选任务": "Filter tasks",
  "进行中": "Ongoing",
  "已结束": "Finished",
  "实时更新": "Live updates",
  "正在连接你的工作空间": "Connecting to your workspace",
  "任务会随着环境变化自然出现。": "Tasks appear as meaningful changes happen.",
  "刚刚发生": "Recent progress",
  "等待第一条动态": "Waiting for the first update",
  "不需要决策的进展，安静地留在这里。": "Progress that needs no decision stays quietly here.",
  "工作搭档与需要你的事": "Your partner and decisions",
  "你的工作搭档": "Your work partner",
  "连接中": "Connecting",
  "在背景里照看，在需要时出现。": "Looking after things in the background. Here when needed.",
  "正在照看": "Looking after",
  "已核验完成": "Verified complete",
  "调整相处方式": "How we work together",
  "本地工作空间": "Local workspace",
  "正在读取运行环境。": "Checking this workspace.",
  "重新体验演示": "Replay demo",
  "只留真正需要你的。": "Just the decisions that need you.",
  "上下文已经备好，你只需要做选择。": "The context is ready. Make the call when you're ready.",
  "事情是这样推进的。": "Here's how things moved forward.",
  "发现、核对、行动与结果，都有迹可循。": "See what was noticed, checked, done and verified.",
  "环境里的变化": "Changes in your workspace",
  "Agent 的跟进": "How I followed through",
  "查看工作记录与效果": "Work records and outcomes",
  "从你已经在做的事开始。": "Start with the work you're already doing.",
  "Agent 根据已连接的环境发现变化，关联上下文。": "I notice changes and connect context from your connected sources.",
  "已经观察到的上下文": "Context already available",
  "约定好，少打扰。": "Agree once. Less back-and-forth.",
  "让熟悉的跟进自然发生，需要判断时再一起决定。": "Let familiar follow-ups happen. Make the judgment calls together.",
  "了解、核对和准备，我会自己做。": "I'll investigate, check and prepare on my own.",
  "发送回复可以由你当次决定，也可以为某个明确的项目和交付物约定自动跟进。证据不完整时仍会等待，来源冲突时仍会请你判断。": "Choose each reply, or allow future follow-ups for a specific project and deliverable. I'll still wait for missing evidence and ask about conflicting sources.",
  "已约定的自动跟进": "Your standing agreements",
  "可以随时改回逐次确认。修改不会撤回已经发送的回复。": "Change an agreement at any time. This won't recall replies already sent.",
  "有件事我没有注意到？": "Did I miss something?",
  "告诉我漏看了什么。这会记录反馈，不会直接创建任务。": "Tell me what I overlooked. This records feedback without creating a task.",
  "漏看的事情": "What I missed",
  "例如：那份报告已经更新，却没有跟进。": "For example: the report changed, but there was no follow-up.",
  "在哪里看到的": "Where you saw it",
  "（可选）": "(optional)",
  "邮件、文档或其他位置": "An email, document or another source",
  "记录反馈": "Save feedback",
  "留一点注意力给自己。": "Keep a little attention for yourself.",
  "任务详情": "Task details",
  "关闭详情": "Close details",
  "轻一点的操作": "A lighter way to work",
  "关闭快捷键": "Close shortcuts",
  "回到工作台": "Go to overview",
  "查看需要你的事": "Open your decisions",
  "点击任务可查看完整证据与跟进过程。": "Open a task to see its evidence and full progress.",
  "待跟进的请求": "A request to follow up",
  "刚刚发现": "Just noticed",
  "从收到的请求中发现了值得跟进的事，正在关联上下文。": "I noticed a request worth following up and am connecting its context.",
  "正在核对": "Checking",
  "正在关联相关文档，核对这次请求需要的结果。": "I'm finding the relevant documents and checking the requested results.",
  "等待变化": "Waiting for an update",
  "还有 ": "Still missing: ",
  " 项要求缺少证据。文档更新后，我会继续核对。": " requirements. I'll check again when the document changes.",
  "还没有足够的证据。相关内容更新后，我会接着跟进。": "There isn't enough evidence yet. I'll pick this up when the context changes.",
  "内容已核对，回复已备好。你可以直接发送，或约定今后的自动跟进。": "The evidence is checked and the reply is ready. Send this one or agree on future follow-ups.",
  "核验结果中": "Verifying the result",
  "行动已经发起，正在向提供方核实结果。尚未标记完成。": "The action has started. I'm checking the result with the provider before marking it complete.",
  "已向 Gmail 核实发送结果，这件事已跟进完成。": "Gmail confirmed delivery. This follow-up is complete.",
  "回复已进入本地模拟发件箱，并核验了模拟回执。": "The reply is in the local simulated outbox and its receipt is verified.",
  "需要判断": "Needs a decision",
  "行动结果尚未确认，需要先核实，再决定下一步。": "The result isn't confirmed. Let's check what happened before deciding what comes next.",
  "已关闭": "Closed",
  "这件事已停止跟进，没有发送回复。": "This follow-up is closed. No reply was sent.",
  "已搁下": "Set aside",
  "你已放下这份回复，没有发送。": "You've set this reply aside. Nothing was sent.",
  "状态待核实": "Status unknown",
  "查看记录，了解当前进展。": "Open the record to see the latest available progress.",
  "状态待同步": "Reconnecting",
  "连接暂时中断，正在重新同步。": "The connection dropped. Reconnecting now.",
  "下方保留上次收到的进展，连接恢复后会自动更新。": "You're seeing the last received progress. It will update when reconnected.",
  "处理中": "Working",
  "我在推进 ": "Moving things forward · ",
  " 件事。": " open",
  "另有 ": "Decisions waiting for you · ",
  " 个选择需要你，已放在「需要你」。": ". The context is in Needs you.",
  "正在核对上下文和结果，你可以先忙自己的。": "I'm checking the context and results. You can carry on with your day.",
  "等待你": "Your call",
  " 个选择需要你，其余的我来照看。": " to decide. I'll look after the rest.",
  "上下文和下一步已经备好，不用从头了解。": "The context and next step are ready. No need to start from scratch.",
  "我在等 ": "Waiting for an update · ",
  " 件事的下一步变化。": " open",
  "现在没有正在执行的动作。证据更新后会继续，不需要你催。": "Nothing is running right now. I'll continue when the evidence changes.",
  "空闲 · Idle": "Idle",
  "现在没有待推进的事，安心忙你的。": "All clear. You can get on with your day.",
  "工作空间有值得跟进的变化时，我会再接着做。": "I'll pick things up when there's a meaningful change.",
  "回复已经准备好": "The reply is ready",
  "回复备好了，要发出去吗？": "The reply is ready. Send it?",
  "当前为只读模式，回复保留在这里。": "This workspace is read-only. Your draft stays here.",
  "将通过 Gmail 发送给下方收件人。": "This will send through Gmail to the recipient below.",
  "这次发送只写入本地模拟发件箱。": "This writes only to the local simulated outbox.",
  "收件人：": "To: ",
  "主题：": "Subject: ",
  "看一眼回复内容": "Read the reply",
  "查看当前连接方式": "See connection settings",
  "发送这次回复": "Send reply",
  "发送模拟回复": "Send simulated reply",
  "本次发送，今后自动": "Send & allow future follow-ups",
  "这次不用了": "Don’t send this",
  "「今后自动」仅适用于 ": "Future follow-ups only cover ",
  " 的后续回复，可在「相处方式」收回。": ". Revoke this in Working together at any time.",
  "存在多个可能的来源，这次需要单独判断。": "There are competing sources. This reply needs your judgment.",
  "先确认上次行动的结果": "Check the previous action first",
  "提供方尚未确认结果，我没有自动重试。": "The provider hasn't confirmed the result. I haven't retried automatically.",
  "核实发送结果": "Check delivery",
  "已确认未发送，重试": "Confirmed not sent — retry",
  "发现请求": "Request noticed",
  "关联上下文": "Context linked",
  "结果已核验": "Result verified",
  "核对要求": "Requirements checked",
  " 项要求已核对": " requirements checked",
  "正在了解请求的上下文": "Understanding the request",
  "主动发现 · 持续跟进": "Noticed and followed through",
  "任务进展": "Task progress",
  "查看依据": "See the evidence",
  "来自邮件": "From email",
  "已观察的请求": "Observed request",
  " 的详情": " details",
  "查看 ": "Open ",
  "风险判断": "Risk to consider",
  "时间安排": "Timing",
  "了解你的习惯": "Your preferences",
  "值得考虑": "Worth considering",
  "约定跟进范围": "Agree on a scope",
  "下一步怎么做": "What's next",
  "一个选择": "A decision",
  "优先看看": "Worth looking at soon",
  "方便时看看": "When you're ready",
  "为什么需要我？": "Why does this need me?",
  "发生了什么": "What happened",
  "为什么值得关注": "Why it matters",
  "已经核对": "Already checked",
  "仍不确定": "Still uncertain",
  "依据": "Evidence",
  "从邮件里发现了一件需要跟进的事": "Noticed a follow-up in your email",
  "相关内容有更新，已重新核对": "Relevant context changed. Checked it again.",
  "忽略了一次与当前任务无关的更新": "Left an unrelated update alone",
  "忽略了旧版本，保留较新的内容": "Kept the newer version",
  "记下了一份可供核对的文档": "Noted a document for future reference",
  "观察到一条新的环境变化": "Noticed a new change",
  "已从 Gmail 确认发送结果": "Delivery confirmed by Gmail",
  "已核验本地模拟回执": "Local simulated receipt verified",
  "还没有新的变化。不需要额外操作。": "No new changes. Nothing you need to do.",
  "该项目的全部交付物": "All deliverables in this project",
  "证据充分时自动发送后续回复": "Automatically follow up when the evidence is complete",
  " 约定": " agreed",
  "改为逐次确认": "Ask me each time",
  "还没有自动发送的约定。准备好的回复里，可以选择「本次发送，今后自动」。": "No standing agreements yet. Choose “Send & allow future follow-ups” on a ready reply.",
  "运行环境还未同步。": "Workspace details haven't synced yet.",
  "连接需要检查": "Check connection",
  "本地模拟": "Local simulation",
  "已配置": "Configured",
  "使用本地场景提供邮件与文档变化。": "Email and document changes come from the local scenario.",
  "从已配置的来源同步变化，实际结果见工作记录。": "Syncs changes from your configured sources. See activity for results.",
  "只读": "Read-only",
  "按约定行动": "Acts within your agreements",
  "本地模拟环境": "Local simulation",
  "读取已授权的邮件与文档；发送受运行配置和你的约定约束。": "Reads authorised email and documents. Sending follows your setup and agreements.",
  "邮件、文档和发送均在本机模拟，不会发给真实联系人。": "Email, documents and sending are simulated on this device. No real contacts receive anything.",
  "当前运行方式只允许观察和准备。": "This setup allows reading and preparation only.",
  "连接中断，暂时无法确认最新状态。": "Disconnected. The latest state is not yet confirmed.",
  " 件事": " open",
  " 件": " verified",
  "这些任务暂时不需要你": "No decisions on these tasks",
  "需要判断时，我会把上下文一起带来。": "When your judgment is needed, I'll bring the context with it.",
  "完成的事会留在这里": "Finished work will stay here",
  "每次行动核验结果后，才会标记完成。": "An action is only marked complete once its result is verified.",
  "现在没有待推进的事": "Nothing waiting to move forward",
  "我会留意工作空间里的变化。你不需要为了让我工作而找事。": "I'll watch for meaningful changes. No need to find something for me to do.",
  "现在没有需要你的事": "Nothing needs your decision",
  "该跟进的我会继续跟进。你可以放心离开这里。": "I'll keep following through. It's fine to leave this page.",
  "最近更新 ": "Updated ",
  "留给你的一个选择": "A decision for you",
  "回复已准备好，方便时看一眼就好。": "The reply is ready. Take a look when it suits you.",
  "先核实上次行动的结果，再决定下一步。": "Check the previous result before deciding what to do next.",
  "看看是什么": "Take a look",
  "暂时没有需要你的事": "Nothing needs you right now",
  "有值得判断的事，我会告诉你。": "I'll bring the next decision here.",
  "已连接真实工作环境": "Connected to your workspace",
  "正在体验本地演示": "You're in the local demo",
  "Google 授权已从本进程断开": "Google authorization is disconnected from this process",
  "已停止同步并禁用外部写入。真实工作记录仍保留；重新授权需要重启本地服务。": "Sync has stopped and external writes are disabled. Real workspace records remain; restart the local service to authorize again.",
  "Google 已断开；真实工作区记录保留": "Google is disconnected; real workspace records are preserved",
  "本进程已断开 Google；同步和外部写入已停止": "Google is disconnected for this process; sync and external writes are stopped",
  "已移除本机授权，并立即停止本进程的同步与外部写入。重启并重新授权后才能连接。": "The local authorization was removed, and this process stopped syncing and writing immediately. Restart and authorize again to reconnect.",
  "当前只读，自动观察与准备，不会对外发送。": "Read-only: I can observe and prepare, but nothing is sent.",
  "根据当前配置和已约定的范围行动，结果会核验。": "Actions follow your setup and agreements. Results are verified.",
  "使用模拟邮件与文档，不会发给真实联系人。": "Simulated email and documents. Nothing goes to real contacts.",
  "已连接 Google Workspace": "Google Workspace connected",
  "本地模拟空间": "Local demo workspace",
  "操作未完成，请稍后再试。": "This didn't complete. Please try again.",
  "反馈已记录。": "Feedback saved.",
  "回复已发送，结果已核验。": "Reply sent and verified.",
  "已发起发送，结果仍需核实。": "Sending started. The result still needs checking.",
  "已搁下这次回复，没有发送。": "Reply set aside. Nothing was sent.",
  "已重试并向提供方核实结果。": "Retried and checked with the provider.",
  "已向提供方核实结果。": "Checked the result with the provider.",
  "已关闭这件事，没有发送回复。": "Follow-up closed. No reply was sent.",
  "约定已记录，会在明确的范围内行动。": "Agreement saved. I'll act within that scope.",
  "选择已记录，尚未自动启动新工作。": "Decision saved. No new work has been started.",
  "已记下你的选择。": "Your choice is saved.",
  "反馈已记录，不会直接创建任务。": "Feedback saved. No task was created.",
  "演示已重新开始，新的变化会自动出现。": "Demo restarted. New changes will arrive on their own.",
  "这件事的自动跟进范围还不够明确。": "The scope for automatic follow-ups isn't clear enough yet.",
  "发送结果尚未确认，暂未开启今后的自动跟进。": "Delivery isn't confirmed. Future follow-ups haven't been enabled.",
  "本次已发送并核验，今后会在约定范围内自动跟进。": "Sent and verified. Future follow-ups can run within your agreement.",
  "这项约定已更新，请刷新后查看。": "This agreement has changed. Sync to see the latest version.",
  "这项约定已改为逐次确认。": "This agreement now asks you each time.",
  "本次已发送，但自动跟进未保存：": "This reply was sent, but the standing agreement wasn't saved: ",
  "服务暂时没有返回工作空间。": "The workspace isn't responding yet.",
  "无法载入工作空间：": "Couldn't load your workspace: ",
  "实时连接": "Live",
  "收到的状态无法读取，正在等待下一次更新。": "This update couldn't be read. Waiting for the next one.",
  "重新连接中": "Reconnecting",
  "暂时无法连接工作空间": "Can't connect to the workspace yet",
  "服务恢复后会自动重试。请确认本地服务仍在运行。": "I'll retry when it's available. Check that the local server is running.",
  "这里保留请求、来源、核对依据与完整记录。首页只呈现当前最有用的下一步。": "The request, sources, checks and full record are here when you need them.",
  "完整来源、证据与行动记录": "Full sources, evidence and action history",
  "行动与核验": "Action and verification",
  "不再跟进这件事": "Close this follow-up",
  "正在处理…": "Working…",
  "同步状态": "Sync status",
  "操作没有完成，先同步当前状态。": "This didn't finish. Sync the current status first.",
  "查看具体原因": "See what happened",
  "恢复跟进": "Restore follow-up",
  "已恢复跟进，已重新核对当前证据。没有发送回复。": "Follow-up restored and current evidence checked. Nothing was sent.",
  "撤销": "Undo",
  "稍后再看": "Later",
  "30 分钟后再看": "Set aside for 30 minutes",
  "只暂收起这台设备上的提醒，Agent 仍会照看。": "Hides the reminder on this device. I'll keep looking after the task.",
  "已暂收起，30 分钟后再显示。": "Set aside for 30 minutes on this device.",
  "现在查看": "Show now",
  "稍后处理": "Set aside for later",
  "已备好，按你的安排稍后再看。": "Ready when you are. Set aside for later.",
  "暂收起的任务仍在照看，相关内容变化时会重新出现。": "I'm still looking after these tasks. Changed evidence brings them back sooner.",
  " 到时再看": " · back at that time",
  "自上次离开以来": "Since your last visit",
  "新增任务": "New follow-ups",
  "准备就绪": "Ready for your decision",
  "已完成": "Completed",
  "知道了": "Got it",
  "搜索任务、项目或联系人": "Search tasks, projects or people",
  "没有找到相符的任务": "No matching tasks",
  "试试项目名或联系人，也可以清空搜索。": "Try a project or person, or clear your search.",
  "清空搜索": "Clear search",
  "任务搜索": "Search tasks",
  "等待中，Agent 会在变化后继续。": "Waiting. I'll pick this up when things change.",
  "回复已准备好。": "The reply is ready.",
  "已备好回复，等你方便时决定。": "A reply is ready for your decision.",
  "已保存到本机": "Saved on this device",
  "无法保存本机偏好，当前会话仍可使用。": "Device preferences couldn't be saved. They still work for this session.",
  "返回工作台": "Back to overview",
  "界面语言": "Interface language",
  "搜索": "Search",
  "已设置稍后处理": "Set aside until later",
  "今天的进展，一目了然。": "Your day, in motion.",
  "{count} 个选择需要你，其余的我来照看。": "Ready for your decision · {count}",
  "我在推进 {count} 件事。": "Following through · {count} active",
  "我在等 {count} 件事的下一步变化。": "Waiting for evidence · {count} open",
  "另有 {count} 个选择需要你，已放在「需要你」。": "Decisions waiting for you: {count}. The context is ready in Needs you.",
  "还有 {count} 项要求缺少证据。文档更新后，我会继续核对。": "Checks awaiting evidence: {count}. I’ll check again when the document changes.",
  "你的反馈会帮助我更准确地跟进。": "Your feedback helps me follow through more accurately.",
  "记录这次跟进是否有帮助，便于回看和改进。": "Record whether this follow-up helped, for review and improvement.",
  "逐件处理": "One at a time",
  "全部展开": "Show all",
  "决策显示方式": "Decision view",
  "一次看清一件，后台继续推进。": "One clear decision. Everything else keeps moving.",
  "决策接力": "Decision relay",
  "一个个来，不用全记住。": "One at a time. No need to remember it all.",
  "上一件，只浏览": "Previous decision, browse only",
  "下一件，只浏览": "Next decision, browse only",
  "切换浏览，不会执行操作": "Browse only. No actions are executed.",
  "决策接力中切换浏览": "Browse decisions in the relay",
  "第 {index} 件，共 {total} 件": "Decision {index} of {total}",
  "下一件": "Up next",
  "再下一件": "Then",
  "已完成，并已核验结果": "Done. Result verified.",
  "已搁下，没有发送": "Set aside. Nothing sent.",
  "已关闭，没有发送": "Closed. Nothing sent.",
  "已恢复跟进，没有发送": "Restored. Nothing sent.",
  "结果仍待核实": "The result still needs checking.",
  "收起这条回执": "Dismiss this receipt",
  "依据就在这里": "Evidence, right here",
  "收起证据速览": "Close evidence peek",
  "按住速览 · 点按展开": "Hold to peek · click to open",
  "完整记录": "Full record",
  "{count} 项核对结果有变化": "Checks changed: {count}",
  "文档版本有更新": "Document updated",
  "证据时效有变化": "Freshness changed",
  "来源情况有变化": "Sources changed",
  "核对范围有变化": "Requirements changed",
  "核对结果没有变化": "The checks haven't changed",
  "还没有可核对的具体要求": "No specific requirements to check yet",
  "版本或来源情况已更新，可以切换查看全部要求。": "The document or source status changed. Switch to all requirements to see the evidence.",
  "我会等到有可引用的证据再判断。": "I'll wait for evidence I can cite before making a judgment.",
  "有变化": "Changed",
  "有证据": "Evidence found",
  "等待证据": "Awaiting evidence",
  "已记录为满足，暂未附带可引用的片段。": "Recorded as satisfied, but no citable excerpt is attached yet.",
  "当前文档中尚未找到足够证据。": "The current document doesn't contain enough evidence yet.",
  "文档版本：{before} → {after}": "Document version: {before} → {after}",
  "新增证据支持 {count} 项要求": "Requirements with new evidence: {count}",
  "{count} 项要求不再满足": "Requirements no longer satisfied: {count}",
  "核对范围减少了 {count} 项": "Requirements removed from the check: {count}",
  "证据时效状态发生变化": "Evidence freshness changed",
  "来源冲突情况发生变化": "The source conflict status changed",
  "尚未关联文档": "No linked document yet",
  "查看原文": "Open source",
  "从上次查看之后": "Since you last looked",
  "证据显示方式": "Evidence view",
  "只看变化": "Changes only",
  "全部要求": "All requirements",
  "证据仍有待核实，不能仅凭核对数量判断已完成。": "Evidence still needs verification. The check count alone doesn't confirm completion.",
  "松手收起": "Release to close",
  "点击外部或 Esc 收起": "Click outside or press Esc to close",
  "这里引用核对时的版本，原文链接可能已更新。": "These excerpts come from the version checked at the time. The source link may have changed since."
  ,"下一步与责任": "Next step and ownership"
  ,"下一步": "Next action"
  ,"责任人": "Owner"
  ,"等待条件": "Wait condition"
  ,"为什么排在这里？": "Why this priority?"
  ,"未指定责任人": "Owner not identified"
  ,"等待重新评估": "Waiting for reassessment"
  ,"相关证据或回复到达时重新检查": "Recheck when related evidence or a reply arrives"
  ,"当前排序保持现有任务顺序，优先级依据尚未提供。": "The current task order is kept because no priority evidence is available."
  ,"文档有新版本时": "When the document changes"
  ,"邮件线程收到回复时": "When the email thread gets a reply"
  ,"到指定时间时": "At a specified time"
  ,"保存等待条件": "Save wait condition"
  ,"选择等待时间。": "Choose a time to wait until."
  ,"等待条件已保存；风险变化仍会提前提醒。": "Wait condition saved. A new risk can still bring this back sooner."
  ,"一项决定，解开多件事": "One answer can unblock several tasks"
  ,"会影响": "Affects"
  ,"共同依赖的答案": "Answer to the shared requirement"
  ,"给出信息或来源位置": "Enter the information or where to find it"
  ,"一次回答并重新核对": "Answer once and recheck"
  ,"一次回答已记录；所有相关事项都会重新核对证据。": "Your answer is saved. Evidence will be rechecked for every related task."
  ,"纠正后续发现": "Correct future matching"
  ,"此纠正只影响匹配范围": "This correction changes future matching only"
  ,"撤销这项纠正": "Undo this correction"
  ,"选择要关联的已有事项后，再保存重复纠正。": "Choose the existing task before saving a duplicate correction."
  ,"当前任务没有可撤销的文档关联。": "This task has no document association to correct."
  ,"纠正已记录，可在同一事项中撤销。": "Correction saved. You can undo it on this task."
  ,"纠正已撤销，后续发现会恢复原来的匹配范围。": "Correction undone. Future findings will use the previous matching scope."
  ,"文档补丁": "Document patch"
  ,"基础版本": "Base version"
  ,"来源": "Sources"
  ,"条": "items"
  ,"没有可应用的来源文本。": "No sourced text is ready to apply."
  ,"文档补丁审阅入口": "Document patch review"
  ,"我会从当前缺少的要求中寻找有来源的原文片段。没有直接证据、来源冲突或版本过期时会明确阻止；准备不会修改文档。": "I'll look for cited source text for unmet requirements. Missing evidence, conflicting sources or an old version will block preparation. Preparing a patch never edits the document."
  ,"根据证据准备补丁供审阅": "Prepare an evidence-based patch for review"
  ,"来源补丁已准备，文档尚未修改。请审阅后再决定。": "The sourced patch is ready. The document has not changed. Review it before deciding."
  ,"没有可安全准备的来源补丁；请查看阻塞原因。": "No patch could be prepared safely. Review the blockers."
  ,"我已审阅这段内容；只做只读核对，不改动文档。": "I've reviewed this text. Run a read-only check without changing the document."
  ,"我已审阅准确内容，并授权应用到此版本。": "I've reviewed this text and authorize applying it to this version."
  ,"只读复核补丁": "Check patch in read-only mode"
  ,"应用此补丁并读回核验": "Apply patch and verify by reading it back"
  ,"应用后已读回核验": "Read-back verified after applying"
  ,"本次模拟": "Local simulation"
  ,"应用补丁并读回核验。": "Patch applied and verified by reading it back."
  ,"补丁已进行只读复核；没有更改文档。": "Patch checked in read-only mode. The document was not changed."
  ,"审阅并勾选确认后才能继续。": "Review and check the confirmation before continuing."
  ,"找不到补丁对应的基础版本，请重新准备。": "The patch's base version is unavailable. Prepare it again."
  ,"接受建议后，责任人、下一步和完成条件会留在这里。": "After you accept a suggestion, its owner, next action and completion condition will appear here."
  ,"检查已接受的建议": "Review the accepted suggestion"
  ,"尚未指定": "Not assigned"
  ,"完成条件": "Completion condition"
  ,"等待明确完成条件": "Waiting for a clear completion condition"
  ,"已接受建议的后续事项": "Follow-ups from accepted suggestions"
  ,"持续观察与账号连接": "Continuous observation and account connection"
  ,"连接状态和最近一次观察都来自本地服务记录。": "Connection and latest observation status come from the local service."
  ,"自动观察已关闭": "Automatic observation is off"
  ,"正在进行首次观察": "First observation in progress"
  ,"正在同步变化": "Syncing changes"
  ,"持续观察中": "Watching for changes"
  ,"最近一次观察失败": "The latest observation failed"
  ,"最近一次成功观察已过期": "The latest successful observation is out of date"
  ,"需要先连接 Google Workspace": "Connect Google Workspace first"
  ,"尚无成功观察": "No successful observation yet"
  ,"最后成功观察": "Last successful observation"
  ,"最后失败": "Last failure"
  ,"最后过期": "Last expired"
  ,"尚无成功记录": "No successful run yet"
  ,"无失败记录": "No failures recorded"
  ,"尚未过期": "Not expired"
  ,"最近一次错误": "Latest error"
  ,"最新工作区变化未知，恢复同步前不会显示为正常照看。": "Recent workspace changes are unknown. Normal monitoring won't resume until sync succeeds."
  ,"开启自动观察": "Enable automatic observation"
  ,"启用会立即同步；之后每个周期结束后再安排下一次，不会并行重叠。": "Enabling starts a sync now. The next run is scheduled after it finishes, so runs won't overlap."
  ,"同步间隔": "Sync interval"
  ,"15 秒": "15 seconds"
  ,"1 分钟": "1 minute"
  ,"5 分钟": "5 minutes"
  ,"15 分钟": "15 minutes"
  ,"1 小时": "1 hour"
  ,"24 小时": "24 hours"
  ,"保存观察设置": "Save observation settings"
  ,"关闭网页不会停止本地服务观察。退出服务会暂停计时器；如果自动观察仍开启，下次启动会先同步再继续。关闭自动观察会持久保存关闭状态。": "Closing this page doesn't stop the local service. Stopping the service pauses its timer; if observation stays enabled, the next launch syncs first. Turning observation off persists across restarts."
  ,"当前是独立本地模拟。启用真实观察需要先完成 Google OAuth，并重启到单独的真实工作区。": "This is an isolated local simulation. To observe real data, complete Google OAuth and restart into a separate live workspace."
  ,"现在同步一次": "Sync now"
  ,"选择需要的 Google 权限": "Choose Google permissions"
  ,"读取 Gmail 邮件": "Read Gmail"
  ,"读取 Drive 文档": "Read Drive documents"
  ,"允许 Google Docs 补丁写入（单独授权）": "Allow Google Docs patch writes (separate authorization)"
  ,"允许 Gmail 发送范围（单独授权）": "Allow Gmail send scope (separate authorization)"
  ,"读权限默认开启；文档写入与邮件发送各自单独申请。授权后仍会核对范围与版本；外部写入还需要你另行开启。": "Read access is selected by default. Docs writes and Gmail sending require separate scopes. Scope and version checks still apply; external writes need a separate opt-in."
  ,"重新授权所选范围": "Reauthorize selected scopes"
  ,"前往 Google 授权": "Authorize with Google"
  ,"连接自己的 Google OAuth Desktop client。Unprompted 不提供或伪造 OAuth client。": "Connect your own Google Desktop OAuth client. Unprompted does not provide or fabricate OAuth clients."
  ,"打开 Google Cloud OAuth clients": "Open Google Cloud OAuth clients"
  ,"创建 Desktop app client 后选择下载的 JSON 文件。": "Create a Desktop app client and choose its downloaded JSON file."
  ,"Desktop OAuth client JSON": "Desktop OAuth client JSON"
  ,"安全保存客户端并继续": "Save client privately and continue"
  ,"client secret 和 refresh token 只写入本机权限 0600 的配置，不会由 API 返回，也不会放入工作状态或 SSE。": "The client secret and refresh token are stored in a local 0600 file. They are never returned by the API or included in workspace state or SSE."
  ,"最近一次 Google 同步成功": "Latest Google sync succeeded"
  ,"最近一次 Google 同步失败，状态需复核": "Latest Google sync failed; check the status"
  ,"Google token 已通过显式验证；尚未同步工作区内容": "Google token validated explicitly; workspace data has not been synced"
  ,"授权已保存，需重启后应用": "Authorization saved; restart to apply it"
  ,"当前进程已配置 Google，但尚未验证 API 连接": "Google is configured for this process, but the API connection isn't verified"
  ,"尚未连接 Google": "Google isn't connected"
  ,"已选的权限范围需要重新授权": "Reauthorize the selected Google scopes"
  ,"最近同步": "Last sync"
  ,"验证 Google token": "Validate Google token"
  ,"移除此设备上的 Google 授权": "Remove Google authorization from this device"
  ,"允许已审批的外部写入": "Allow approved external writes"
  ,"只会启用已经单独授权的 Gmail 发送或 Docs 写入范围；保存后需重启，默认仍为关闭。": "Only separately authorized Gmail send or Docs write scopes can be enabled. Restart to apply; writes stay off by default."
  ,"保存写入边界": "Save write boundary"
  ,"重启 Unprompted 应用并连接": "Restart Unprompted and connect"
  ,"本地模拟空间会保留；Google 使用独立的真实工作区文件。": "The local simulation stays intact. Google uses a separate live workspace file."
  ,"已保存本机配置。请停止并重新运行本地服务；真实 Google 工作区会使用独立文件，不会混入模拟记录。": "Local settings are saved. Stop and restart the service. Google uses a separate workspace file so live records won't mix with simulation."
  ,"Desktop OAuth client 已在本机私密保存；下一步选择范围并授权。": "Desktop OAuth client saved privately on this device. Choose scopes and authorize next."
  ,"浏览器拦截了授权弹窗，请允许此本地页面打开弹窗后重试。": "The browser blocked the authorization window. Allow this local page to open it and try again."
  ,"已在系统浏览器窗口开始 Google 授权；完成后返回此页。": "Google authorization opened in your browser. Return here when it finishes."
  ,"写入边界已保存，需要重启后生效。": "Write boundary saved. Restart to apply it."
  ,"自动观察已开启，正在立即进行首轮同步。": "Automatic observation is on. The first sync is starting now."
  ,"自动观察已关闭；最后同步状态仍会保留。": "Automatic observation is off. The last sync status is preserved."
  ,"同步有失败，查看连接状态和最后错误。": "Sync failed. Check the connection status and latest error."
  ,"同步已完成；只显示提供方实际返回的结果。": "Sync finished. Only results returned by the provider are shown."
  ,"Google token 验证完成。": "Google token validation finished."
  ,"本机 Google 授权已移除。": "Google authorization was removed from this device."
  ,"已移除本机保存的授权；当前进程会在重启后停止使用。": "Saved authorization removed. The current process will stop using it after restart."
  ,"Unprompted 正在重启，授权完成后会自动重新连接。": "Unprompted is restarting and will reconnect after authorization is applied."
  ,"无法安全准备的来源补丁": "Source patch could not be prepared safely"
  ,"找不到补丁所属任务，请重新打开任务后再试。": "The patch's task could not be found. Reopen the task and try again."
  ,"等待条件触发后继续": "Continue when the wait condition occurs"
  ,"等待条件已满足，重新核对": "Recheck after the wait condition occurs"
  ,"审阅并批准已准备的结果": "Review and approve the prepared result"
  ,"向提供方核实结果": "Confirm the result with the provider"
  ,"查看中断原因并决定下一步": "Review the interruption and choose what happens next"
  ,"重新核对共同依赖": "Recheck the shared requirement"
  ,"补充缺失信息或来源": "Provide the missing information or source"
  ,"对照请求检查当前来源文档": "Check current source documents against the request"
  ,"提供共同依赖信息：{label}": "Provide information for the shared requirement: {label}"
  ,"文档更新后重新核对：{title}": "Recheck after the document changes: {title}"
  ,"相关文档有新版本时重新核对": "Recheck when a related document changes"
  ,"邮件线程收到回复时重新核对": "Recheck when the email thread gets a reply"
  ,"在截止时间前重新核对：{when}": "Recheck before the deadline: {when}"
  ,"风险变化打断了等待，需要你查看下一步。": "A risk interrupted the wait. Review the next step."
  ,"截止日期已过 {days} 天（{date}）。": "The deadline passed {days} day(s) ago ({date})."
  ,"截止日期将在 {days} 天内（{date}）。": "The deadline is within {days} day(s) ({date})."
  ,"距离截止日期还有 {days} 天（{date}）。": "The deadline is {days} day(s) away ({date})."
  ,"有 {count} 处证据冲突需要复核。": "{count} evidence conflict(s) need review."
  ,"证据已有 {days} 天没有变化。": "The evidence hasn't changed for {days} day(s)."
  ,"有 {count} 件事项共享这项未满足的要求。": "{count} active task(s) share this unmet requirement."
};
const legacyMessages = {
  "The prepared reply changed. Review the updated reply before sending.": "准备好的回复已经更新，请看过新内容后再发送。",
  "No verifiable content criteria were derived from this request yet.": "这次请求还没有可核对的具体要求。",
  "Not found in the document.": "文档中尚未找到。",
  "STATEMENTS THE REPLY WOULD MAKE": "回复中的陈述",
  "Supported by evidence": "已有证据支持",
  "Not supported by evidence, so it was withheld.": "缺少证据支持，未写入回复。",
  "EXPLICITLY UNKNOWN": "仍不确定的事",
  "STRENGTHENED VERIFICATION": "加强核验",
  "Why more than the baseline checks": "为什么需要进一步核对",
  "A competing plausible source exists.": "存在其他可能的来源。",
  "Freshness verified": "已核实为当前结果",
  "Stale evidence": "证据已过期",
  "Freshness unverified": "尚未核实是否最新",
  "Contradictory evidence": "证据存在冲突",
  "Newly discovered": "刚刚发现",
  "Investigating": "正在核对",
  "Waiting for evidence": "等待证据",
  "Ready for approval": "等待你的选择",
  "Verifying": "正在核验",
  "Verified complete": "已核验完成",
  "Needs attention": "需要关注",
  "Closed": "已关闭",
  "YOUR JUDGEMENT": "你的反馈",
  "Useful": "有帮助",
  "Not useful": "没有帮助",
  "Wrong link": "关联错了",
  "Reason, optional": "原因（可选）",
  "EVIDENCE PER REQUIREMENT": "逐项核对依据",
  "READY FOR YOUR REVIEW": "回复已备好",
  "WHAT YOU DID NOT HAVE TO DO": "已经替你完成的事",
  "Noticing the request in the inbox": "注意到收件箱中的请求",
  "Finding the matching document": "找到相关文档",
  "Checking the source against the request": "对照请求核查来源",
  "Drafting the reply from that evidence": "根据证据准备回复",
  "A reply is prepared from the linked document and the email. Nothing has been sent.": "已根据相关文档与邮件准备回复，尚未发送。",
  "Noticed": "已发现",
  "Linked": "已关联",
  "Verified": "已核验",
  "Prepared": "已准备",
  "Draft ready. Not sent.": "回复已备好，尚未发送。",
  "No criterion recorded": "尚未记录核对要求",
  "TO": "收件人",
  "SUBJECT": "主题",
  "Shadow mode blocks this write.": "只读模式不允许发送。",
  "Approval records a local simulated receipt only.": "这次操作只记录本地模拟回执。",
  "Requires your approval before any external effect.": "发送前等待你的决定。",
  "Withheld from this reply": "未写入本次回复",
  "unsupported by evidence": "缺少证据支持",
  "Approve and send via Gmail": "通过 Gmail 发送",
  "Approve simulated send": "发送模拟回复",
  "Reject": "这次不用了",
  "Approval sends a real email through Gmail, then verifies it with the provider.": "通过 Gmail 发送真实邮件，再向提供方核实结果。",
  "Approval writes to a simulated outbox only. No external service is contacted and the link is not reachable from outside this machine.": "只写入本地模拟发件箱，不联系外部服务，链接仅本机可访问。",
  "Action confirmed": "结果已确认",
  "Gmail confirmed the message exists. The result came from the provider, not from a local record.": "Gmail 已确认该邮件存在，结果由提供方核实。",
  "After approval the simulated provider accepted the reply. The result was verified by receipt lookup, not assumed from the send attempt.": "模拟提供方已接收回复，并通过回执查询核实了结果。",
  "Outcome needs attention": "结果需要核实",
  "Delivery not confirmed": "发送结果尚未确认",
  "No automatic retry. The provider is checked before any further attempt.": "没有自动重试，再次尝试前会先核实提供方的记录。",
  "Reconcile outcome": "核实结果",
  "Retry after confirmed absence": "已确认未发送，重试",
  "Not sent": "未发送",
  "Draft declined": "回复已搁下",
  "Request closed": "请求已关闭",
  "Checking the outcome": "核验结果中",
  "Waiting for enough evidence": "等待充分的证据",
  "A provider receipt is being verified.": "正在核实提供方回执。",
  "A draft appears only when the right document contains every requested result.": "相关文档包含全部所需结果时，才会准备回复。",
  "WHAT IS MISSING": "还缺少什么",
  "Close this request": "关闭这件事",
  "Keep waiting": "继续等待",
  "Reconcile the outcome": "核实结果",
  "Leave it blocked": "暂时保持现状",
  "Considered and not pursued": "已考虑，暂未跟进",
  "Not pursued.": "暂未跟进。",
  "If pursued later: ": "将来继续时：",
  "Prepared from evidence": "证据准备充分",
  "Unservable suggestions": "暂无法推进的建议",
  "Verified completion": "已核验完成",
  "Withheld claims": "未采用的陈述",
  "Interruptions": "需要参与的次数",
  "Your takeovers": "你的介入次数",
  "Not yet judged": "尚未反馈",
  "Labelled useful": "反馈有帮助",
  "Recorded misses": "记录的遗漏",
  "Time saved": "节省时间",
  "Real events": "真实事件",
  "Follow-throughs absorbed": "已完成的跟进",
  "Source checks": "交叉核验",
  "Waiting for the first environmental event.": "等待环境中的第一条变化。",
  "Decisions and checks will appear as work advances.": "工作推进后，决策与核对记录会出现在这里。",
  "No context observed yet.": "尚未观察到上下文。",
  "source unavailable": "来源暂不可用",
  "Request noticed": "已发现请求",
  "Context connected": "已关联上下文",
  "Looking for the right document": "正在寻找相关文档",
  "Evidence checked": "已核对证据",
  "Checking completion": "正在核对是否完成",
  "Every requested field is present in the document.": "文档包含全部要求的内容。",
  "The requested work cannot yet be shown to be complete.": "现有证据尚不能确认工作完成。",
  "No document with an identity link has been observed yet. That does not prove the work is incomplete.": "尚未找到能明确关联的文档，目前无法判断是否完成。",
  "Request from ": "请求来自 ",
  "Requested action: ": "请求的动作：",
  "Deadline: ": "截止时间：",
  "Discovered ": "发现于 ",
  "Reply to ": "回复给 ",
  "Document run date: ": "文档结果日期：",
  "No match yet": "尚未匹配",
  "Strong match": "关联明确",
  "Plausible match": "可能相关",
  "Weak match": "关联较弱",
  "followup:open": "等待后续行动",
  "followup:completed": "已完成",
  "followup:blocked": "需要判断",
  "Not mine": "不属于我",
  "Duplicate": "重复事项",
  "Already handled": "已经处理",
  "Wrong document link": "文档关联错误",
  "If duplicate, link it to": "如果是重复项，请关联到",
  "Choose related task": "选择相关事项",
  "normal": "普通",
  "medium": "中",
  "high": "高",
  "Owner not identified": "尚未识别责任人",
  "You": "你",
  "Unprompted": "Unprompted",
  "Review the verified result": "查看已核验结果",
  "No further action": "无需后续操作",
  "Wait for ": "等待",
  "Review and approve the prepared result": "审阅并批准已准备的结果",
  "Confirm the provider result": "向提供方核实结果",
  "Review the interruption and choose what happens next": "查看中断原因并决定下一步",
  "Provide the missing information or source": "补充缺失信息或来源",
  "Check current source documents against the request": "对照请求检查当前来源文档",
  "The task is closed.": "任务已关闭。",
  "A prepared result is waiting for a user decision.": "已准备好的结果正在等待用户决定。",
  "No urgent deadline or unresolved execution risk is recorded.": "没有记录到紧急截止时间或尚未解决的执行风险。",
  "The recorded outcome is complete.": "记录的结果已完成。",
  "The user closed this work.": "用户已关闭这项工作。",
  "Unprompted is watching this persisted event or time condition.": "Unprompted 正在等待已保存的事件或时间条件。",
  "The event or time condition occurred; the existing evidence still needs assessment.": "事件或时间条件已满足，仍需重新核对现有证据。",
  "The evidence check is complete; an external action still needs approval.": "证据核对已完成，外部操作仍需批准。",
  "A provider action is in progress or its outcome needs reconciliation.": "提供方操作正在进行，或其结果需要核实。",
  "The shared requirement remains unmet; dismissing its question did not verify the work.": "共享要求仍未满足；关闭问题不等于核验完成。",
  "A shared answer was recorded, but it is not evidence that the deliverable is complete.": "共享答案已记录，但不能证明交付物已经完成。",
  "The current evidence does not satisfy the request.": "当前证据尚未满足这项请求。",
  "The task has not yet completed its evidence assessment.": "这项任务的证据核对尚未完成。",
  "The written deadline is ambiguous and needs a reading decision.": "书面截止日期存在歧义，需要确认如何解读。",
  "The external result is uncertain and needs reconciliation.": "外部操作结果尚不确定，需要核实。",
  "A risk interrupted the current wait.": "风险变化打断了当前等待。",
  "Verified live deliveries": "已核验的真实发送",
  "Verified simulated deliveries": "已核验的模拟发送",
  "User-recognized live deliveries": "你认可的真实发送",
  "Verified document patches": "已核验的文档补丁",
  "User-recognized document patches": "你认可的文档补丁",
  "Pending decisions": "待决定事项",
  "Active days": "有明确决定的天数",
  "Explicit approvals": "明确批准次数",
  "Corrective feedback": "纠正反馈",
  "No wall-clock time measurement is collected.": "没有采集实际耗时，因此不推断节省时间。",
  "Provider receipts confirmed for real Google Workspace actions.": "真实 Google Workspace 操作有提供方回执确认。",
  "Local simulation receipts; these are not real sends.": "本地模拟回执，不代表真实发送。",
  "A verified delivery explicitly labelled useful by you.": "已核验且由你明确标记为有帮助的发送。",
  "Applied patches with a successful provider read-back.": "已应用并由提供方读回核验的补丁。",
  "Verified patches explicitly labelled useful by you.": "已核验且由你明确标记为有帮助的补丁。",
  "Unresolved notices and approvals, counted once.": "尚未解决的提醒和批准事项，每项只计一次。",
  "Days with an explicit decision or correction, not page views.": "有明确决定或纠正的天数，不按页面访问计数。",
  "Items you reported as missed; this is not a recall rate.": "你报告的遗漏事项，不代表系统召回率。",
  "Approved outbound actions and document patches.": "已批准的外发操作和文档补丁。",
  "Recorded scope corrections; these remain user controlled.": "已记录的匹配范围纠正，始终由你控制。",
  "Legacy activity proxy; this does not measure time saved or user value.": "旧版活动代理指标，不衡量节省时间或用户价值。",
  "Legacy activity proxy. This is an estimate, not wall-clock time or user value.": "旧版活动代理指标。这只是估算，不代表实际时间或用户价值。",
  "patch:prepared": "准备完成",
  "patch:blocked": "被阻止",
  "patch:applied": "已应用",
  "patch:stale": "版本已过期",
  "patch:failed": "应用失败",
  "patch:shadow_read_only": "只读复核"
};
const reverseMessages = Object.fromEntries(Object.entries(messages).map(([zh, en]) => [en, zh]));
let locale = 'en';
try {
  const saved = localStorage.getItem('unprompted:language');
  locale = ['en', 'zh-CN'].includes(saved) ? saved : (navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');
} catch { locale = typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'; }

export const getLocale = () => locale;
export function setLocale(value) {
  if (!['en', 'zh-CN'].includes(value)) return false;
  locale = value;
  try { localStorage.setItem('unprompted:language', value); } catch {}
  return true;
}
export function copy(message, values = {}) {
  const translated = locale === 'en' ? (messages[message] ?? message) : (legacyMessages[message] ?? reverseMessages[message] ?? message);
  return String(translated).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
const replacements = {
  en: Object.entries(messages).sort((a, b) => b[0].length - a[0].length),
  'zh-CN': Object.entries(legacyMessages).sort((a, b) => b[0].length - a[0].length)
};
const matchers = Object.fromEntries(Object.entries(replacements).map(([language, entries]) => [language, new RegExp(entries.map(([key]) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')]));
function literal(text) {
  const table = locale === 'en' ? messages : legacyMessages;
  return text.replace(matchers[locale], key => table[key]);
}

export function ui(strings, ...values) {
  return strings.reduce((result, part, index) => result + literal(part) + (index < values.length ? values[index] : ''), '');
}
export function applyLanguage(root = document) {
  document.documentElement.lang = locale;
  document.title = locale === 'en' ? 'Unprompted · Things are moving' : 'Unprompted · 事情在推进';
  for (const node of root.querySelectorAll('[data-copy]')) node.textContent = copy(node.dataset.copy);
  for (const attr of ['aria-label', 'placeholder', 'title']) {
    for (const node of root.querySelectorAll(`[data-copy-${attr}]`)) node.setAttribute(attr, copy(node.getAttribute(`data-copy-${attr}`)));
  }
}
export function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: locale === 'en' }) : '—';
}
export function formatDate(value = new Date()) {
  return new Date(value).toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' });
}
