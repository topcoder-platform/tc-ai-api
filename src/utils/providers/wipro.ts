import { createWipro } from "@topcoder/wipro-ai-sdk-provider";

// Create provider with custom auth headers
export const wipro = createWipro({
    headers: { "x-api-key": process.env.WIPRO_API_KEY! },
    chatSettings: {
        // Keep sampling deterministic to reduce malformed/shape-drifted JSON.
        temperature: 0,
        topP: 0.1,
        topK: 20,

        maxOutputTokens: 8192,

        // Avoid repetition penalties that can destabilize strict JSON output.
        frequencyPenalty: 0,
        presencePenalty: 0,

        // Default JSON mode for non-structured calls.
        // Structured calls can still override this when needed.
        responseFormat: 'json_object',
    }
});
