# 内容创作工作台

Power 右侧的「工作台」现在有「概览」和「内容」。打开「内容」可创建条目，或映射已有的本地目录。每条内容是映射目录下的一个子文件夹；Power 读取其中的 `content.json`、`script.md`、`subtitles.srt`、`article.md`，并识别视频、音频和封面。没有这些文件也能导入已有文件夹；新建条目会自动创建标题和脚本。

选择一条内容后，Agent 的 `content` 工具可以读取 Current Content，创建或修改脚本、字幕、文章，附加生成的封面。本地视频、音频和封面可在详情页导入、预览。写文章和生成封面按钮会把任务填入聊天输入框，选择 Agent 后发送即可。模型沿用 Power 中已登录的 Agent；无需另装 DeepSeek Harness 或输入 DeepSeek API 密钥。

「转写字幕」在本机调用 `ffmpeg`、`whisper-cli` 和 Whisper 模型，生成 `subtitles.srt`。可用 `POWER_FFMPEG`、`POWER_WHISPER_CLI`、`POWER_WHISPER_MODEL` 指定程序与模型。未安装时，工作台会显示缺少的组件。

「本地同步」接受用户配置的同步程序**绝对路径**。Power 将选中的内容文件夹作为第一个命令行参数传给它，并显示任务状态；脚本本身负责发布到目标平台。工作台按钮会在运行前确认；Agent 调用还会弹出确认卡。目前没有预设平台或自动发布逻辑，因为平台、账号和既有同步程序尚未指定。

标语和 Logo 可在「设置」中修改。改动保存在 `~/.power`，内容默认保存在 `~/.power/content`；映射其他目录不会搬动源文件。

这里复用 Power 现有的工作台和 Agent 工具注册，不依赖独立的 DeepSeek Harness/Cordis 运行时。界面和功能按提出的内容流程实现，不能在没有视频原件的情况下保证视觉上与视频逐像素一致。
