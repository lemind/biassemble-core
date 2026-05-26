import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";
import type { Provider, CompletionRequest } from "./types.js";

/** Default temperature for AI provider calls */
const DEFAULT_TEMPERATURE = 0.7;

const MODULE = "gemini-provider";

export class GeminiProvider implements Provider {
  readonly mode = "gemini";
  private client: GoogleGenerativeAI;

  constructor() {
    this.client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }

  async completeJson<T>(request: CompletionRequest): Promise<T> {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;

    const model = this.client.getGenerativeModel(
      {
        model: env.GEMINI_MODEL,
        generationConfig: {
          temperature: request.options?.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: request.options?.maxTokens,
          responseMimeType: "application/json",
        },
      },
      { timeout: timeoutMs }
    );

    const contents = [
      {
        role: "user",
        parts: [{ text: `SYSTEM: ${request.system}\n\nUSER: ${request.user}` }],
      },
    ];

    try {
      const result = await model.generateContent({ contents });
      const response = await result.response;
      const text = response.text();

      try {
        return JSON.parse(text) as T;
      } catch (parseError) {
        logger.error(
          { module: MODULE, operation: "completeJson", text, parseError },
          "Failed to parse Gemini JSON output"
        );
        throw new Error("Malformed JSON from AI provider");
      }
    } catch (error) {
      logger.error(
        { module: MODULE, operation: "completeJson", error },
        "Gemini API call failed"
      );
      throw error;
    }
  }
}
