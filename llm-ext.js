class ChatExtension {
    constructor() {
        // Change this to your backend or your tunnel endpoint
        this.apiBaseUrl = 'https://port9593.octopus-tech.com';

        this.token = null;
        this.currentChain = {};

        // A temporary buffer for partial SSE lines
        this.sseBuffer = '';
    }

    getInfo() {
        return {
            id: 'chatExtension',
            name: 'LLM Streaming (UTF-8 Example)',
            blocks: [
                {
                    opcode: 'login',
                    blockType: Scratch.BlockType.COMMAND,
                    text: 'Login with username [USERNAME] and password [PASSWORD]',
                    arguments: {
                        USERNAME: { type: Scratch.ArgumentType.STRING, defaultValue: 'user' },
                        PASSWORD: { type: Scratch.ArgumentType.STRING, defaultValue: 'password' }
                    }
                },
                {
                    opcode: 'startChain',
                    blockType: Scratch.BlockType.COMMAND,
                    text: 'Start new message chain with ID [CHAIN_ID]',
                    arguments: {
                        CHAIN_ID: { type: Scratch.ArgumentType.STRING, defaultValue: 'default' }
                    }
                },
                {
                    opcode: 'addMessage',
                    blockType: Scratch.BlockType.COMMAND,
                    text: 'Add [ROLE] message [MESSAGE] to chain [CHAIN_ID]',
                    arguments: {
                        ROLE: {
                            type: Scratch.ArgumentType.STRING,
                            menu: 'rolesMenu',
                            defaultValue: 'user'
                        },
                        MESSAGE: { type: Scratch.ArgumentType.STRING, defaultValue: '你好，我是学生。' },
                        CHAIN_ID: { type: Scratch.ArgumentType.STRING, defaultValue: 'default' }
                    }
                },
                {
                    opcode: 'sendMessageStream',
                    blockType: Scratch.BlockType.REPORTER,
                    text: 'Send message chain [CHAIN_ID] and stream response',
                    arguments: {
                        CHAIN_ID: { type: Scratch.ArgumentType.STRING, defaultValue: 'default' }
                    }
                },
                {
                    opcode: 'checkQuota',
                    blockType: Scratch.BlockType.REPORTER,
                    text: 'Check remaining quota'
                }
            ],
            menus: {
                rolesMenu: {
                    acceptReporters: false,
                    items: ['user', 'system', 'assistant']
                }
            }
        };
    }

    /**
     * Attempt to log in and acquire JWT token
     */
    async login(args) {
        const { USERNAME, PASSWORD } = args;
        try {
            const response = await fetch(`${this.apiBaseUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ username: USERNAME, password: PASSWORD })
            });
            const data = await response.json();

            if (data.status === 'success') {
                this.token = data.token;
                return 'Login successful';
            } else {
                return `Login failed: ${data.message}`;
            }
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Start a new chain in memory
     */
    startChain(args) {
        const { CHAIN_ID } = args;
        this.currentChain[CHAIN_ID] = [];
        return `Started new chain: ${CHAIN_ID}`;
    }

    /**
     * Add a message (role + content) to a specific chain
     */
    addMessage(args) {
        const { ROLE, MESSAGE, CHAIN_ID } = args;

        if (!this.currentChain[CHAIN_ID]) {
            return `Error: Chain ${CHAIN_ID} not found. Start the chain first.`;
        }

        this.currentChain[CHAIN_ID].push({ role: ROLE, content: MESSAGE });
        return `Added ${ROLE} message to chain ${CHAIN_ID}`;
    }

    /**
     * Send the chain to the backend, stream the response, and return the combined output
     */
    async sendMessageStream(args) {
        const { CHAIN_ID } = args;
        if (!this.token) {
            return 'Error: Not logged in';
        }

        if (!this.currentChain[CHAIN_ID]) {
            return `Error: Chain ${CHAIN_ID} not found`;
        }

        // Clear any leftover buffer from previous streaming
        this.sseBuffer = '';

        try {
            const response = await fetch(`${this.apiBaseUrl}/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    messages: this.currentChain[CHAIN_ID],
                    conversation_id: CHAIN_ID
                })
            });

            if (!response.ok) {
                return `Error: Failed to send message chain (HTTP ${response.status})`;
            }

            // We will read the body as a stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let finalResult = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Decode chunk as UTF-8 (allow partial multi-byte).
                const chunk = decoder.decode(value, { stream: true });
                // Accumulate the chunk in a buffer for line-by-line parsing
                this.sseBuffer += chunk;

                // Split on newline
                const lines = this.sseBuffer.split('\n');

                // The last item may be incomplete. Keep it in the buffer.
                this.sseBuffer = lines.pop();

                for (const line of lines) {
                    // SSE lines typically start with "data: "
                    if (!line.startsWith('data: ')) {
                        continue;
                    }

                    const contentStr = line.slice(6).trim();  // remove "data: "
                    if (contentStr === '[DONE]') {
                        // End of SSE stream
                        break;
                    }

                    // Try to parse the line as JSON
                    try {
                        const parsed = JSON.parse(contentStr);
                        // If it's the new ChatCompletion format: delta content
                        const partialContent = parsed?.choices?.[0]?.delta?.content || '';
                        finalResult += partialContent;
                        // You can do incremental logging here if desired:
                        // console.log('Stream chunk:', partialContent);
                    } catch (e) {
                        // If JSON.parse fails, the line might be incomplete
                        // so we’ll let the leftover remain in sseBuffer.
                        // console.error('JSON parse error on line:', line, e);
                    }
                }
            }

            // Optionally, you can clear the chain after sending
            // this.currentChain[CHAIN_ID] = [];

            return finalResult;
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Check remaining quota
     */
    async checkQuota() {
        if (!this.token) {
            return 'Error: Not logged in';
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/quota`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await response.json();

            if (data.status === 'success') {
                return String(data.quota);
            } else {
                return data.message || 'Error fetching quota';
            }
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }
}

// Make sure this file is saved in UTF-8 encoding
Scratch.extensions.register(new ChatExtension());
