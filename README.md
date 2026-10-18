<div align="center">

<img src="icons/icon128.png" width="88" alt="logo">

# NTULearn 双语字幕 AI 翻译

**为 NTULearn Media Gallery（Kaltura）课程视频生成 AI 大模型翻译的双语字幕**

专业术语精准 · 整片预翻译无延迟 · OpenAI / Anthropic / Gemini 任意自定义接口

[![Release](https://img.shields.io/github/v/release/Alan1112223331/ntulearn-bilingual-subtitles?color=c8102e)](https://github.com/Alan1112223331/ntulearn-bilingual-subtitles/releases/latest)
![Manifest V3](https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-4285F4)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<img src="docs/images/hero.png" alt="双语字幕效果" width="860">

<sub>截图为本地演示页面（模拟讲座幻灯片），已在 NTULearn 真实课程视频上验证。</sub>

</div>

---

## ✨ 功能

- **AI 精准翻译专业术语**：基于视频自带的英文字幕，调用你配置的大模型翻译；可填写 *课程/学科背景* 和 *术语表*，提示词针对语音识别字幕（断句、识别错误）专门优化
- **无延迟**：拿到字幕后立即从当前播放位置开始并发预翻译**整部视频**；拖动进度条时自动优先翻译新位置；结果按视频缓存在本地，重复观看即时显示、不再消耗 API
- **三种接口格式，完全自定义**：OpenAI Chat Completions、Anthropic Messages、Gemini generateContent，Base URL / API Key / 模型名均可自定义，兼容 DeepSeek、通义千问、OpenRouter、one-api / new-api 等中转
- **清晰的双语显示**：自绘字幕层随视频逐帧同步，字号随播放器尺寸自适应；支持全屏、鼠标拖动调整位置、隐藏播放器原字幕；双语 / 仅译文 / 仅原文三种模式
- **一键导出双语 SRT**，方便复习
- 快捷键：`Alt+Shift+S` 开关字幕，`Alt+Shift+M` 切换显示模式

<table>
<tr>
<td width="62%"><img src="docs/images/mode-translation.png" alt="仅译文模式"><p align="center"><sub>仅译文模式</sub></p></td>
<td width="38%"><img src="docs/images/popup.png" alt="扩展弹窗"><p align="center"><sub>扩展弹窗：进度、显示模式、导出</sub></p></td>
</tr>
</table>

## 📦 安装

1. 到 [Releases](https://github.com/Alan1112223331/ntulearn-bilingual-subtitles/releases/latest) 下载 `ntulearn-bilingual-subtitles-v*.zip` 并**解压**（或直接 `git clone` 本仓库）
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择解压出的文件夹（里面有 `manifest.json`）
4. 首次安装会自动打开设置页

> 需要 Chrome / Edge 111 及以上。更新时下载新版本覆盖文件夹，再在扩展页点一下刷新按钮即可。

## ⚙️ 配置

<img src="docs/images/options.png" alt="设置页" width="620" align="right">

在设置页 **模型接口** 中选择格式并填写：

| 格式 | Base URL 示例 | 实际请求地址 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `…/chat/completions` |
| Anthropic | `https://api.anthropic.com` | `…/v1/messages` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `…/models/{模型}:generateContent` |

- **获取模型列表**：从接口拉取可用模型，也可直接手输模型名
- **测试连接**：翻译一段示例字幕，验证接口和输出格式
- 保存时浏览器会请求该接口域名的访问权限，请点 **允许**
- **高级参数**：Temperature（推理模型请留空）、额外请求头、额外请求体（JSON，深度合并进请求，例如 `{"reasoning_effort":"low"}`）

**建议**：

- 选速度快的非推理模型，或把推理强度调低，整片预翻译更快
- 填写 **课程/学科背景**（如 “EE6406 集成学习”）和 **术语表**（每行 `英文 = 译文`），专业名词更准确

<br clear="right">

## ▶️ 使用

打开 NTULearn 课程 → **Books & Tools → Media Gallery** → 播放任意视频，双语字幕会自动出现，左上角会短暂显示翻译进度。

- 点击扩展图标：查看进度、切换显示模式、调字号与背景、导出双语 SRT、重新翻译
- 字幕框可直接用鼠标 **拖动** 调整高度
- 快捷键可在 `chrome://extensions/shortcuts` 修改

## 🔧 工作原理

```
NTULearn (Blackboard Ultra)
└─ LTI iframe → Kaltura KAF
   └─ Kaltura PlayKit 播放器              ← 扩展在这一层工作
      ├─ inject.js   页面主环境：监听播放器的 fetch / XHR，截获字幕
      └─ content.js  隔离环境：解析字幕 → 调度翻译 → 绘制双语字幕层
            └─ background.js  调用大模型 API（Key 不暴露给网页）
```

**字幕获取**（按优先级）：

1. 截获播放器下载的字幕文件。NTU 的 Kaltura 把字幕切成 5 分钟一段的 WebVTT（`…/segmentDuration/300/…/segmentIndex/N.vtt`），播放器只加载当前附近的分段；扩展截获第一段后会按视频时长**主动拉取全部分段**，从而整片预翻译
2. 播放器 CC 关闭时，根据截获的字幕资源列表主动拉取英文字幕
3. `<video>` 的 `textTracks`
4. 兜底：读取播放器渲染的字幕文字逐句实时翻译（约 1 秒延迟）

**翻译调度**：每批 30 条（观众正在看的那批只取 8 条，尽快返回），附带前后各 4 条上下文，默认 3 并发；失败自动重试退避，鉴权等致命错误会暂停并提示。

## 🗂️ 目录结构

```
manifest.json
src/
  shared.js       默认设置、哈希、设置读写
  inject.js       MAIN world：网络截获字幕、预取分段
  parsers.js      SRT / WebVTT / TTML(DFXP) 解析
  content.js      字幕源选择、翻译调度、缓存、字幕层渲染
  background.js   三种 API 格式适配、提示词、结果解析、缓存 LRU
popup/            扩展弹窗
options/          设置页
icons/
test/             本地调试页面（用桩 chrome API 加载真实内容脚本）
docs/images/      README 截图
```

## 🧪 本地调试

```bash
python -m http.server 8765
```

- `http://localhost:8765/test/harness.html`：模拟播放器 + 完整字幕文件
- `http://localhost:8765/test/harness.html?seg=1`：模拟 NTU 的分段字幕
- `http://localhost:8765/test/demo.html`：README 截图用的演示页

在真实视频页按 `F12` 打开控制台，过滤 `NTU双语字幕`，可看到检测到的视频、截获的字幕、预取分段、缓存命中和翻译错误。

## 🌐 适配其它学校 / 域名

默认匹配 `https://*.kaltura.com/*` 与 `https://*.ntu.edu.sg/*`。其他使用 Kaltura 的学校，把播放器所在域名加入 `manifest.json` 的 `host_permissions` 和两个 `content_scripts.matches`，重新加载扩展即可。

## 🔒 隐私

- API Key 与设置只保存在本机 `chrome.storage.local`，不会同步、不会上传
- 只有字幕文本（以及页面标题作为翻译上下文）会发送给**你自己配置的**模型接口
- 扩展不收集任何数据，没有任何统计或第三方服务

## ⚠️ 免责声明

本项目为个人开源工具，与南洋理工大学（NTU）、Kaltura、Blackboard 及各模型服务商均无关联。课程视频与字幕的版权归其所有者，请仅用于个人学习。

## 📄 License

[MIT](LICENSE)
