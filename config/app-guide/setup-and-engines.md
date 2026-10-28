# Setup, models and engines

This page covers first run, the engines Jenny can use to run a model, where to manage models, and the controls for context size and thinking effort.

## First run

On first launch Jenny shows a short "How Jenny works" notice and asks you to acknowledge it. It explains that you choose what Jenny can access, that Auto mode lets tools run without asking each time, and that not every change can be undone.

Then the setup tiles on Home walk through:

- Choose workspace root: the folder Jenny treats as your working project. File, shell and Git tools stay blocked until a folder is chosen. That is deliberate, not a bug.
- A model route: either Use Ollama on this computer, or Connect an existing server.
- Personality and name: a profile, a name for your assistant, and optional flavor.
- Tools and permissions: review what Jenny may do. Network access and file changes stay off unless you enable them.
- Review skills and MCP.

Optional steps can wait: Finish later keeps your progress. To reopen the checklist at any time, use Settings > Profile, data and updates > Run setup again. It does not delete chats.

The titlebar health indicator reports engine readiness. If a setup step shows Needs attention, wait for the indicator, press Re-check on the engine step, and retry.

## The default model

The default local model is Ornith 1.5 9B (Q4_K_M, about 5.6 GB). It is a text-only coding model that runs comfortably in 8 GB of VRAM. The setup hardware check recommends the strongest model that fits your GPU and RAM, with download and disk estimates. For image input choose a vision model such as Gemma 4 E4B.

## Engines

An engine is the program that actually runs the model.

- Ollama: the default. It handles pulling models. Windows and Linux support Jenny installing it for you; on macOS you install Ollama yourself. If the Ollama tray app is running its own server on the same port, quit the tray app and let Jenny manage Ollama.
- Managed llama-server: Jenny's own llama.cpp process. It can run GGUF files directly, including ones you already have. Add them under Settings > Models > GGUF folders (Add folder, or Add GGUF model). Jenny estimates fit from the file's real size and tells you what fits in your VRAM before loading. It lets you edit the context window per model, with a restart confirmation, and speeds up verified models with multi-token prediction. Choose the engine per model in the Tune drawer ("Inference engine").
- NInfer: a fast engine built only for the RTX 5090 on Windows. It uses its own .ninfer model files, not GGUF. Settings > Models shows an NInfer engine card with a Set up NInfer button. Set-up downloads the engine from github.com and a model from huggingface.co, each checked against a fingerprint built into Jenny. It also has a power watchdog that stops NInfer above a power or temperature limit you can adjust.
- vLLM and other OpenAI-compatible servers: choose Connect an existing server, pick the provider, enter its local or private-network URL, validate and save. Jenny then needs no Ollama install and no model download. The composer's model picker groups these models under OpenAI-compatible.

## Optional cloud routes

Both are off the local path and optional. Settings > Models > Cloud models holds them.

- Sign in with ChatGPT: Jenny's own browser sign-in flow. Once signed in, the toggle Show ChatGPT models in Composer controls whether those models appear; turning it off keeps you signed in.
- Codex CLI: uses the installed codex command and its own login. Jenny never reads that login. If it is not set up, run codex login in a terminal and use Check again.

These send request content to the provider. Settings > Offline > Force local inference blocks them all. Jenny's tokens for the ChatGPT sign-in are kept only in the secure store.

## The model library

Settings > Models lists what is installed and what can be downloaded.

- Rows are grouped (for example In use, Installed, Available to download, Cloud). A fit estimate on each row says whether it fits your hardware.
- Use switches the active model. Pull or Download fetches a new one. Filter models narrows the list.
- Tune opens the per-model drawer: inference engine, llama-server build, GGUF file, and multi-token prediction where supported.
- The On startup group has Load model at startup. When on, a local model warms up when Jenny starts; when off it loads with your first message.
- Image engine: lets Jenny draw images from diffusion models you already have, using stable-diffusion.cpp. The models and their licences are yours.

## Switching models in a chat

The model pill in the composer opens a picker for the model and the reasoning effort. It applies to the current chat; defaults live in Settings. Changes apply from your next message.

The first message after switching can wait 10 to 60 seconds while the model loads into memory. This is normal.

## Context window, summaries and thinking

- The context meter in the composer shows how full the model's window is.
- Settings > Context has Automatic summarization (summarize older turns when a chat no longer fits) and History scope (how much of the chat goes with each message). Jenny narrows history itself if a request would not fit, and says so in the conversation.
- If long chats keep failing, start a new chat for a new topic, raise the context window in the Tune drawer if your memory allows, or pick a model with a larger window.
- The thinking or reasoning effort selector in the model picker sets how much the model reasons, for models that support it. Where the selected model does not support it, the control says so.

## If something goes wrong

- Model failed in the titlebar: the model may not fit in VRAM or RAM. Open Settings > Models, check the fit estimate, and pick a smaller quantization or model.
- Model download stalls: check free disk space and that Ollama is running, then pull again; pulls resume.
- The model cannot see an image: it is text-only. Switch to a vision model or remove the image.
- See diagnostics-and-troubleshooting for more.
