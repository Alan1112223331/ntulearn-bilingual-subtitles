# Chrome 应用商店上架材料

上传包：`dist/ntulearn-bilingual-subtitles-v1.4.1.zip`（manifest 在压缩包根目录）
图片：本目录下的 `screenshot-*.png`（1280×800）、`promo-small.png`（440×280）、`promo-marquee.png`（1400×560）
商店图标：取自扩展的 `icons/icon128.png`（96×96 图案 + 16px 透明边距），无需单独上传

下面每一节对应开发者后台的一个页面，按顺序复制粘贴即可。

---

## 1. 商品详情（Store listing）

**语言**：默认语言选 **中文（简体）**，再点「添加语言」加 **English**，两种语言分别填写下面对应的说明和截图。商品名称和简介来自扩展的 manifest（已做中英两种），不需要手填。

| 字段 | 内容 |
| --- | --- |
| 名称（来自 manifest） | 中文：NTULearn 双语字幕 · AI 翻译与笔记（非官方）<br>English：Bilingual Subtitles for NTULearn (Unofficial) |
| 简介（来自 manifest） | 中文：为 NTULearn Media Gallery 课程视频生成双语字幕，侧边栏提供逐段译文、AI 课堂笔记和问答。免配置即用，也可接入自己的大模型或 ChatGPT 订阅。非官方工具。<br>English：Bilingual subtitles for NTULearn Media Gallery lectures, plus a side panel with transcript, AI notes and Q&A. Unofficial tool. |
| 类别（Category） | 教育（Education） |
| 官方网址（Official URL） | 不填（需要域名验证，可选） |
| 首页网址（Homepage URL） | https://github.com/Alan1112223331/ntulearn-bilingual-subtitles |
| 支持网址（Support URL） | https://github.com/Alan1112223331/ntulearn-bilingual-subtitles/issues |
| 成人内容（Mature content） | 否 |

### 详细说明 · 中文

```text
为 NTULearn（南洋理工大学 Blackboard）Media Gallery 里的课程视频生成双语字幕，并在浏览器侧边栏提供逐段译文、AI 课堂笔记和课程问答。

※ 本扩展为个人开发的开源工具，与南洋理工大学（NTU）、Kaltura、Blackboard 均无关联。

【双语字幕】
• 装好即用：默认使用免费的 Google 翻译，打开课程视频就有中英双语字幕，不需要任何配置
• 无延迟：拿到字幕后从当前播放位置开始预翻译整部视频，拖动进度条时优先翻译新位置，结果缓存在本地，重复观看立即显示
• 清晰易读：字幕随播放器尺寸自适应，支持全屏、拖动调整位置、隐藏播放器原字幕；双语 / 仅译文 / 仅原文三种模式
• 13 种目标语言，也可自定义

【AI 精准模式】
• 接入你自己的大模型：OpenAI、Anthropic、Gemini 三种接口格式，可自定义接口地址和模型，兼容 DeepSeek、通义千问、OpenRouter 等
• 或者直接登录 ChatGPT，用你的 ChatGPT 订阅额度，不需要 API Key（OpenAI 官方 Sign in with ChatGPT）
• 结合上下文、课程背景和术语表翻译，专业名词更准确，并能修正语音识别的错误

【侧边栏】
• 译文：整节课按段落排版，当前这句高亮并自动滚动，点任意一句跳到视频对应位置，可导出双语 SRT / 文稿
• 笔记（AI 模式）：按知识点自动整理整节课的笔记，包括要点、例子、老师强调的内容（带时间戳）、术语，以及本节概览和自测题；公式正常排版；跟着视频高亮当前知识点；可导出 Markdown / 网页
• 对话（AI 模式）：AI 知道整节课的内容和你正在看的位置，回答中的时间点可以点击跳转
• 笔记和问答可以单独配置一个更强的模型；不需要笔记时可以关闭

【隐私】
• 设置、API Key、译文、笔记和对话只保存在你的浏览器里
• 开发者不运营任何服务器，不收集任何数据，没有统计或广告
• 字幕只会发送给 Google 翻译（基础模式）或你自己选择的 AI 接口
• 源代码：https://github.com/Alan1112223331/ntulearn-bilingual-subtitles

快捷键：Alt+Shift+S 开关字幕，Alt+Shift+M 切换显示模式。需要 Chrome / Edge 116 及以上。
```

