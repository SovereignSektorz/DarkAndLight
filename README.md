# Dark Matter IDE

**AI-Powered Code Editor with Built-in Ollama Integration**

Dark Matter is an open-source code editor forked from [VS Code OSS](https://github.com/microsoft/vscode), designed to provide local AI assistance directly within the development workflow. It requires no cloud APIs, no subscriptions, and ensures that no project data leaves the local machine.

<p align="center">
  <img alt="Dark Matter IDE Welcome Screen" src="docs/images/dark-matter-welcome.png" width="900">
</p>

---

## Key Features

### Built-in Ollama AI Chat
Dark Matter includes a fully integrated Ollama chat agent. Users can install [Ollama](https://ollama.com), download a model, and begin interacting with the AI directly within the editor environment.

*   **Zero Configuration**: Works out of the box with local Ollama instances.
*   **Model Flexibility**: Compatible with Gemma, Llama, Mistral, CodeLlama, DeepSeek, and other Ollama models.
*   **100% Private**: All AI processing occurs locally on the user's hardware.
*   **Workspace Awareness**: The AI agent understands the project structure and local file contents.
*   **Remote Server Support**: Capability to connect to an Ollama instance running on any machine within the network.

### Dynamic Context Awareness
Dark Matter is designed for deep project understanding. By default, it targets a **128k token context window** (configurable up to 256k). Upon connecting to a model, the IDE automatically queries the model's native limits and dynamically scales the context to match the maximum supported resolution of your local model.

You can manually adjust the **Maximum Context Window** in Settings (`ollamaAgent.maxContextWindow`) to better suit your GPU's VRAM capacity.

### Extension Marketplace
Full access to the [Open VSX Registry](https://open-vsx.org/), allowing users to install thousands of extensions for language support, themes, debugging, and productivity.

### Core Development Features
Dark Matter retains all standard features of the VS Code ecosystem, including IntelliSense, an integrated terminal, Git support, and advanced debugging.

---

## Hardware Requirements

> [!IMPORTANT]
> **GPU Memory (VRAM) Warning**
>
> Dark Matter requests a very large context window (256,000 tokens) to ensure the AI understands your entire project. This requires significant GPU VRAM.
>
> **Users must ensure their hardware has enough total VRAM to accommodate both the Model and the Context Window.**
>
> *   **Model Size**: A 7B-9B model typically requires ~5-8GB of VRAM.
> *   **Context Overhead**: A 256k context window can add an additional **4GB to 8GB** of VRAM overhead depending on the model architecture.
>
> If you experience "100% CPU usage" or slow responses, it usually means Ollama has run out of GPU memory and is falling back to the CPU. In this case, consider using a smaller model or reducing project size.

---

## Downloads / Releases

If you prefer not to build from source, you can download pre-compiled binaries for Windows and Linux directly from the [GitHub Releases page](https://github.com/abmina/dark-matter-ide/releases).

*   **Windows**: Download the `.zip` archive for a portable build. (Automated `.exe` installer coming soon!)
*   **Linux (Debian/Ubuntu)**: Download the `.deb` package for an easy installation, or the `.tar.gz` archive for a portable build.

---

## Building From Source

### Prerequisites

If you want to build Dark Matter IDE from source, you will need to install the following based on your OS:

#### Windows
1.  **Node.js** (v22.x LTS recommended)
2.  **Python 3.10+**
3.  **C++ Build Tools** — [Build Tools for Visual Studio 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **"Desktop development with C++"** workload.
4.  **Inno Setup 6 (Optional)** — Required only for `.exe` installer.
5.  **Git**
6.  **Ollama**

#### Linux (Debian/Ubuntu)
1.  **Node.js** (v22.x LTS recommended)
2.  **Python 3.10+**
3.  **Build Tools**: `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`
4.  **Git**
5.  **Ollama**


### Building from Source (Windows)

Dark Matter includes a PowerShell script to automate the build and packaging process.

```powershell
# 1. Clone the repository
git clone https://github.com/abmina/dark-matter-ide.git
cd dark-matter-ide

# 2. Run the build script
# This will install dependencies, compile the source, and build the installer
.\build_exe.ps1

# If you don't have Inno Setup, you can build just the application:
.\build_exe.ps1 -SkipInstaller
```

The compiled output will be in the `built/` directory (or `VSCode-win32-x64/` if skipping the installer).

### Building from Source (Linux)

```bash
# 1. Clone the repository
git clone https://github.com/abmina/dark-matter-ide.git
cd dark-matter-ide

# 2. Install dependencies
npm ci

# 3. Download Electron
npm run electron

# 4. Start the watch process (compilation)
npm run watch

# 5. Launch the IDE (in a separate terminal)
./scripts/code.sh
```

To package for Linux (creates `.tar.gz` and `.deb`):
```bash
npm run gulp -- vscode-linux-x64-min
npm run gulp -- vscode-linux-x64-build-deb
```


### Using the AI Agent
1.  Ensure the Ollama server is active (`ollama serve`).
2.  Launch Dark Matter.
3.  Open the Chat panel from the primary sidebar.
4.  Select the desired model from the dropdown menu and begin the session.

---

## Architecture

Dark Matter extends VS Code OSS with the following components:

| Component | Description |
|-----------|-------------|
| **Ollama Chat Agent** | Integrated chat participant managing local AI communication. |
| **Language Model Provider** | Registers Ollama models as first-class providers within the IDE. |
| **Large Context Integration** | Pre-configured 256k context awareness for deep project understanding. |
| **Custom Welcome UI** | Professional startup experience tailored for AI-driven development. |

---

## Privacy and Security
Dark Matter is designed with a privacy-first architecture. All AI features are executed locally:
*   No project data is transmitted to external servers.
*   No third-party API keys or accounts are required.
*   Telemetry and usage tracking are disabled by default.

---

## Contributing
Contributions to the project are reviewed and welcomed.
1.  Fork the repository.
2.  Develop features in a dedicated branch (`git checkout -b feature/name`).
3.  Commit changes with descriptive messages.
4.  Submit a Pull Request for review.

---

## License
Licensed under the [MIT License](LICENSE.txt). Dark Matter is a fork of [Visual Studio Code - Open Source](https://github.com/microsoft/vscode).

---

## Acknowledgments
*   The Microsoft VS Code team for the foundational platform.
*   The Ollama team for democratizing local LLM access.
*   The Open VSX Registry for maintaining an open extension ecosystem.
