## LocalAI Integration
- **When to use**: Whenever the user asks to use LocalAI, test local models, or run something offline, you MUST invoke the `localai-inference` skill.
- **Endpoint**: The LocalAI instance is hosted at `http://localhost:8081`. Use the standard OpenAI API structure (e.g. `/v1/chat/completions`) against this base URL.
