# Contexo YouTube upload

[Watch the published video](https://www.youtube.com/watch?v=ZB7hxPhwrwU)

## Title

Contexo: Review-First AI Coding in VS Code | IIT Bombay TrueFoundry Forge-a-thon

## Description

Contexo is a VS Code coding agent built on TrueForge. It chooses which code enters the model’s context, shows why it selected those excerpts, and lets you review each proposed change before it writes to disk.

This live demo uses Flask 3.1.3. We edit an inline helper, undo and redo the change, and stop an active run. Then Contexo finds and edits three files to add a `flask config` command. All 60 Flask CLI tests pass, and the command masks nested secrets in its JSON output. We also trigger a model failure to show automatic fallback to local Qwen and verify that Git stays clean.

Built by Weights of Sin for the TrueFoundry Forge-a-thon at Techfest, IIT Bombay. Team ID TM-AFBECD9C838. Team members are Atharva Deo, Bhavik Sheth, Parvati R Iyer, and Akshat Bhalani.

Source and setup: https://github.com/Bhavik-Sheth/TrueFoundry-Weights-of-Sin
TrueForge: https://github.com/truefoundry/trueforge
Flask 3.1.3: https://github.com/pallets/flask/releases/tag/3.1.3
Forge-a-thon: https://techfest.org/competitions/forge-a-thon

00:00 Meet Contexo
00:15 Task A · Inline edit and hunk review
00:52 Undo and redo
01:05 Stop an active run
01:15 Task B · Agent mode and context selection
01:52 TrueForge session and three-file review
02:12 Tests, masked JSON, and Git verification
02:35 Task C · Local model fallback and clean Git
03:25 LMCache retrieval and Bonsai probe
03:43 Architecture and team credits

The editor footage is from actual runs. Narration uses Kokoro text-to-speech.

#Contexo #TrueForge #VSCode

## Tags

Contexo, TrueForge, TrueFoundry, TrueFoundry Forge-a-thon, Techfest IIT Bombay, IIT Bombay, VS Code, VS Code extension, AI coding agent, coding agent, MCP, Model Context Protocol, context engineering, code review, hunk review, Flask, Python, TypeScript, model fallback, local LLM, Qwen, LMCache, Bonsai 4B

## Pinned comment

The repo and setup steps are here: https://github.com/Bhavik-Sheth/TrueFoundry-Weights-of-Sin

Jump to 01:15 for the three-file Flask task or 02:35 for the local Qwen fallback. If you try Contexo, tell us what repo and model you used.

## YouTube Studio

1. Upload **Contexo - competition 4m00.mp4** if sharing with competition judges. The original 4:01 MP4 works for a regular YouTube upload.
2. Paste the title and description. Add **Contexo - thumbnail.jpg** as the custom thumbnail.
3. Choose **No, it’s not made for kids** for audience. Under **Show more**, paste the tags, choose **Science & Technology**, set the language to **English**, and use the **Standard YouTube License**. For transparency, select **Yes** under **AI use / Altered content** for the synthetic narration.
4. Under **Subtitles**, optionally upload **Contexo - English.srt** using **With timing**. The video already has burned-in word highlights. The SRT provides a separate caption track.
5. Choose **Unlisted** for the competition link or **Public** for a general launch. After saving, open the link in a private browser window and check that the video plays in 1080p. Then add the pinned comment if comments are enabled.

The [published write-up](../Contexo-writeup.pdf) includes the video scorecard.
