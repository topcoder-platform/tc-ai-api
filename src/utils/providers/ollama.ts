import { createOllama } from 'ai-sdk-ollama';

export const ollama = createOllama({
  baseURL: process.env.OLLAMA_API_URL || 'http://ollama.topcoder-dev.com:11434',
});
