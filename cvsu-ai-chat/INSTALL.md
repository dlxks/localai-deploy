# Installing CvSU-AI VSCode Chat

This extension allows you to connect a Copilot-style AI assistant directly to your own LocalAI server. 

## Build & Install

1. Clone this repository to your local machine.
2. Open a terminal in the project directory and install dependencies:
   ```bash
   npm install
   ```
3. Package the extension into a `.vsix` file:
   ```bash
   npm run package
   ```
4. Install the generated `.vsix` file:
   - **VS Code UI:** Extensions panel → `…` (top-right) → **Install from VSIX…** → select the generated file.
   - **or CLI:** `code --install-extension localai-vscode-chat-<version>.vsix`
5. Reload VS Code.

## Configuration

Once installed, the extension connects to `http://localhost:8081` by default.

To customize your setup, open the VS Code Command Palette (`Ctrl+Shift+P`), type **Preferences: Open Settings (UI)**, and search for `localai`.

Here you can change:
- **`localai.baseUrl`**: The URL where your LocalAI instance is hosted.
- **`localai.model`**: The default model used for chat inferences (e.g. `gpt-3.5-turbo`).

You are now ready to use the extension! Simply click the LocalAI icon in the activity bar to start chatting.
