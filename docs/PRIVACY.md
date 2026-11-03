# 隐私政策 / Privacy Policy

**NTULearn 双语字幕 · AI 翻译与笔记（非官方）** / **Bilingual Subtitles for NTULearn (Unofficial)**

生效日期 / Effective date: 2026-11-03

[中文](#中文) · [English](#english)

---

## 中文

本扩展是个人开发的开源工具，与南洋理工大学（NTU）、Kaltura、Blackboard、Google、OpenAI 均无关联。开发者**不运营任何服务器**，不会收到、也不会保存你的任何数据。扩展没有统计、广告或第三方追踪代码。

### 扩展会处理哪些数据

| 数据 | 用途 | 存放位置 |
| --- | --- | --- |
| 课程视频的字幕文本、视频标题和简介 | 生成译文、笔记，回答你的提问 | 只在内存中处理；生成的译文、笔记缓存在本机 |
| 你在侧边栏输入的问题、对话记录、当前播放位置 | 让 AI 结合课程内容回答 | 对话记录按视频保存在本机 |
| 设置（接口地址、API Key、模型、课程背景、术语表、字幕样式等） | 让扩展按你的配置工作 | 本机 `chrome.storage.local` |
| 选择「ChatGPT 订阅」时的登录凭证（OAuth 令牌）以及账号邮箱、名称、套餐类型 | 用你的 ChatGPT 套餐发送 AI 请求，在设置页显示登录状态 | 本机 `chrome.storage.local`；登录过程中的临时状态在 `chrome.storage.session` |

所有数据都只保存在你的浏览器里，不会同步到其他设备，也不会上传给开发者。

### 数据会发送到哪里

扩展只会把数据发送到以下地址，且只在你使用对应功能时发送：

1. **课程视频所在的 Kaltura / NTU 服务器**：扩展读取播放器已加载的字幕，并从同一服务器获取同一视频其余的字幕分段。
2. **Google 翻译（translate.googleapis.com）**：仅在「基础模式」下，发送字幕文本和目标语言。
3. **你自己配置的 AI 接口**：仅在「AI 精准模式」下。字幕翻译会发送字幕文本、视频标题、课程背景和术语表；生成笔记会发送整节课字幕；对话会发送字幕（或笔记大纲）、当前播放位置、你的问题和最近的对话记录。接口由你选择并填写，这些数据受该服务商的隐私政策约束。
4. **OpenAI（auth.openai.com、api.openai.com）**：仅在你选择「ChatGPT 订阅」时使用。登录在 OpenAI 官方页面完成，扩展不会接触你的密码；之后的 AI 请求内容同第 3 条，发往 OpenAI 官方 Responses API。退出登录时，扩展会请求 OpenAI 撤销授权。

扩展不会把数据发送给上述以外的任何地方，不会出售或转让数据，也不会把数据用于广告、信用评估或与本扩展功能无关的目的。

### 权限说明

- `storage`、`unlimitedStorage`：在本机保存设置以及每个视频的译文、笔记和对话缓存。
- `sidePanel`：显示侧边栏（译文、笔记、对话、设置）。
- `*.kaltura.com`、`*.ntu.edu.sg`：在课程视频页面读取字幕、显示双语字幕。
- `translate.googleapis.com`：基础模式的翻译。
- 可选的网站访问权限：只有当你在设置中填写某个 AI 接口地址或登录 ChatGPT 时，才会请求访问该地址，由你在浏览器弹窗中确认。

### 你的控制权

- 设置页的「清空本地缓存」会删除所有视频的译文、笔记和对话记录。
- 设置页的「清空」按钮会清除接口配置；「退出登录」会删除 ChatGPT 登录凭证并撤销授权。也可以在 ChatGPT 设置中断开本扩展。
- 卸载扩展会删除它在本机保存的全部数据。

### 联系方式

问题或建议请在 GitHub 提交 Issue：<https://github.com/Alan1112223331/ntulearn-bilingual-subtitles/issues>

本政策更新时会修改本页面并更新生效日期。

---

## English

This extension is an open-source tool made by an individual. It is not affiliated with Nanyang Technological University (NTU), Kaltura, Blackboard, Google or OpenAI. The developer **runs no servers** and never receives or stores any of your data. The extension contains no analytics, ads or third-party tracking.

### Data the extension handles

| Data | Purpose | Where it is kept |
| --- | --- | --- |
| Caption text, title and description of the lecture video | Generate translations and notes, answer your questions | Processed in memory; generated translations and notes are cached on your device |
| Questions you type in the side panel, chat history, current playback position | Let the AI answer with the lecture as context | Chat history is saved per video on your device |
| Settings (API endpoint, API key, model, course context, glossary, subtitle style, etc.) | Make the extension work the way you configured it | `chrome.storage.local` on your device |
| When "ChatGPT subscription" is used: sign-in credentials (OAuth tokens) and the account's email, name and plan type | Send AI requests on your ChatGPT plan and show the sign-in status in settings | `chrome.storage.local` on your device; temporary sign-in state in `chrome.storage.session` |

All data stays in your browser. It is not synced to other devices and is never uploaded to the developer.

### Where data is sent

The extension sends data only to the following destinations, and only when you use the related feature:

1. **The Kaltura / NTU server hosting the lecture video**: the extension reads the captions the player has loaded and fetches the remaining caption segments of the same video from the same server.
2. **Google Translate (translate.googleapis.com)**: in Basic mode only; caption text and the target language.
3. **The AI endpoint you configure**: in AI mode only. Subtitle translation sends caption text, the video title, your course context and glossary; notes send the lecture's full transcript; chat sends the transcript (or the notes outline), the current playback position, your question and recent chat history. You choose this provider, and its privacy policy applies to that data.
4. **OpenAI (auth.openai.com, api.openai.com)**: only when you choose "ChatGPT subscription". Sign-in happens on OpenAI's own page and the extension never sees your password; AI requests then go to OpenAI's official Responses API with the content described in item 3. Signing out asks OpenAI to revoke the authorization.

The extension sends data nowhere else. Data is never sold or transferred, and is not used for advertising, creditworthiness or any purpose unrelated to the extension's features.

### Permissions

- `storage`, `unlimitedStorage`: keep settings and the per-video cache of translations, notes and chat on your device.
- `sidePanel`: show the side panel (transcript, notes, chat, settings).
- `*.kaltura.com`, `*.ntu.edu.sg`: read captions and draw bilingual subtitles on lecture video pages.
- `translate.googleapis.com`: translation in Basic mode.
- Optional site access: requested only when you enter an AI endpoint in settings or sign in with ChatGPT, and only after you confirm the browser prompt.

### Your choices

- "清空本地缓存" (Clear local cache) in settings deletes the translations, notes and chat history of all videos.
- "清空" (Clear) removes an API configuration; "退出登录" (Sign out) deletes the ChatGPT credentials and revokes the authorization. You can also disconnect the extension in your ChatGPT settings.
- Uninstalling the extension removes all data it stored on your device.

### Contact

Please open an issue on GitHub: <https://github.com/Alan1112223331/ntulearn-bilingual-subtitles/issues>

When this policy changes, this page and its effective date will be updated.