### 详细说明 · English

```text
Bilingual subtitles for lecture videos in NTULearn (Nanyang Technological University's Blackboard) Media Gallery, plus a browser side panel with a paragraph transcript, AI lecture notes and Q&A about the lecture.

* This is an unofficial open-source tool made by an individual. It is not affiliated with NTU, Kaltura or Blackboard. The interface is in Simplified Chinese.

BILINGUAL SUBTITLES
• Works out of the box: free Google Translate by default, no setup needed
• No delay: the whole video is translated ahead of time, starting from where you are watching; seeking jumps the queue; results are cached locally
• Clear display: subtitles scale with the player, work in full screen, can be dragged into place, and can hide the player's own captions; bilingual / translation-only / original-only modes
• 13 target languages, or a custom one

AI MODE
• Use your own model: OpenAI, Anthropic or Gemini API formats with a custom endpoint and model, compatible with DeepSeek, Qwen, OpenRouter and other providers
• Or sign in with ChatGPT and use your ChatGPT plan, no API key needed (OpenAI's official Sign in with ChatGPT)
• Translation uses surrounding context, your course context and a glossary, so technical terms come out right and speech-recognition errors get fixed

SIDE PANEL
• Transcript: the whole lecture in paragraphs, the current sentence highlighted and followed; click any sentence to jump there; export bilingual SRT or text
• Notes (AI mode): notes organised by topic, with key points, examples, what the lecturer stressed (with timestamps), terms, an overview and self-check questions; formulas are typeset; the current topic is highlighted as the video plays; export Markdown or HTML
• Chat (AI mode): the AI knows the whole lecture and where you are watching; cited timestamps are clickable
• Notes and chat can use a separate, stronger model; notes can be turned off

PRIVACY
• Settings, API keys, translations, notes and chats stay in your browser
• The developer runs no servers and collects no data; no analytics, no ads
• Captions are sent only to Google Translate (Basic mode) or the AI provider you choose
• Source code: https://github.com/Alan1112223331/ntulearn-bilingual-subtitles

Shortcuts: Alt+Shift+S toggles subtitles, Alt+Shift+M switches the display mode. Requires Chrome / Edge 116 or later.
```

### 图片

| 后台字段 | 文件 | 说明 |
| --- | --- | --- |
| 屏幕截图（Screenshots，1–5 张） | `screenshot-1-notes.png`、`screenshot-2-chat.png`、`screenshot-3-transcript.png`、`screenshot-4-settings.png` | 按序号上传；中英两种语言用同一组即可 |
| 小型宣传图块（Small promo tile，440×280，必填） | `promo-small.png` | |
| 顶部宣传图块（Marquee promo tile，1400×560，可选） | `promo-marquee.png` | 被商店选为推荐时才会用到 |

截图全部来自本地演示页面（模拟讲座），没有真实课程内容；设置页截图里的账号和 Key 都是演示值。

---

## 2. 隐私（Privacy practices）

### 单一用途（Single purpose）

```text
Helps students study NTULearn Media Gallery lecture videos: it shows bilingual subtitles on the video and, in the side panel, a transcript, AI-generated lecture notes and Q&A based on the video's captions.
```

### 权限理由（Permission justification）

| 权限 | 填写内容 |
| --- | --- |
| `storage` | Saves the user's settings (target language, subtitle style, the AI endpoint and API key they entered) and caches translations, notes and chat history per video on the device, so a rewatched video shows subtitles instantly without new API calls. |
| `unlimitedStorage` | A cached lecture (translated captions of a 3-hour video, generated notes and chat history) can be several MB; users who watch many lectures would exceed the default storage quota. Old entries are evicted with an LRU index. |
| `sidePanel` | The extension's main UI is a side panel next to the video with four tabs: transcript, notes, chat and settings. Clicking the toolbar icon opens it. |
| 主机权限 `https://*.kaltura.com/*`、`https://*.ntu.edu.sg/*` | NTULearn plays lecture videos in a Kaltura player inside nested NTU / Kaltura iframes. The content scripts run there to read the caption files the player loads, fetch the remaining caption segments of the same video, and draw the bilingual subtitle overlay. |
| 主机权限 `https://translate.googleapis.com/*` | Basic mode (the default, no setup) translates caption text with Google Translate from the background worker. |
| 可选主机权限 `https://*/*`、`http://*/*` | Users can point AI mode at any OpenAI / Anthropic / Gemini compatible endpoint (official APIs, self-hosted or regional providers), so the host is not known in advance. Access is requested at runtime with chrome.permissions.request only for the origin the user enters (or auth.openai.com / api.openai.com / the 127.0.0.1 sign-in callback when they choose Sign in with ChatGPT), and only after they confirm the browser prompt. |

