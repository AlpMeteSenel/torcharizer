# Torcharizer

## 📦 Overview

Torcharizer is a Thunderbird add-on that uses a local Ollama model to analyze the full HTML of emails and displays an AI-generated summary at the top of the message view.


## ✨ Features

- Summarizes emails using a local Ollama model
- Adds a Markdown panel labeled "AI Analysis" at the top of each email
- Works with HTML and plain text emails
- Session-based summary caching
- Easy enable/disable via settings

## 📝 Features to Add

- Support for custom online APIs (OpenAI, Gemini, etc)
- Queued summary processing for switching emails
- Persistent summary cache across restarts
- Support for remote/cloud Ollama models
- Improved error handling for unreachable Ollama
- Enhanced compatibility with more Thunderbird versions

---

## 🚨 Known Issues

- Scraping content from HTML to help AI may not work properly.
- System Prompt may not be well-defined or could lead to unexpected results.
- Switching emails while a summary is generating may show the summary for the wrong email or overwrite the new one. (Queued processing is planned.)
- Summaries may be delayed for very large emails or if Ollama is busy.
- If Ollama is unreachable or blocked by CORS, the extension may silently fail to show a summary.
- Some Thunderbird versions may not support all required APIs (e.g., messageDisplayScripts).
- Only local Ollama models are supported; remote or cloud models are not for now.
- Summaries are cached per session, but cache is not persistent across restarts.

## 🚀 Installation & Usage

1. **Install Ollama** and ensure it is running locally (`ollama serve`).
   - For development, you may need to set the environment variable to allow cross-origin requests:
     ```
     $env:OLLAMA_ORIGINS="*"
     ```
2. **Install the Add-on** in Thunderbird:
  - Go to `Tools > Add-ons and Themes > Extensions > Settings gear > Install Add-on From File`.
  - Select `torcharizer.zip` from this folder (rename the zip if needed).
3. **Open an Email** in Thunderbird. The "AI Analysis" panel will appear at the top of the message within a few seconds.
4. **Configure Settings** using the Torcharizer toolbar button:
  - Toggle "Enable AI summaries" to turn summaries on or off globally.

## 🛠️ Development

- Unzip and load as a temporary add-on from the manifest file for quicker iteration.
- Use Add-on Debugging (`Tools > Developer Tools > Debug Add-ons`) to view logs and errors in the background page console.
- Check for streaming network activity to Ollama when emails are opened.

## 🔒 Permissions

- `messagesModify`, `messagesRead`: Read and annotate displayed messages.
- `storage`: Persist user preferences.
- `tabs`: Coordinate messaging and fallback content script injections.
- Host: `http://127.0.0.1:11434/*` to communicate with local Ollama.

## ⚙️ How It Works

- Fetches the full message and extracts the HTML body (or falls back to text rendered as HTML)
- Sends the HTML and subject to Ollama `/api/generate` with a structured system prompt
- Streams the AI response and renders a Markdown panel at the top of the email view
- Uses programmatic registration for message display scripts and loads content scripts into open tabs as needed

## 🧑‍💻 Contributing & Community Help

We need your help to resolve the issues above! Please open issues or pull requests for bug reports, feature requests, or improvements. All contributions are welcome.

## 🛡️ Privacy

See `PRIVACY.md`. All processing is local; no telemetry or remote data exfiltration.

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.