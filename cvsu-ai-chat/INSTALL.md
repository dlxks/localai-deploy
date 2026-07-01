# Installing CvSUAI

This extension allows you to connect a Copilot-style AI assistant directly to your own LocalAI server. 

## Compatibility

- Works in VS Code and most VS Code-derived IDEs that support VSIX extensions.
- Includes Antigravity IDE and similar forks, as long as they keep VS Code extension APIs.
- Most reliable install path across IDEs is "Install from VSIX" from the Extensions UI.

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
   - **IDE UI (recommended):** Extensions panel → `…` (top-right) → **Install from VSIX…** → select the generated file.
   - **or CLI:** `code --install-extension localai-vscode-chat-<version>.vsix` (CLI name may differ by IDE)
5. Reload your IDE.

## Configuration

Once installed, the extension connects to `http://localhost:8081` by default.

To customize your setup, open your IDE Command Palette (`Ctrl+Shift+P`), type **Preferences: Open Settings (UI)**, and search for `localai`.

Here you can change:
- **`localai.baseUrl`**: The URL where your LocalAI instance is hosted.
- **`localai.model`**: The default model used for chat inferences (e.g. `gpt-3.5-turbo`).

You are now ready to use the extension! Simply click the LocalAI icon in the activity bar to start chatting.