### 远程代码（Remote code）

选择 **No, I am not using remote code**。

```text
All JavaScript, including the KaTeX library used to typeset formulas, is bundled in the package. The extension only exchanges data (JSON / text) with translation and AI APIs; it never downloads or evaluates code.
```

### 数据使用（Data usage）

勾选以下三项（宁可多勾，不漏报）：

- [x] **个人身份信息（Personally identifiable information）**：选择 ChatGPT 订阅登录时，会在本机保存 ChatGPT 账号的邮箱和名称，用于在设置页显示登录状态
- [x] **身份验证信息（Authentication information）**：用户填写的 API Key、ChatGPT 登录的 OAuth 令牌，只保存在本机、只发送给对应的接口
- [x] **网站内容（Website content）**：课程视频的字幕文本和标题，会发送给 Google 翻译或用户选择的 AI 接口来翻译、生成笔记和回答问题

其余（健康、财务、个人通讯、位置、网络历史记录、用户活动）都不勾。

然后勾选三项声明：

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### 隐私权政策网址（Privacy policy URL）

```text
https://github.com/Alan1112223331/ntulearn-bilingual-subtitles/blob/main/docs/PRIVACY.md
```

---

## 3. 分发（Distribution）

| 字段 | 选择 |
| --- | --- |
| 付款 | 免费 |
| 公开范围（Visibility） | 公开（Public） |
| 地区（Regions） | 所有地区 |

---

## 4. 测试说明（Test instructions，可选但建议填）

审核员没有 NTU 账号，打不开真实课程视频，这里说明一下，避免因为"无法测试"被拒：

```text
The extension only activates on NTULearn lecture videos (a Kaltura player embedded in NTU's Blackboard), which require an NTU student account, so reviewers cannot open a real lecture.

What can be checked without an NTU account:
1. Click the toolbar icon: the side panel opens (tabs: 对话 Chat, 笔记 Notes, 译文 Transcript, 设置 Settings). Without a lecture video it shows "未检测到视频" (no video detected).
2. Settings tab: Basic mode (Google Translate, default) and AI mode. Click "测试连接" (Test connection) in Basic mode to translate two sample subtitle lines.
3. Optional host permissions are only requested when an AI endpoint is entered and saved, or when "Continue with ChatGPT" is clicked.

Screenshots in the listing show the extension on a local demo page that simulates a lecture. Source code and a local test page (test/panel-harness.html) are at https://github.com/Alan1112223331/ntulearn-bilingual-subtitles
```

---

## 重新生成图片

截图和宣传图块来自 `test/panel-harness.html`（模拟讲座）和 `test/store-art.html`（设置页截图、宣传图块），用无头 Edge 以 2 倍分辨率渲染后缩小到商店要求的尺寸：

```bash
python test/make_harness.py
python -m http.server 8765 --bind 127.0.0.1
```

然后依次截取（窗口 1280×800，深色主题）：

- `test/panel-harness.html?lecture&demo&tab=notes&t=128` → `screenshot-1-notes.png`
- `test/panel-harness.html?lecture&demo&tab=chat&t=128` → `screenshot-2-chat.png`
- `test/panel-harness.html?lecture&demo&tab=transcript&t=150` → `screenshot-3-transcript.png`
- `test/store-art.html?shot=settings` → `screenshot-4-settings.png`
- `test/store-art.html?shot=small`（440×280）→ `promo-small.png`
- `test/store-art.html?shot=marquee`（1400×560）→ `promo-marquee.png`
